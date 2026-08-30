import type { DiffCommentThread, DiffResponse, FileExplanation, Narration } from '../types/diff';
import {
  mergeCommentImports,
  mergeCommentThreads,
  normalizeCommentImports,
} from '../utils/commentImports';

import { broadcastBridgeEvent } from './bridgeEvents';
import type { StandaloneDiffSource } from './diffFile';
import type { RepositoryEngine } from './gitEngine/gitEngine';
import type { WalkedFile } from './gitEngine/walkDirectory';
import {
  buildCommentSessionKey,
  buildFileExplanationKey,
  getStandaloneStore,
  type StandaloneStore,
  type StoredFileExplanation,
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

interface DiffFileModeWindow {
  __DIFFOPS_DIFF_FILE_MODE__?: boolean;
}

/** A repository whose git engine serves the repo-backed endpoints. */
interface ActiveRepository {
  engine: RepositoryEngine;
  repositoryId: string;
  repoName: string;
}

type ActiveSource =
  | { kind: 'diff'; source: StandaloneDiffSource }
  | { kind: 'repo'; repository: ActiveRepository };

/** Handle on an installed local API bridge: feeds it data and uninstalls it. */
export interface LocalApiBridge {
  setDiff: (source: StandaloneDiffSource) => void;
  setRepository: (repository: ActiveRepository) => void;
  clearActiveSource: () => void;
  /** Re-mounts freshly walked files, tells the viewer to refetch; resolves to mount warnings. */
  refreshRepository: (files: WalkedFile[]) => Promise<string[]>;
  /** The comment-session query string for the active selection (export/import). */
  getCommentQuery: () => string;
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

// Deterministic per-payload hash for import ids; doesn't need to be cryptographically strong.
const hashPayload = (payload: string): string => {
  let hash = 5381;
  for (let index = 0; index < payload.length; index += 1) {
    hash = ((hash << 5) + hash + payload.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * Installs the app's backend: intercepts the viewer's /api/* fetch traffic
 * and serves either an opened diff file or a wasm-git-backed repository,
 * persisting comments per diff in IndexedDB and settings in localStorage.
 */
export const installLocalApiBridge = (options: LocalApiBridgeOptions = {}): LocalApiBridge => {
  const originalFetch = window.fetch.bind(window);
  const originalSendBeacon = navigator.sendBeacon?.bind(navigator);
  const diffFileModeWindow = window as Window & DiffFileModeWindow;
  const wasDiffFileMode = diffFileModeWindow.__DIFFOPS_DIFF_FILE_MODE__;

  const store = options.store ?? getStandaloneStore();
  let current: ActiveSource | null = null;
  let lastCommentQuery: string | null = null;
  const sessions = new Map<string, CommentSessionState>();

  // Tells the viewer the active source has no repository, disabling affordances that need blob or repository endpoints.
  const setDiffFileMode = (isDiffFileMode: boolean): void => {
    diffFileModeWindow.__DIFFOPS_DIFF_FILE_MODE__ = isDiffFileMode;
  };
  setDiffFileMode(true);

  const activeRepository = (): ActiveRepository | null =>
    current?.kind === 'repo' ? current.repository : null;

  // "stdin" pseudo-refs carry the CLI stdin mode's degraded semantics.
  const buildDiffPayload = (diff: DiffResponse, source: StandaloneDiffSource): DiffResponse => ({
    ...diff,
    baseCommitish: 'stdin',
    targetCommitish: 'stdin',
    requestedBaseCommitish: 'stdin',
    requestedTargetCommitish: 'stdin',
    repositoryId: source.repositoryId,
  });

  const activeRepositoryId = (): string =>
    current?.kind === 'repo'
      ? current.repository.repositoryId
      : current?.kind === 'diff'
        ? current.source.repositoryId
        : 'default';

  const commentSessionKey = (requestUrl: URL): string =>
    buildCommentSessionKey(
      activeRepositoryId(),
      requestUrl.searchParams.get('base') ?? 'stdin',
      requestUrl.searchParams.get('target') ?? 'stdin',
      requestUrl.searchParams.get('baseMode') ?? '',
    );

  const rememberCommentQuery = (requestUrl: URL): void => {
    const base = requestUrl.searchParams.get('base');
    const target = requestUrl.searchParams.get('target');
    if (base === null && target === null) {
      return;
    }
    const params = new URLSearchParams();
    if (base !== null) {
      params.set('base', base);
    }
    if (target !== null) {
      params.set('target', target);
    }
    if (requestUrl.searchParams.get('baseMode') === 'merge-base') {
      params.set('baseMode', 'merge-base');
    }
    lastCommentQuery = params.toString();
  };

  const defaultCommentQuery = (): string => {
    const repository = activeRepository();
    if (!repository) {
      return 'base=stdin&target=stdin';
    }
    const selection = repository.engine.currentSelection;
    const params = new URLSearchParams({
      base: selection.baseCommitish,
      target: selection.targetCommitish,
    });
    if (selection.baseMode === 'merge-base') {
      params.set('baseMode', 'merge-base');
    }
    return params.toString();
  };

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
      ? mergeCommentThreads(session.threads, nextThreads).threads
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

  // Accepts the CLI's CommentImport[] payload (server parity) and the app's own { threads } export, so an export round-trips into a fresh session.
  const handleCommentImportsPost = async (
    init: RequestInit | undefined,
    key: string,
  ): Promise<Response> => {
    let payload: unknown;
    try {
      payload = parseThreadsPayload(init);
    } catch {
      return jsonResponse({ error: 'Invalid comment import data' }, 400);
    }

    const session = await loadSession(key);
    let merged: { threads: DiffCommentThread[]; warnings: string[] };
    let count: number;
    let importId: string;

    if (isPlainObject(payload) && Array.isArray(payload.threads)) {
      const importedThreads = payload.threads as DiffCommentThread[];
      merged = mergeCommentThreads(session.threads, importedThreads);
      count = importedThreads.length;
      importId = hashPayload(JSON.stringify(importedThreads));
    } else {
      try {
        const commentImports = normalizeCommentImports(payload);
        merged = mergeCommentImports(session.threads, commentImports);
        count = commentImports.length;
        importId = hashPayload(JSON.stringify(payload));
      } catch {
        return jsonResponse({ error: 'Invalid comment import data' }, 400);
      }
    }

    const changed = JSON.stringify(session.threads) !== JSON.stringify(merged.threads);
    const nextSession: CommentSessionState = {
      threads: changed ? merged.threads : session.threads,
      version: changed ? session.version + 1 : session.version,
    };
    if (changed) {
      await persistSession(key, nextSession);
      broadcastBridgeEvent({ type: 'commentsChanged' });
    }

    return jsonResponse({
      success: true,
      changed,
      count,
      importId,
      warnings: merged.warnings,
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

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = extractUrl(input);
    const repository = activeRepository();

    if (requestUrl.pathname === '/api/diff') {
      if (!current) {
        return jsonResponse({ error: 'No diff file opened yet' }, 404);
      }
      if (current.kind === 'repo') {
        return handleRepoDiff(current.repository, requestUrl);
      }
      return jsonResponse(buildDiffPayload(current.source.diff, current.source));
    }

    if (requestUrl.pathname === '/api/revisions') {
      if (repository) {
        return jsonResponse(await repository.engine.revisions());
      }
      return jsonResponse(
        { error: 'Revision selection is not available without a repository' },
        404,
      );
    }

    if (requestUrl.pathname.startsWith('/api/line-count/')) {
      if (repository) {
        return handleRepoLineCount(repository, requestUrl.pathname, requestUrl);
      }
      return jsonResponse({ oldLineCount: 0, newLineCount: 0 });
    }

    if (requestUrl.pathname.startsWith('/api/blob/')) {
      if (repository) {
        return handleRepoBlob(repository, requestUrl.pathname, requestUrl);
      }
      return jsonResponse({ error: 'Blob content is not available for an opened diff file' }, 404);
    }

    if (requestUrl.pathname.startsWith('/api/generated-status/')) {
      if (repository) {
        return handleRepoGeneratedStatus(repository, requestUrl.pathname, requestUrl);
      }
      return jsonResponse(
        { error: 'Generated status is not available for an opened diff file' },
        404,
      );
    }

    if (requestUrl.pathname === '/api/comments' && init?.method !== 'GET') {
      rememberCommentQuery(requestUrl);
      return handleCommentsPost(init, commentSessionKey(requestUrl));
    }
    const commentThreadMatch = requestUrl.pathname.match(/^\/api\/comments\/([^/]+)$/);
    if (commentThreadMatch && init?.method === 'DELETE') {
      rememberCommentQuery(requestUrl);
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
      rememberCommentQuery(requestUrl);
      const session = await loadSession(commentSessionKey(requestUrl));
      return jsonResponse({
        version: session.version,
        threads: session.threads,
      });
    }

    if (requestUrl.pathname === '/api/comment-imports' && init?.method === 'POST') {
      rememberCommentQuery(requestUrl);
      return handleCommentImportsPost(init, commentSessionKey(requestUrl));
    }

    if (requestUrl.pathname === '/api/narration') {
      const key = commentSessionKey(requestUrl);
      if (init?.method === 'PUT' || init?.method === 'POST') {
        return handleNarrationPut(init, key);
      }
      return handleNarrationGet(key);
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
    setDiff: (source: StandaloneDiffSource) => {
      current = { kind: 'diff', source };
      lastCommentQuery = null;
      setDiffFileMode(true);
    },
    setRepository: (repositoryInput: ActiveRepository) => {
      current = { kind: 'repo', repository: repositoryInput };
      lastCommentQuery = null;
      setDiffFileMode(false);
    },
    clearActiveSource: () => {
      current = null;
      lastCommentQuery = null;
    },
    refreshRepository: async (files: WalkedFile[]): Promise<string[]> => {
      const repository = activeRepository();
      if (!repository) {
        return [];
      }
      const warnings = await repository.engine.refresh(files);
      broadcastBridgeEvent({ type: 'reload' });
      return warnings;
    },
    getCommentQuery: () => lastCommentQuery ?? defaultCommentQuery(),
    restore: () => {
      window.fetch = originalFetch;
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        writable: true,
        value: originalSendBeacon,
      });
      diffFileModeWindow.__DIFFOPS_DIFF_FILE_MODE__ = wasDiffFileMode;
    },
  };
};
