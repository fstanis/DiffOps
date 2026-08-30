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

describe('StandaloneStore', () => {
  beforeEach(() => {
    resetStandaloneStoreForTests();
  });

  it('builds comment session keys from repository and refs', () => {
    expect(buildCommentSessionKey('repo', 'stdin', 'stdin')).toBe('repo|stdin|stdin|');
    expect(buildCommentSessionKey('repo', 'a', 'b', 'merge-base')).toBe('repo|a|b|merge-base');
  });

  it('round-trips comment sessions', async () => {
    const store = makeStore();
    const key = buildCommentSessionKey('standalone-test', 'stdin', 'stdin');

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
    const key = buildCommentSessionKey('standalone-test', 'stdin', 'stdin');

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
      store.loadNarration(buildCommentSessionKey('standalone-other', 'stdin', 'stdin')),
    ).resolves.toBeUndefined();
  });

  it('counts comment threads across a repository\u2019s sessions only', async () => {
    const store = makeStore();
    const repositoryId = 'standalone-test';

    await store.saveCommentSession(
      buildCommentSessionKey(repositoryId, 'stdin', 'stdin'),
      [makeThread('a'), makeThread('b')],
      1,
    );
    await store.saveCommentSession(
      buildCommentSessionKey('standalone-other', 'stdin', 'stdin'),
      [makeThread('c')],
      1,
    );

    await expect(store.countCommentThreads(repositoryId)).resolves.toBe(2);
    await expect(store.countCommentThreads('standalone-other')).resolves.toBe(1);
    await expect(store.countCommentThreads('standalone-unknown')).resolves.toBe(0);
  });

  it('records recent diffs, newest first, capped at 10', async () => {
    const store = makeStore();

    for (let index = 0; index < 12; index += 1) {
      await store.recordRecentDiff(`file-${index}.diff`, `standalone-${index}`, 100 + index);
    }
    // Re-opening updates the timestamp without duplicating the entry.
    await store.recordRecentDiff('file-0.diff', 'standalone-0', 100);

    const entries = await store.listRecentDiffs();
    expect(entries).toHaveLength(10);
    // Most recent first: the re-opened file-0 was touched last.
    expect(entries[0]?.fileName).toBe('file-0.diff');
    expect(entries.map((entry) => entry.fileName)).not.toContain('file-2.diff');
    expect(entries.every((entry) => entry.commentCount === 0)).toBe(true);
  });

  it('forgets a recent diff by key', async () => {
    const store = makeStore();
    await store.recordRecentDiff('gone.diff', 'standalone-1', 10);

    const [entry] = await store.listRecentDiffs();
    await store.forgetRecentDiff(entry!.key);

    await expect(store.listRecentDiffs()).resolves.toEqual([]);
  });

  it('reports comment counts per recent diff', async () => {
    const store = makeStore();
    const repositoryId = 'standalone-1';
    await store.recordRecentDiff('reviewed.diff', repositoryId, 10);
    await store.saveCommentSession(
      buildCommentSessionKey(repositoryId, 'stdin', 'stdin'),
      [makeThread('a')],
      1,
    );

    const [entry] = await store.listRecentDiffs();
    expect(entry?.commentCount).toBe(1);
  });

  it('round-trips the last opened repository with its handle', async () => {
    const store = makeStore();
    const handle: PickedDirectoryHandle = {
      kind: 'directory',
      name: 'repo',
      async *entries() {},
    };
    await expect(store.loadLastRepo()).resolves.toBeUndefined();

    await store.saveLastRepo({
      repoName: 'repo',
      repositoryId: 'repo-abc123',
      openedAt: '2026-08-28T00:00:00.000Z',
      handle,
    });

    await expect(store.loadLastRepo()).resolves.toEqual({
      repoName: 'repo',
      repositoryId: 'repo-abc123',
      openedAt: '2026-08-28T00:00:00.000Z',
      handle,
    });

    await store.forgetLastRepo();
    await expect(store.loadLastRepo()).resolves.toBeUndefined();
  });
});
