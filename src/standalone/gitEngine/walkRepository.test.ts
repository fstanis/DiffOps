import { describe, expect, it } from 'bun:test';

import { buildGitIndex } from './fakeGitWorkerClient';
import { walkRepositoryHandle } from './walkRepository';
import type { PickedDirectoryHandle, PickedFileHandle, PickedHandle } from './walkDirectory';

const SHA = '0123456789abcdef0123456789abcdef01234567';

const fileHandle = (name: string, content: string | Uint8Array): PickedFileHandle => ({
  kind: 'file',
  name,
  getFile: () => Promise.resolve(new File([content as BlobPart], name)),
});

const directoryHandle = (
  name: string,
  children: PickedHandle[],
  extra: Partial<PickedDirectoryHandle> = {},
): PickedDirectoryHandle => ({
  kind: 'directory',
  name,
  async *entries() {
    for (const child of children) {
      yield [child.name, child];
    }
  },
  ...extra,
});

const makeGitDir = (indexBytes?: Uint8Array): PickedDirectoryHandle =>
  directoryHandle('.git', [
    fileHandle('HEAD', 'ref: refs/heads/main\n'),
    fileHandle('config', '[core]\n'),
    ...(indexBytes ? [fileHandle('index', indexBytes)] : []),
    directoryHandle('refs', [directoryHandle('heads', [fileHandle('main', 'abc\n')])]),
    directoryHandle('objects', [directoryHandle('ab', [fileHandle('cdef', new Uint8Array(8))])]),
    directoryHandle('hooks', [fileHandle('pre-commit', '#!/bin/sh\n')]),
    directoryHandle('logs', [fileHandle('HEAD', 'reflog\n')]),
  ]);

const trackedIndex = (paths: string[], sha = SHA): Uint8Array =>
  buildGitIndex(paths.map((path) => ({ path, sha })));

describe('walkRepositoryHandle', () => {
  it('mounts only the mirrored .git paths and the tracked worktree files', async () => {
    const repo = directoryHandle('repo', [
      fileHandle('README.md', 'readme\n'),
      directoryHandle('src', [fileHandle('app.ts', 'app\n')]),
      directoryHandle('node_modules', [directoryHandle('pkg', [fileHandle('index.js', 'dep\n')])]),
      directoryHandle('dist', [fileHandle('out.txt', 'built\n')]),
      makeGitDir(trackedIndex(['README.md', 'src/app.ts'])),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.files.map(({ path }) => path).sort()).toEqual([
      '.git/HEAD',
      '.git/config',
      '.git/index',
      '.git/objects/ab/cdef',
      '.git/refs/heads/main',
      'README.md',
      'src/app.ts',
    ]);
    expect(walk.fullWalkReason).toBe('none');
    expect(walk.missingTrackedPaths).toEqual([]);
    expect(walk.unreadablePaths).toEqual([]);
  });

  it('short-circuits on a .git file so verifyRepository can explain it', async () => {
    const repo = directoryHandle('repo', [
      fileHandle('.git', 'gitdir: ../main/.git\n'),
      fileHandle('README.md', 'readme\n'),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.files.map(({ path }) => path)).toEqual(['.git']);
    expect(walk.fullWalkReason).toBe('none');
  });

  it('returns an empty walk when the folder has no .git at all', async () => {
    const repo = directoryHandle('repo', [fileHandle('README.md', 'readme\n')]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.files).toEqual([]);
    expect(walk.fullWalkReason).toBe('missing-index');
  });

  it('falls back to a full worktree walk when the index is missing', async () => {
    const repo = directoryHandle('repo', [
      fileHandle('untracked.txt', 'no index entry\n'),
      makeGitDir(),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.fullWalkReason).toBe('missing-index');
    expect(walk.files.map(({ path }) => path)).toContain('untracked.txt');
    expect(walk.files.map(({ path }) => path)).not.toContain('.git/hooks/pre-commit');
  });

  it('falls back to a full worktree walk when the index is unreadable', async () => {
    const repo = directoryHandle('repo', [
      fileHandle('untracked.txt', 'no index entry\n'),
      makeGitDir(new TextEncoder().encode('not an index at all')),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.fullWalkReason).toBe('unreadable-index');
    expect(walk.files.map(({ path }) => path)).toContain('untracked.txt');
  });

  it('falls back to a full worktree walk on an unsupported index version', async () => {
    const index = trackedIndex(['a.txt']);
    new DataView(index.buffer).setUint32(4, 5);
    const repo = directoryHandle('repo', [fileHandle('a.txt', 'a\n'), makeGitDir(index)]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.fullWalkReason).toBe('unsupported-index-version');
    expect(walk.files.map(({ path }) => path)).toContain('a.txt');
  });

  it('reports a split index without walking the worktree at all', async () => {
    const index = buildGitIndex(
      [
        { path: 'a.txt', sha: SHA },
        { path: 'src/a.txt', sha: SHA },
      ],
      { extensions: [{ signature: 'link', payload: new Uint8Array(20) }] },
    );
    // `src` is tracked, so any phase-2 walk would descend into it and trip.
    const unlistableSrc = directoryHandle('src', [], {
      entries: () => {
        throw new Error('phase 2 must not run for a blocking index');
      },
    });
    const repo = directoryHandle('repo', [
      fileHandle('a.txt', 'a\n'),
      unlistableSrc,
      makeGitDir(index),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.blockingIndexExtension).toBe('link');
    expect(walk.fullWalkReason).toBe('none');
    expect(walk.missingTrackedPaths).toEqual([]);
    expect(walk.unreadablePaths).toEqual([]);
    expect(walk.files.map(({ path }) => path).sort()).toEqual([
      '.git/HEAD',
      '.git/config',
      '.git/index',
      '.git/objects/ab/cdef',
      '.git/refs/heads/main',
    ]);
  });

  it('reports a sparse index without walking the worktree at all', async () => {
    const index = buildGitIndex([{ path: 'a.txt', sha: SHA }], {
      extensions: [{ signature: 'sdir', payload: new Uint8Array(1) }],
    });
    const repo = directoryHandle('repo', [fileHandle('a.txt', 'a\n'), makeGitDir(index)]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.blockingIndexExtension).toBe('sdir');
    expect(walk.files.map(({ path }) => path)).not.toContain('a.txt');
  });

  it('resolves NFC/NFD spelling drift against the index spelling', async () => {
    const nfdName = 'cafe\u0301.md';
    const indexName = 'cafe\u0301.md'.normalize('NFC');
    const repo = directoryHandle('repo', [
      fileHandle(nfdName, 'contents\n'),
      makeGitDir(trackedIndex([indexName])),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.files.map(({ path }) => path)).toContain(indexName);
    expect(walk.files.map(({ path }) => path)).not.toContain(nfdName);
    expect(walk.missingTrackedPaths).toEqual([]);
  });

  it('recovers a case-mismatched tracked file through getFileHandle', async () => {
    const onDiskName = 'Readme.md';
    const indexName = 'readme.md';
    const repo = directoryHandle(
      'repo',
      [fileHandle(onDiskName, 'readme\n'), makeGitDir(trackedIndex([indexName]))],
      {
        getFileHandle: (name) =>
          name === indexName
            ? Promise.resolve(fileHandle(onDiskName, 'readme\n'))
            : Promise.reject(new Error('not found')),
      },
    );

    const walk = await walkRepositoryHandle(repo);

    expect(walk.files.map(({ path }) => path)).toContain(indexName);
    expect(walk.missingTrackedPaths).toEqual([]);
  });

  it('reports a genuinely missing tracked path when no lookup can recover it', async () => {
    const repo = directoryHandle('repo', [
      fileHandle('kept.txt', 'kept\n'),
      makeGitDir(trackedIndex(['kept.txt', 'gone.txt'])),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.missingTrackedPaths).toEqual(['gone.txt']);
  });

  it('excludes unreachable symlinks from missingTrackedPaths', async () => {
    const index = buildGitIndex([
      { path: 'kept.txt', sha: SHA },
      { path: 'dangling-link', sha: SHA, mode: 0o120000 },
    ]);
    const repo = directoryHandle('repo', [fileHandle('kept.txt', 'kept\n'), makeGitDir(index)]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.missingTrackedPaths).toEqual([]);
    expect(walk.files.map(({ path }) => path)).not.toContain('dangling-link');
  });

  it('mounts a submodule marker file without the submodule worktree', async () => {
    const index = buildGitIndex([
      { path: 'README.md', sha: SHA },
      { path: 'sub', sha: 'a'.repeat(40), mode: 0o160000 },
    ]);
    const repo = directoryHandle('repo', [
      fileHandle('README.md', 'readme\n'),
      directoryHandle('sub', [
        fileHandle('.git', 'gitdir: ../.git/modules/sub\n'),
        fileHandle('hello.txt', 'submodule worktree file\n'),
      ]),
      makeGitDir(index),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.files.map(({ path }) => path).sort()).toEqual([
      '.git/HEAD',
      '.git/config',
      '.git/index',
      '.git/objects/ab/cdef',
      '.git/refs/heads/main',
      'README.md',
      'sub/.git',
    ]);
  });

  it('walks a nested submodule .git directory with the mirror predicates', async () => {
    const index = buildGitIndex([
      { path: 'README.md', sha: SHA },
      { path: 'sub', sha: 'a'.repeat(40), mode: 0o160000 },
    ]);
    const repo = directoryHandle('repo', [
      fileHandle('README.md', 'readme\n'),
      directoryHandle('sub', [
        directoryHandle('.git', [
          fileHandle('HEAD', 'ref: refs/heads/main\n'),
          directoryHandle('refs', [directoryHandle('heads', [fileHandle('main', 'abc\n')])]),
          directoryHandle('hooks', [fileHandle('pre-commit', '#!/bin/sh\n')]),
        ]),
        fileHandle('hello.txt', 'submodule worktree file\n'),
      ]),
      makeGitDir(index),
    ]);

    const walk = await walkRepositoryHandle(repo);

    expect(walk.files.map(({ path }) => path).sort()).toEqual([
      '.git/HEAD',
      '.git/config',
      '.git/index',
      '.git/objects/ab/cdef',
      '.git/refs/heads/main',
      'README.md',
      'sub/.git/HEAD',
      'sub/.git/refs/heads/main',
    ]);
  });

  it('reports progress per phase with the tracked total once parsed', async () => {
    const repo = directoryHandle('repo', [
      fileHandle('README.md', 'readme\n'),
      directoryHandle('src', [fileHandle('app.ts', 'app\n')]),
      directoryHandle('node_modules', [fileHandle('skip.js', 'dep\n')]),
      makeGitDir(trackedIndex(['README.md', 'src/app.ts'])),
    ]);
    const phases: string[] = [];
    const totals: number[] = [];

    await walkRepositoryHandle(repo, {
      onProgress: ({ phase, totalFiles }) => {
        phases.push(phase);
        totals.push(totalFiles);
      },
    });

    expect(phases[0]).toBe('git');
    expect(phases[phases.length - 1]).toBe('worktree');
    expect(totals[0]).toBe(0);
    expect(totals[totals.length - 1]).toBe(2);
  });
});
