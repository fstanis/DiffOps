import { beforeEach, describe, expect, it } from 'bun:test';

import type { DiffCommentThread } from '../../types/diff';
import type { PickedDirectoryHandle } from '../gitEngine/walkDirectory';

import { createMemoryKvStore } from './kvStore';
import {
  buildCommentSessionKey,
  StandaloneStore,
  resetStandaloneStoreForTests,
} from './standaloneStore';

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

const makeStore = () => new StandaloneStore(createMemoryKvStore());

const makeHandle = (name: string): PickedDirectoryHandle => ({
  kind: 'directory',
  name,
  async *entries() {},
});

describe('StandaloneStore', () => {
  beforeEach(() => {
    resetStandaloneStoreForTests();
  });

  it('builds comment session keys from repository and refs', () => {
    expect(buildCommentSessionKey('repo', 'HEAD', '.')).toBe('repo|HEAD|.|');
    expect(buildCommentSessionKey('repo', 'a', 'b', 'merge-base')).toBe('repo|a|b|merge-base');
  });

  it('round-trips comment sessions', async () => {
    const store = makeStore();
    const key = buildCommentSessionKey('repo-abc123', 'HEAD', '.');

    await expect(store.loadCommentSession(key)).resolves.toBeUndefined();

    await store.saveCommentSession(key, [makeThread('thread-1')], 3);

    await expect(store.loadCommentSession(key)).resolves.toEqual({
      threads: [makeThread('thread-1')],
      version: 3,
      updatedAt: expect.any(String) as string,
    });
  });

  it('round-trips narrations under their own session key', async () => {
    const store = makeStore();
    const key = buildCommentSessionKey('repo-abc123', 'HEAD', '.');

    await expect(store.loadNarration(key)).resolves.toBeUndefined();

    const narration = {
      intro: 'Adds a flag.',
      cards: [{ path: 'src/app.ts', narrative: 'The whole change.' }],
      epilogue: 'None.',
    };
    await store.saveNarration(key, narration, 'fingerprint-1');

    await expect(store.loadNarration(key)).resolves.toEqual({
      narration,
      fingerprint: 'fingerprint-1',
      updatedAt: expect.any(String) as string,
    });
    await expect(
      store.loadNarration(buildCommentSessionKey('repo-other', 'HEAD', '.')),
    ).resolves.toBeUndefined();
  });

  it('lists registered repositories by folder name', async () => {
    const store = makeStore();

    await expect(store.listRegisteredRepositories()).resolves.toEqual([]);

    await store.registerRepository('zebra', makeHandle('zebra'));
    await store.registerRepository('apple', makeHandle('apple'));

    const registered = await store.listRegisteredRepositories();
    expect(registered.map((entry) => entry.folderName)).toEqual(['apple', 'zebra']);
    expect(registered[0]?.registeredAt).toEqual(expect.any(String) as string);
  });

  it('replaces a registration sharing a folder name', async () => {
    const store = makeStore();
    const replacement = makeHandle('repo');

    await store.registerRepository('repo', makeHandle('repo'));
    await store.registerRepository('repo', replacement);

    await expect(store.listRegisteredRepositories()).resolves.toHaveLength(1);
    const loaded = await store.loadRegisteredRepository('repo');
    expect(loaded?.handle).toBe(replacement);
  });

  it('forgets a registered repository by folder name', async () => {
    const store = makeStore();
    await store.registerRepository('repo', makeHandle('repo'));

    await store.forgetRegisteredRepository('repo');

    await expect(store.loadRegisteredRepository('repo')).resolves.toBeUndefined();
    await expect(store.listRegisteredRepositories()).resolves.toEqual([]);
  });
});
