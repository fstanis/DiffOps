import type { DiffCommentThread, FileExplanation, Narration } from '../types/diff';
import { mergeCommentThreads } from '../utils/commentImports';

import { broadcastBridgeEvent } from './bridgeEvents';
import type { RepositoryEngine } from './gitEngine/gitEngine';
import type { WalkedFile } from './gitEngine/walkDirectory';
import {
  buildCommentSessionKey,
  buildFileExplanationKey,
  getStandaloneStore,
  type StandaloneStore,
  type StoredFileExplanation,
  type StoredHiddenFiles,
  type StoredNarration,
} from './persistence/standaloneStore';
import {
  loadStandaloneClientSettings,
  saveStandaloneClientSettings,
} from './persistence/settingsStore';

interface CommentSessionState {
  threads: DiffCommentThread[];
  version: number;
}

/** A repository whose git engine serves the repo-backed endpoints. */
interface ActiveRepository {
  engine: RepositoryEngine;
  repositoryId: string;
  repoName: string;
}

/** Handle on an installed local API bridge: feeds it data and uninstalls it. */
export interface LocalApiBridge {
  setRepository: (repository: ActiveRepository) => void;
  /** Re-mounts freshly walked files, tells the viewer to refetch; resolves to mount warnings. */
  refreshRepository: (files: WalkedFile[]) => Promise<string[]>;
  restore: () => void;
}

export interface LocalApiBridgeOptions {
  /** Storage override for tests; defaults to the app-wide standalone store. */
  store?: StandaloneStore;
}

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

// Mirrors the server's /api/blob content types; anything else is octet-stream.
const BLOB_CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
};

const blobContentType = (path: string): string => {
  const extension = path.includes('.') ? (path.split('.').pop() ?? '') : '';
  return BLOB_CONTENT_TYPES_BY_EXTENSION[extension] ?? 'application/octet-stream';
};

const extractUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof URL) {
    return input;
  }
  if (input instanceof Request) {
    return new URL(input.url, window.location.origin);
  }
  return new URL(String(input), window.location.origin);
};

const parseThreadsPayload = (init: RequestInit | undefined): unknown => {
  const body = init?.body;
  if (typeof body === 'string') {
    return JSON.parse(body) as unknown;
  }
  return body ?? {};
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Installs the app's backend: intercepts the viewer's /api/* fetch traffic and
 * serves it from the wasm-git-backed repository, persisting comments per
 * selection in IndexedDB and settings in localStorage.
 */
export const installLocalApiBridge = (options: LocalApiBridgeOptions = {}): LocalApiBridge => {
  const originalFetch = window.fetch.bind(window);
  const originalSendBeacon = navigator.sendBeacon?.bind(navigator);

  const store = options.store ?? getStandaloneStore();
  let current: ActiveRepository | null = null;
  const sessions = new Map<string, CommentSessionState>();

  const commentSessionKey = (requestUrl: URL): string =>
    buildCommentSessionKey(
      current?.repositoryId ?? 'default',
      requestUrl.searchParams.get('base') ?? '',
      requestUrl.searchParams.get('target') ?? '',
      requestUrl.searchParams.get('baseMode') ?? '',
    );

  const loadSession = async (key: string): Promise<CommentSessionState> => {
    const cached = sessions.get(key);
    if (cached) {
      return cached;
    }

    let session: CommentSessionState = { threads: [], version: 0 };
    try {
      const persisted = await store.loadCommentSession(key);
      if (persisted) {
        session = { threads: persisted.threads, version: persisted.version };
      }
    } catch (error) {
      console.warn('diffops: failed to load persisted comments:', error);
    }

    sessions.set(key, session);
    return session;
  };

  const persistSession = async (key: string, session: CommentSessionState): Promise<void> => {
    sessions.set(key, session);
    try {
      await store.saveCommentSession(key, session.threads, session.version);
    } catch (error) {
      // Persistence is best-effort; the in-memory session keeps working.
      console.warn('diffops: failed to persist comments:', error);
    }
  };

  const handleCommentsPost = async (
    init: RequestInit | undefined,
    key: string,
  ): Promise<Response> => {
    let payload: { threads?: unknown; baseVersion?: unknown };
    try {
      payload = parseThreadsPayload(init) as { threads?: unknown; baseVersion?: unknown };
    } catch {
      return jsonResponse({ error: 'Invalid comment data' }, 400);
    }

    if (!Array.isArray(payload.threads)) {
      return jsonResponse({ error: 'Invalid comment data' }, 400);
    }

    const session = await loadSession(key);
    const nextThreads = payload.threads as DiffCommentThread[];
    const baseVersion = payload.baseVersion;
    // A stale baseVersion means another writer changed comments; merge rather than overwrite (server parity).
    const isStale = typeof baseVersion === 'number' && baseVersion !== session.version;
    const resolvedThreads = isStale
      ? mergeCommentThreads(session.threads, nextThreads)
      : nextThreads;

    const nextSession: CommentSessionState = {
      threads: resolvedThreads,
      version:
        JSON.stringify(session.threads) === JSON.stringify(resolvedThreads)
          ? session.version
          : session.version + 1,
    };
    if (nextSession.version !== session.version) {
      await persistSession(key, nextSession);
    } else {
      sessions.set(key, nextSession);
    }

    return jsonResponse({
      success: true,
      merged: isStale,
      version: nextSession.version,
      threads: nextSession.threads,
    });
  };

  const handleUserSettingsPut = (init: RequestInit | undefined): Response => {
    let patch: Record<string, unknown> | null = null;
    try {
      const payload = parseThreadsPayload(init);
      if (isPlainObject(payload) && isPlainObject(payload.client)) {
        patch = payload.client;
      }
    } catch {
      patch = null;
    }

    if (!patch) {
      return jsonResponse({ error: 'Invalid user settings payload' }, 400);
    }

    const client = saveStandaloneClientSettings(patch);
    return jsonResponse({ version: 1, client });
  };

  const handleNarrationGet = async (key: string): Promise<Response> => {
    let stored: StoredNarration | undefined;
    try {
      stored = await store.loadNarration(key);
    } catch (error) {
      console.warn('diffops: failed to load persisted narration:', error);
    }
    return jsonResponse({ narration: stored ?? null });
  };

  const handleNarrationPut = async (
    init: RequestInit | undefined,
    key: string,
  ): Promise<Response> => {
    let payload: { narration?: unknown; fingerprint?: unknown } | null = null;
    try {
      const parsed = parseThreadsPayload(init);
      if (isPlainObject(parsed)) {
        payload = parsed as { narration?: unknown; fingerprint?: unknown };
      }
    } catch {
      payload = null;
    }

    const narration = isPlainObject(payload?.narration) ? payload.narration : null;
    const fingerprint = payload?.fingerprint;
    const isValidPayload =
      narration !== null &&
      typeof narration.intro === 'string' &&
      typeof narration.epilogue === 'string' &&
      Array.isArray(narration.cards) &&
      typeof fingerprint === 'string' &&
      fingerprint.length > 0;
    if (!isValidPayload) {
      return jsonResponse({ error: 'Invalid narration payload' }, 400);
    }

    try {
      await store.saveNarration(key, narration as unknown as Narration, fingerprint);
    } catch (error) {
      console.warn('diffops: failed to persist narration:', error);
      return jsonResponse({ error: 'Failed to persist narration' }, 500);
    }
    return jsonResponse({ success: true });
  };

  const handleHiddenFilesGet = async (key: string): Promise<Response> => {
    let stored: StoredHiddenFiles | undefined;
    try {
      stored = await store.loadHiddenFiles(key);
    } catch (error) {
      console.warn('diffops: failed to load hidden files:', error);
    }
    return jsonResponse({ paths: stored?.paths ?? [] });
  };

  const handleHiddenFilesPut = async (
    init: RequestInit | undefined,
    key: string,
  ): Promise<Response> => {
    let paths: string[] | null = null;
    try {
      const parsed = parseThreadsPayload(init);
      if (
        isPlainObject(parsed) &&
        Array.isArray(parsed.paths) &&
        parsed.paths.every((path) => typeof path === 'string')
      ) {
        paths = parsed.paths as string[];
      }
    } catch {
      paths = null;
    }

    if (!paths) {
      return jsonResponse({ error: 'Invalid hidden files payload' }, 400);
    }

    try {
      await store.saveHiddenFiles(key, paths);
    } catch (error) {
      console.warn('diffops: failed to persist hidden files:', error);
      return jsonResponse({ error: 'Failed to persist hidden files' }, 500);
    }
    return jsonResponse({ success: true, paths });
  };

  const isFileExplanationShape = (value: unknown): value is FileExplanation =>
    isPlainObject(value) &&
    typeof value.fileSummary === 'string' &&
    Array.isArray(value.symbols) &&
    Array.isArray(value.additionalFilesNeeded) &&
    value.additionalFilesNeeded.every((path) => typeof path === 'string');

  const handleExplanationGet = async (requestUrl: URL): Promise<Response> => {
    const path = requestUrl.searchParams.get('path');
    if (!path) {
      return jsonResponse({ error: 'Missing file path' }, 400);
    }

    let stored: StoredFileExplanation | undefined;
    try {
      stored = await store.loadFileExplanation(
        buildFileExplanationKey(commentSessionKey(requestUrl), path),
      );
    } catch (error) {
      console.warn('diffops: failed to load persisted file explanation:', error);
    }
    return jsonResponse({ explanation: stored ?? null });
  };

  const handleExplanationPut = async (
    init: RequestInit | undefined,
    requestUrl: URL,
  ): Promise<Response> => {
    const path = requestUrl.searchParams.get('path');
    if (!path) {
      return jsonResponse({ error: 'Missing file path' }, 400);
    }

    let payload: {
      explanation?: unknown;
      includedSupportingFiles?: unknown;
      fingerprint?: unknown;
    } | null = null;
    try {
      const parsed = parseThreadsPayload(init);
      if (isPlainObject(parsed)) {
        payload = parsed as {
          explanation?: unknown;
          includedSupportingFiles?: unknown;
          fingerprint?: unknown;
        };
      }
    } catch {
      payload = null;
    }

    const explanation = payload?.explanation;
    const includedSupportingFiles = payload?.includedSupportingFiles;
    const fingerprint = payload?.fingerprint;
    const isValidPayload =
      isFileExplanationShape(explanation) &&
      Array.isArray(includedSupportingFiles) &&
      includedSupportingFiles.every((filePath) => typeof filePath === 'string') &&
      typeof fingerprint === 'string' &&
      fingerprint.length > 0;
    if (!isValidPayload) {
      return jsonResponse({ error: 'Invalid file explanation payload' }, 400);
    }

    try {
      await store.saveFileExplanation(
        buildFileExplanationKey(commentSessionKey(requestUrl), path),
        explanation,
        includedSupportingFiles as string[],
        fingerprint,
      );
    } catch (error) {
      console.warn('diffops: failed to persist file explanation:', error);
      return jsonResponse({ error: 'Failed to persist file explanation' }, 500);
    }
    return jsonResponse({ success: true });
  };

  const handleRepoDiff = async (
    repository: ActiveRepository,
    requestUrl: URL,
  ): Promise<Response> => {
    try {
      const diff = await repository.engine.diff(
        {
          base: requestUrl.searchParams.get('base') ?? undefined,
          target: requestUrl.searchParams.get('target') ?? undefined,
          baseMode: requestUrl.searchParams.get('baseMode') ?? undefined,
        },
        requestUrl.searchParams.get('ignoreWhitespace') === 'true',
      );
      return jsonResponse({
        ...diff,
        ignoreWhitespace: requestUrl.searchParams.get('ignoreWhitespace') === 'true',
        repositoryId: repository.repositoryId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to compute diff';
      console.error(
        `[diffops] diff failed for base=${requestUrl.searchParams.get('base') ?? '(default)'} target=${requestUrl.searchParams.get('target') ?? '(default)'}: ${message}`,
      );
      return jsonResponse({ error: message }, 500);
    }
  };

  const handleRepoBlob = async (
    repository: ActiveRepository,
    pathname: string,
    requestUrl: URL,
  ): Promise<Response> => {
    const path = decodeURIComponent(pathname.replace(/^\/api\/blob\//, ''));
    const ref = requestUrl.searchParams.get('ref') || 'HEAD';
    try {
      const blob = await repository.engine.blob(path, ref);
      const headers = {
        'Content-Type': blobContentType(path),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      };
      // The bytes view may be typed over a shared buffer Response rejects.
      return blob.kind === 'text'
        ? new Response(blob.text, { status: 200, headers })
        : new Response(new Uint8Array(blob.bytes), { status: 200, headers });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'File not found' },
        404,
      );
    }
  };

  const handleRepoLineCount = async (
    repository: ActiveRepository,
    pathname: string,
    requestUrl: URL,
  ): Promise<Response> => {
    const path = decodeURIComponent(pathname.replace(/^\/api\/line-count\//, ''));
    const oldRef = requestUrl.searchParams.get('oldRef');
    const newRef = requestUrl.searchParams.get('newRef');
    const payload: { oldLineCount?: number; newLineCount?: number } = {};
    if (oldRef) {
      const oldPath = requestUrl.searchParams.get('oldPath') || path;
      payload.oldLineCount = await repository.engine.lineCount(oldPath, oldRef);
    }
    if (newRef) {
      payload.newLineCount = await repository.engine.lineCount(path, newRef);
    }
    return jsonResponse(payload);
  };

  const handleRepoGeneratedStatus = async (
    repository: ActiveRepository,
    pathname: string,
    requestUrl: URL,
  ): Promise<Response> => {
    const path = decodeURIComponent(pathname.replace(/^\/api\/generated-status\//, ''));
    const ref =
      requestUrl.searchParams.get('ref') ||
      repository.engine.currentSelection.targetCommitish ||
      'HEAD';
    try {
      return jsonResponse(await repository.engine.generatedStatus(path, ref));
    } catch {
      return jsonResponse({ error: 'Failed to get generated status' }, 500);
    }
  };

  const noRepositoryResponse = (): Response =>
    jsonResponse({ error: 'No repository is open in this window' }, 404);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = extractUrl(input);
    const repository = current;

    if (requestUrl.pathname === '/api/diff') {
      if (!repository) {
        return noRepositoryResponse();
      }
      return handleRepoDiff(repository, requestUrl);
    }

    if (requestUrl.pathname === '/api/revisions') {
      if (!repository) {
        return noRepositoryResponse();
      }
      return jsonResponse(await repository.engine.revisions());
    }

    if (requestUrl.pathname.startsWith('/api/line-count/')) {
      if (!repository) {
        return noRepositoryResponse();
      }
      return handleRepoLineCount(repository, requestUrl.pathname, requestUrl);
    }

    if (requestUrl.pathname.startsWith('/api/blob/')) {
      if (!repository) {
        return noRepositoryResponse();
      }
      return handleRepoBlob(repository, requestUrl.pathname, requestUrl);
    }

    if (requestUrl.pathname.startsWith('/api/generated-status/')) {
      if (!repository) {
        return noRepositoryResponse();
      }
      return handleRepoGeneratedStatus(repository, requestUrl.pathname, requestUrl);
    }

    if (requestUrl.pathname === '/api/comments' && init?.method !== 'GET') {
      return handleCommentsPost(init, commentSessionKey(requestUrl));
    }
    const commentThreadMatch = requestUrl.pathname.match(/^\/api\/comments\/([^/]+)$/);
    if (commentThreadMatch && init?.method === 'DELETE') {
      const threadId = decodeURIComponent(commentThreadMatch[1] ?? '');
      const key = commentSessionKey(requestUrl);
      const session = await loadSession(key);
      const nextThreads = session.threads.filter((thread) => thread.id !== threadId);

      if (nextThreads.length === session.threads.length) {
        return jsonResponse({ error: `Thread not found: ${threadId}` }, 404);
      }

      const nextSession: CommentSessionState = {
        threads: nextThreads,
        version: session.version + 1,
      };
      await persistSession(key, nextSession);

      return jsonResponse({
        success: true,
        threadId,
        version: nextSession.version,
      });
    }

    if (requestUrl.pathname === '/api/comments-json') {
      const session = await loadSession(commentSessionKey(requestUrl));
      return jsonResponse({
        version: session.version,
        threads: session.threads,
      });
    }

    if (requestUrl.pathname === '/api/narration') {
      const key = commentSessionKey(requestUrl);
      if (init?.method === 'PUT' || init?.method === 'POST') {
        return handleNarrationPut(init, key);
      }
      return handleNarrationGet(key);
    }

    // Hidden files are a per-repository preference, so they outlive the selection comments are keyed by.
    if (requestUrl.pathname === '/api/hidden-files') {
      const key = current?.repositoryId ?? 'default';
      if (init?.method === 'PUT' || init?.method === 'POST') {
        return handleHiddenFilesPut(init, key);
      }
      return handleHiddenFilesGet(key);
    }

    if (requestUrl.pathname === '/api/explanation') {
      if (init?.method === 'PUT' || init?.method === 'POST') {
        return handleExplanationPut(init, requestUrl);
      }
      return handleExplanationGet(requestUrl);
    }

    if (requestUrl.pathname === '/api/user-settings') {
      if (init?.method === 'PUT') {
        return handleUserSettingsPut(init);
      }
      return jsonResponse({ version: 1, client: loadStandaloneClientSettings() });
    }

    return originalFetch(input, init);
  }) as typeof window.fetch;

  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: ((url: string | URL, data?: BodyInit | null) => {
      const target = typeof url === 'string' ? url : url.toString();
      if (target.startsWith('/api/comments')) {
        return true;
      }
      if (originalSendBeacon) {
        return originalSendBeacon(url, data);
      }
      return true;
    }) as Navigator['sendBeacon'],
  });

  return {
    setRepository: (repository: ActiveRepository) => {
      current = repository;
    },
    refreshRepository: async (files: WalkedFile[]): Promise<string[]> => {
      if (!current) {
        return [];
      }
      const warnings = await current.engine.refresh(files);
      await broadcastBridgeEvent({ type: 'reload' });
      return warnings;
    },
    restore: () => {
      window.fetch = originalFetch;
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        writable: true,
        value: originalSendBeacon,
      });
    },
  };
};
