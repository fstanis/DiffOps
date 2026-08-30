import { afterEach, describe, expect, it, vi } from 'bun:test';

import type { DiffCommentThread, DiffFile } from '../types/diff';

import { subscribeToBridgeEvents, type BridgeEvent } from './bridgeEvents';
import { installLocalApiBridge } from './localApiBridge';
import { StandaloneStore, resetStandaloneStoreForTests } from './persistence/standaloneStore';
import { createMemoryKvStore } from './persistence/kvStore';
import { resetStandaloneSettingsForTests } from './persistence/settingsStore';

const makeDiffFiles = (): DiffFile[] => [
  {
    path: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    chunks: [
      {
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { type: 'delete', content: 'const version = 1;', oldLineNumber: 1 },
          { type: 'add', content: 'const version = 2;', newLineNumber: 1 },
        ],
      },
    ],
  },
];

const makeThread = (id: string): DiffCommentThread => ({
  id,
  filePath: 'src/app.ts',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  position: { side: 'new', line: 1 },
  messages: [
    {
      id: `${id}-message`,
      body: 'comment body',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
  ],
});

const makeEngine = () => {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    currentSelection: { baseCommitish: 'HEAD', targetCommitish: '.' },
    diff: async (request?: unknown, ignoreWhitespace?: boolean) => {
      calls.push({ method: 'diff', args: [request, ignoreWhitespace] });
      return {
        commit: 'abc1234 vs Working Directory (all uncommitted changes)',
        files: makeDiffFiles(),
        isEmpty: false,
        baseCommitish: 'abc1234',
        targetCommitish: '.',
        requestedBaseCommitish: 'HEAD',
        requestedTargetCommitish: '.',
      };
    },
    revisions: async () => {
      calls.push({ method: 'revisions', args: [] });
      return {
        specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
        branches: [{ name: 'main', current: true }],
        commits: [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', message: 'first' }],
        originDefaultBranch: 'origin/main',
        resolvedBase: 'abc1234',
        resolvedTarget: undefined,
      };
    },
    blob: async (path: string, ref: string) => {
      calls.push({ method: 'blob', args: [path, ref] });
      if (path.endsWith('.png')) {
        return { kind: 'bytes' as const, bytes: new Uint8Array([1, 2, 3]) };
      }
      return { kind: 'text' as const, text: 'line one\nline two\n' };
    },
    lineCount: async (path: string, ref: string) => {
      calls.push({ method: 'lineCount', args: [path, ref] });
      return 2;
    },
    generatedStatus: async (path: string, ref: string) => {
      calls.push({ method: 'generatedStatus', args: [path, ref] });
      return { path, ref, isGenerated: true, source: 'path' as const };
    },
    refresh: async (files: unknown[]) => {
      calls.push({ method: 'refresh', args: [files] });
      return [];
    },
  };
};

describe('installLocalApiBridge', () => {
  let bridge: ReturnType<typeof installLocalApiBridge> | null = null;

  afterEach(() => {
    bridge?.restore();
    bridge = null;
    window.localStorage.clear();
    resetStandaloneStoreForTests();
    resetStandaloneSettingsForTests();
    vi.restoreAllMocks();
  });

  const install = () => {
    bridge = installLocalApiBridge();
    return bridge;
  };

  const mountRepository = (
    installed: ReturnType<typeof installLocalApiBridge>,
    repositoryId = 'repo-test',
  ) => {
    const engine = makeEngine();
    installed.setRepository({ engine, repositoryId, repoName: 'repo' });
    return engine;
  };

  const installWithRepo = (repositoryId = 'repo-test') => {
    const installed = install();
    return { engine: mountRepository(installed, repositoryId), repoBridge: installed };
  };

  it('serves 404 from the repository endpoints until a repository is mounted', async () => {
    install();

    for (const path of [
      '/api/diff',
      '/api/revisions',
      '/api/blob/src%2Fapp.ts?ref=HEAD',
      '/api/line-count/src%2Fapp.ts?newRef=HEAD',
      '/api/generated-status/src%2Fapp.ts',
    ]) {
      expect((await fetch(path)).status).toBe(404);
    }
  });

  it('passes requests it does not answer through to the real network', async () => {
    const passthroughResponse = new Response('ok');
    const networkFetch = vi.fn(() => Promise.resolve(passthroughResponse));
    const originalFetch = global.fetch;
    global.fetch = networkFetch as unknown as typeof fetch;
    try {
      install();

      await expect(fetch('/manifest.webmanifest')).resolves.toBe(passthroughResponse);
      expect(networkFetch).toHaveBeenCalledWith('/manifest.webmanifest', undefined);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('stores comments in memory with version tracking', async () => {
    installWithRepo();

    const post = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads: [makeThread('thread-1')] }),
    });
    const postData = (await post.json()) as { success: boolean; version: number };
    expect(postData.success).toBe(true);
    expect(postData.version).toBe(1);

    const stored = await fetch('/api/comments-json');
    const storedData = (await stored.json()) as {
      version: number;
      threads: DiffCommentThread[];
    };
    expect(storedData.version).toBe(1);
    expect(storedData.threads).toHaveLength(1);
    expect(storedData.threads[0]?.id).toBe('thread-1');
  });

  it('deletes stored comment threads', async () => {
    installWithRepo();

    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads: [makeThread('thread-1'), makeThread('thread-2')] }),
    });

    const removal = await fetch('/api/comments/thread-1', { method: 'DELETE' });
    expect(removal.ok).toBe(true);

    const stored = await fetch('/api/comments-json');
    const storedData = (await stored.json()) as { threads: DiffCommentThread[] };
    expect(storedData.threads.map((thread) => thread.id)).toEqual(['thread-2']);

    const missing = await fetch('/api/comments/unknown', { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('persists comments across bridge reinstalls via the store', async () => {
    const store = new StandaloneStore(createMemoryKvStore());

    const first = installLocalApiBridge({ store });
    mountRepository(first);
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads: [makeThread('thread-1')] }),
    });
    first.restore();

    const second = installLocalApiBridge({ store });
    mountRepository(second);
    bridge = second;

    const stored = await fetch('/api/comments-json');
    const storedData = (await stored.json()) as { version: number; threads: DiffCommentThread[] };
    expect(storedData.threads).toHaveLength(1);
    expect(storedData.threads[0]?.id).toBe('thread-1');
    expect(storedData.version).toBe(1);
  });

  it('keys comment sessions by the repository id and selection', async () => {
    const store = new StandaloneStore(createMemoryKvStore());
    bridge = installLocalApiBridge({ store });
    mountRepository(bridge);

    const response = await fetch('/api/comments?base=HEAD&target=.', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads: [makeThread('thread-1')], baseVersion: 0 }),
    });
    expect(response.ok).toBe(true);

    const persisted = await store.loadCommentSession('repo-test|HEAD|.|');
    expect(persisted?.threads).toEqual([makeThread('thread-1')]);

    const otherSelection = await fetch('/api/comments-json?base=main&target=feature');
    await expect(otherSelection.json()).resolves.toEqual({ version: 0, threads: [] });
  });

  it('round-trips narrations under the comment session key', async () => {
    installWithRepo();

    const empty = (await (await fetch('/api/narration')).json()) as { narration: unknown };
    expect(empty.narration).toBeNull();

    const put = await fetch('/api/narration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        narration: {
          intro: 'Adds a flag.',
          cards: [{ path: 'src/app.ts', narrative: 'The whole change.' }],
          epilogue: 'None.',
        },
        fingerprint: 'fingerprint-1',
      }),
    });
    expect(put.ok).toBe(true);

    const stored = (await (await fetch('/api/narration')).json()) as {
      narration: { narration: { intro: string }; fingerprint: string } | null;
    };
    expect(stored.narration?.fingerprint).toBe('fingerprint-1');
    expect(stored.narration?.narration.intro).toBe('Adds a flag.');
  });

  it('rejects invalid narration payloads', async () => {
    installWithRepo();

    const put = await fetch('/api/narration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ narration: { intro: 'no cards' }, fingerprint: '' }),
    });
    expect(put.status).toBe(400);
  });

  it('persists narrations across bridge reinstalls via the store', async () => {
    const store = new StandaloneStore(createMemoryKvStore());
    const narration = {
      intro: 'Adds a flag.',
      cards: [{ path: 'src/app.ts', narrative: 'The whole change.' }],
      epilogue: 'None.',
    };

    const first = installLocalApiBridge({ store });
    mountRepository(first);
    await fetch('/api/narration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ narration, fingerprint: 'fingerprint-1' }),
    });
    first.restore();

    const second = installLocalApiBridge({ store });
    mountRepository(second);
    bridge = second;

    const stored = (await (await fetch('/api/narration')).json()) as {
      narration: { narration: typeof narration; fingerprint: string } | null;
    };
    expect(stored.narration?.fingerprint).toBe('fingerprint-1');
    expect(stored.narration?.narration).toEqual(narration);
  });

  describe('file explanations', () => {
    const storedExplanation = {
      fileSummary: 'Parses the sensor stream.',
      symbols: [
        { name: 'parseStream', type: 'function' as const, summary: 'Turns samples into beats.' },
      ],
      additionalFilesNeeded: ['src/helper.ts'],
    };

    const explanationUrl = (path: string) => `/api/explanation?path=${encodeURIComponent(path)}`;

    it('round-trips a first-round explanation under the comment session and path', async () => {
      installWithRepo();

      const empty = (await (await fetch(explanationUrl('src/app.ts'))).json()) as {
        explanation: unknown;
      };
      expect(empty.explanation).toBeNull();

      const put = await fetch(explanationUrl('src/app.ts'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          explanation: storedExplanation,
          includedSupportingFiles: [],
          fingerprint: 'fingerprint-1',
        }),
      });
      expect(put.ok).toBe(true);

      const stored = (await (await fetch(explanationUrl('src/app.ts'))).json()) as {
        explanation: {
          explanation: typeof storedExplanation;
          includedSupportingFiles: string[];
          fingerprint: string;
        } | null;
      };
      expect(stored.explanation?.fingerprint).toBe('fingerprint-1');
      expect(stored.explanation?.includedSupportingFiles).toEqual([]);
      expect(stored.explanation?.explanation).toEqual(storedExplanation);
    });

    it('keeps each file path under its own record', async () => {
      installWithRepo();

      await fetch(explanationUrl('src/app.ts'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          explanation: storedExplanation,
          includedSupportingFiles: [],
          fingerprint: 'fingerprint-1',
        }),
      });

      const other = (await (await fetch(explanationUrl('src/other.ts'))).json()) as {
        explanation: unknown;
      };
      expect(other.explanation).toBeNull();
    });

    it('rejects invalid explanation payloads and missing paths', async () => {
      installWithRepo();

      const invalidPut = await fetch(explanationUrl('src/app.ts'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          explanation: { fileSummary: 'no symbols' },
          includedSupportingFiles: [],
          fingerprint: '',
        }),
      });
      expect(invalidPut.status).toBe(400);

      const missingPathGet = await fetch('/api/explanation');
      expect(missingPathGet.status).toBe(400);

      const missingPathPut = await fetch('/api/explanation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          explanation: storedExplanation,
          includedSupportingFiles: [],
          fingerprint: 'fingerprint-1',
        }),
      });
      expect(missingPathPut.status).toBe(400);
    });

    it('persists explanations across bridge reinstalls via the store', async () => {
      const store = new StandaloneStore(createMemoryKvStore());

      const first = installLocalApiBridge({ store });
      mountRepository(first);
      await fetch(explanationUrl('src/app.ts'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          explanation: storedExplanation,
          includedSupportingFiles: ['src/helper.ts'],
          fingerprint: 'fingerprint-1',
        }),
      });
      first.restore();

      const second = installLocalApiBridge({ store });
      mountRepository(second);
      bridge = second;

      const stored = (await (await fetch(explanationUrl('src/app.ts'))).json()) as {
        explanation: {
          explanation: typeof storedExplanation;
          includedSupportingFiles: string[];
        } | null;
      };
      expect(stored.explanation?.includedSupportingFiles).toEqual(['src/helper.ts']);
      expect(stored.explanation?.explanation).toEqual(storedExplanation);
    });
  });

  it('serves user settings from localStorage with merge-on-put semantics', async () => {
    install();

    const initial = await fetch('/api/user-settings');
    await expect(initial.json()).resolves.toEqual({ version: 1, client: {} });

    const put = await fetch('/api/user-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: { appearance: { theme: 'dark' } } }),
    });
    await expect(put.json()).resolves.toEqual({
      version: 1,
      client: { appearance: { theme: 'dark' } },
    });

    await fetch('/api/user-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: { other: true } }),
    });

    const reloaded = await fetch('/api/user-settings');
    await expect(reloaded.json()).resolves.toEqual({
      version: 1,
      client: { appearance: { theme: 'dark' }, other: true },
    });
  });

  it('rejects malformed user settings puts with 400', async () => {
    install();

    const response = await fetch('/api/user-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ not: 'a client patch' }),
    });
    expect(response.status).toBe(400);
  });

  it('restores the original globals', async () => {
    const fetchMock = vi.fn();
    window.fetch = fetchMock as unknown as typeof window.fetch;

    const installed = install();
    installed.restore();

    // fetch is restored as a bound reference, so route a call through it to check it reaches the pre-install implementation.
    await window.fetch('/api/diff');
    expect(fetchMock).toHaveBeenCalledWith('/api/diff');
  });

  it('serves /api/diff from the engine with the route-level fields', async () => {
    const { engine } = installWithRepo();

    const response = await fetch('/api/diff?ignoreWhitespace=true&base=HEAD&target=.');
    expect(response.ok).toBe(true);

    const data = (await response.json()) as Record<string, unknown>;
    expect(data.repositoryId).toBe('repo-test');
    expect(data.ignoreWhitespace).toBe(true);
    expect(data.targetCommitish).toBe('.');
    expect(data.files).toEqual(makeDiffFiles());
    expect(engine.calls[0]).toEqual({
      method: 'diff',
      args: [{ base: 'HEAD', target: '.', baseMode: undefined }, true],
    });
  });

  it('maps engine failures to a 500 error payload and logs the cause', async () => {
    const engine = makeEngine();
    engine.diff = async () => {
      throw new Error('boom');
    };
    bridge = installLocalApiBridge();
    bridge.setRepository({ engine, repositoryId: 'repo-test', repoName: 'repo' });

    const response = await fetch('/api/diff?base=HEAD&target=d76d6b9');
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'boom' });

    const logged = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .find((line) => line.includes('diff failed'));
    expect(logged).toContain('base=HEAD');
    expect(logged).toContain('target=d76d6b9');
    expect(logged).toContain('boom');
  });

  it('serves /api/revisions from the engine', async () => {
    installWithRepo();

    const response = await fetch('/api/revisions');
    expect(response.ok).toBe(true);
    const data = (await response.json()) as { branches: { name: string; current: boolean }[] };
    expect(data.branches).toEqual([{ name: 'main', current: true }]);
  });

  it('serves blobs with extension-derived content types', async () => {
    installWithRepo();

    const textBlob = await fetch('/api/blob/src%2Fapp.ts?ref=HEAD');
    expect(textBlob.headers.get('Content-Type')).toBe('application/octet-stream');
    await expect(textBlob.text()).resolves.toBe('line one\nline two\n');

    const pngBlob = await fetch('/api/blob/logo.png?ref=HEAD');
    expect(pngBlob.headers.get('Content-Type')).toBe('image/png');
    await expect(pngBlob.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it('serves line counts for the given refs', async () => {
    const { engine } = installWithRepo();

    const response = await fetch(
      '/api/line-count/src%2Fapp.ts?oldRef=HEAD%5E&newRef=HEAD&oldPath=src%2Fold.ts',
    );
    await expect(response.json()).resolves.toEqual({ oldLineCount: 2, newLineCount: 2 });
    expect(engine.calls).toEqual([
      { method: 'lineCount', args: ['src/old.ts', 'HEAD^'] },
      { method: 'lineCount', args: ['src/app.ts', 'HEAD'] },
    ]);
  });

  it('serves generated status with the selection target as the default ref', async () => {
    const { engine } = installWithRepo();

    const explicit = await fetch('/api/generated-status/src%2Fapp.ts?ref=main');
    await expect(explicit.json()).resolves.toEqual({
      path: 'src/app.ts',
      ref: 'main',
      isGenerated: true,
      source: 'path',
    });

    const defaulted = await fetch('/api/generated-status/src%2Fapp.ts');
    await expect(defaulted.json()).resolves.toMatchObject({ ref: '.' });
    expect(engine.calls.at(-1)?.args[1]).toBe('.');
  });

  it('refresh remounts the engine and broadcasts a reload event', async () => {
    const { engine } = installWithRepo();
    const events: BridgeEvent[] = [];
    const unsubscribe = subscribeToBridgeEvents((event) => {
      events.push(event);
    });

    await bridge!.refreshRepository([{ path: 'a.txt', file: new File(['x\n'], 'a.txt') }]);

    expect(engine.calls).toEqual([
      {
        method: 'refresh',
        args: [[{ path: 'a.txt', file: expect.any(File) }]],
      },
    ]);
    expect(events).toEqual([{ type: 'reload' }]);

    unsubscribe();
  });
});
