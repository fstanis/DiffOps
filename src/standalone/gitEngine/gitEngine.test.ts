import { describe, expect, it } from 'bun:test';

import {
  buildGitIndex,
  buildLooseObject,
  FakeGitWorkerClient,
  type FakeRunHandler,
  runFail,
  runOk,
  runStale,
} from './fakeGitWorkerClient';
import { GitEngine } from './gitEngine';

const HEAD_HASH = '5a29ad326040fd305c942e461bc78c8c642e5812';
const ROOT_HASH = '864681f05278d072e0eae561a35858e2045330e5';
const MAIN_HASH = 'cccccccccccccccccccccccccccccccccccccccc';
const FEATURE_HASH = 'dddddddddddddddddddddddddddddddddddddddd';
const BLOB_HASH = '0123456789abcdef0123456789abcdef01234567';
const BINARY_BLOB_HASH = '9999999999999999999999999999999999999999';

const WORKING_DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 83db48f..ed51eca 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-line2',
  '+CHANGED',
  ' line3',
  '',
].join('\n');

const A_TXT = 'line1\nline2\nline3\n';

const repositoryFiles = (): Record<string, string | Uint8Array> => ({
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.git/refs/heads/main': `${HEAD_HASH}\n`,
  'a.txt': A_TXT,
});

const openEngine = async (
  run: FakeRunHandler,
  options: {
    files?: Record<string, string | Uint8Array>;
    walked?: { path: string; file: File }[];
    repoName?: string;
  } = {},
) => {
  const client = new FakeGitWorkerClient({
    files: { ...repositoryFiles(), ...options.files },
    run,
  });
  const engine = new GitEngine(client);
  const info = await engine.open(
    options.walked ?? [{ path: 'a.txt', file: new File([A_TXT], 'a.txt') }],
    options.repoName ?? 'repo',
  );
  return { client, engine, info };
};

const runAlways =
  (handlers: Record<string, ReturnType<typeof runOk>>): FakeRunHandler =>
  (args) => {
    const key = args.join(' ');
    return handlers[key] ?? runFail(`unexpected git command: ${key}`);
  };

describe('GitEngine.open', () => {
  it('computes a stable repository id from the root commit and name', async () => {
    const { engine } = await openEngine(
      runAlways({ 'rev-list HEAD': runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`) }),
    );

    expect(engine.repositoryId).toMatch(/^repo-[0-9a-f]{16}$/);
  });

  it('surfaces mount warnings from the worker without failing the open', async () => {
    const client = new FakeGitWorkerClient({
      files: repositoryFiles(),
      run: runAlways({ 'rev-list HEAD': runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`) }),
      mountWarnings: ['Could not read .git/objects/pack/pack-abc.pack: gone'],
    });
    const engine = new GitEngine(client);

    const info = await engine.open([], 'repo');

    expect(info.warnings).toEqual(['Could not read .git/objects/pack/pack-abc.pack: gone']);
  });

  it('warns about committed symlinks and submodules the browser cannot represent', async () => {
    const { info } = await openEngine(
      runAlways({ 'rev-list HEAD': runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`) }),
      {
        files: {
          '.git/index': buildGitIndex([
            { path: 'a.txt', sha: BLOB_HASH },
            { path: 'local-link', sha: BLOB_HASH, mode: 0o120000 },
            { path: 'vendor/lib', sha: BLOB_HASH, mode: 0o160000 },
          ]),
        },
      },
    );

    expect(info.warnings).toHaveLength(2);
    expect(info.warnings[0]).toContain('symlink');
    expect(info.warnings[0]).toContain('local-link');
    expect(info.warnings[1]).toContain('submodule');
    expect(info.warnings[1]).toContain('vendor/lib');
  });

  it('returns no warnings for an ordinary repository', async () => {
    const client = new FakeGitWorkerClient({
      files: {
        ...repositoryFiles(),
        '.git/index': buildGitIndex([{ path: 'a.txt', sha: BLOB_HASH }]),
      },
      run: runAlways({ 'rev-list HEAD': runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`) }),
    });
    const engine = new GitEngine(client);

    expect(await engine.open([], 'repo')).toMatchObject({ warnings: [] });
  });

  it('fails clearly for a folder without .git', async () => {
    const client = new FakeGitWorkerClient({ files: {}, run: runAlways({}) });
    const engine = new GitEngine(client);
    await expect(engine.open([], 'plain-folder')).rejects.toThrow('is not a git repository');
  });

  it('fails clearly for worktree/submodule .git files', async () => {
    const client = new FakeGitWorkerClient({
      files: { '.git': 'gitdir: /somewhere/else\n' },
      run: runAlways({}),
    });
    const engine = new GitEngine(client);
    await expect(engine.open([], 'linked')).rejects.toThrow('uses a .git file');
  });

  it('fails clearly for a repository without commits', async () => {
    const client = new FakeGitWorkerClient({
      files: { '.git/HEAD': 'ref: refs/heads/new\n' },
      run: runAlways({}),
    });
    const engine = new GitEngine(client);
    await expect(engine.open([], 'fresh')).rejects.toThrow('has no commits yet');
  });
});

describe('GitEngine.diff', () => {
  it('serves the working-changes default selection against HEAD', async () => {
    const { engine, client } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`),
        'rev-parse HEAD': runOk(HEAD_HASH),
        'diff HEAD -M50': runOk(WORKING_DIFF),
      }),
    );

    const diff = await engine.diff();

    expect(diff.commit).toBe(
      `${HEAD_HASH.slice(0, 7)} vs Working Directory (all uncommitted changes)`,
    );
    expect(diff.baseCommitish).toBe(HEAD_HASH.slice(0, 7));
    expect(diff.targetCommitish).toBe('.');
    expect(diff.requestedBaseCommitish).toBe('HEAD');
    expect(diff.requestedTargetCommitish).toBe('.');
    expect(diff.requestedBaseMode).toBeUndefined();
    expect(diff.isEmpty).toBe(false);
    expect(diff.files[0]?.path).toBe('a.txt');
    expect(client.runCalls.some((args) => args.includes('-M50'))).toBe(true);
  });

  it('maps the special targets to lg2 invocations mirroring git', async () => {
    const { engine, client } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        'rev-parse HEAD': runOk(HEAD_HASH),
        'diff HEAD -M50': runOk(WORKING_DIFF),
        'diff -M50': runOk(WORKING_DIFF),
        'diff --cached HEAD -M50': runOk(WORKING_DIFF),
        'diff HEAD -M50 -w': runOk(''),
      }),
    );

    await engine.diff();
    await engine.diff({ target: 'working' });
    await engine.diff({ base: 'HEAD', target: 'staged' });
    await engine.diff({ base: 'HEAD', target: '.' }, true);

    expect(client.runCalls.map((args) => args.join(' '))).toEqual([
      'rev-list HEAD',
      'rev-parse HEAD',
      'diff HEAD -M50',
      'diff -M50',
      'rev-parse HEAD',
      'diff --cached HEAD -M50',
      'rev-parse HEAD',
      'diff HEAD -M50 -w',
    ]);
  });

  it('compares two commits by resolved hashes with a range label', async () => {
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        'rev-parse main': runOk(MAIN_HASH),
        'rev-parse feature': runOk(FEATURE_HASH),
        [`diff ${MAIN_HASH} ${FEATURE_HASH} -M50`]: runOk(WORKING_DIFF),
      }),
    );

    const diff = await engine.diff({ base: 'main', target: 'feature' });

    expect(diff.commit).toBe(`${MAIN_HASH.slice(0, 7)}...${FEATURE_HASH.slice(0, 7)}`);
    expect(diff.baseCommitish).toBe(MAIN_HASH.slice(0, 7));
    expect(diff.targetCommitish).toBe(FEATURE_HASH.slice(0, 7));
  });

  it('approximates merge-base via the first shared rev-list entry', async () => {
    const { engine, client } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`),
        'rev-list main': runOk(`${MAIN_HASH}\n${ROOT_HASH}\n`),
        [`rev-parse ${ROOT_HASH}`]: runOk(ROOT_HASH),
        [`diff ${ROOT_HASH} -M50`]: runOk(WORKING_DIFF),
      }),
    );

    const diff = await engine.diff({ base: 'main', target: '.', baseMode: 'merge-base' });

    expect(diff.requestedBaseMode).toBe('merge-base');
    expect(client.runCalls.map((args) => args[0])).toEqual([
      'rev-list',
      'rev-list',
      'rev-list',
      'rev-parse',
      'diff',
    ]);
  });

  it('reports unresolvable refs as a diff failure carrying the git error', async () => {
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        'rev-parse nope': runFail("Could not parse 'nope' - revspec not found"),
      }),
    );

    await expect(engine.diff({ base: 'nope', target: 'feature' })).rejects.toThrow(
      /Failed to compute diff for feature vs nope: /,
    );
  });

  it('parses an empty diff as empty', async () => {
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        'rev-parse HEAD': runOk(HEAD_HASH),
        'diff HEAD -M50': runOk(''),
      }),
    );

    expect((await engine.diff()).isEmpty).toBe(true);
  });
});

describe('GitEngine.revisions', () => {
  it('assembles special options, sorted branches, commits, and origin default', async () => {
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        'for-each-ref': runOk(
          [
            `${HEAD_HASH} commit\trefs/heads/feature`,
            `${HEAD_HASH} commit\trefs/heads/zeta`,
            `${MAIN_HASH} commit\trefs/remotes/origin/main`,
            `${MAIN_HASH} commit\trefs/heads/main`,
          ].join('\n'),
        ),
        'log -n 20': runOk(
          [
            `commit ${HEAD_HASH}`,
            'Author: P <p@example.com>',
            'Date:   Fri Aug 28 16:40:09 2026 -0400',
            '',
            '    add feature',
            '',
            `commit ${ROOT_HASH}`,
            'Author: P <p@example.com>',
            'Date:   Fri Aug 28 16:39:31 2026 -0400',
            '',
            '    first',
            '',
          ].join('\n'),
        ),
        'rev-parse HEAD': runOk(HEAD_HASH),
      }),
    );

    const revisions = await engine.revisions();

    expect(revisions.specialOptions).toEqual([
      { value: '.', label: 'All Uncommitted Changes' },
      { value: 'staged', label: 'Staging Area' },
      { value: 'working', label: 'Working Directory' },
    ]);
    // main is the default branch (origin/main exists) and the checked-out
    // branch (HEAD), so it sorts first; feature and zeta follow.
    expect(revisions.branches.map((branch) => branch.name)).toEqual(['main', 'feature', 'zeta']);
    expect(revisions.branches.find((branch) => branch.name === 'main')?.current).toBe(true);
    expect(revisions.branches.find((branch) => branch.name === 'feature')?.current).toBe(false);
    expect(revisions.commits).toEqual([
      { hash: HEAD_HASH, shortHash: HEAD_HASH.slice(0, 7), message: 'add feature' },
      { hash: ROOT_HASH, shortHash: ROOT_HASH.slice(0, 7), message: 'first' },
    ]);
    expect(revisions.originDefaultBranch).toBe('origin/main');
    expect(revisions.resolvedBase).toBe(HEAD_HASH.slice(0, 7));
    expect(revisions.resolvedTarget).toBeUndefined();
  });

  it('derives originDefaultBranch from the origin/HEAD file when present', async () => {
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        'for-each-ref': runOk(`${MAIN_HASH} commit\trefs/heads/main`),
        'log -n 20': runOk(`commit ${HEAD_HASH}\n\n    subject\n`),
      }),
      { files: { '.git/refs/remotes/origin/HEAD': 'ref: refs/remotes/origin/main\n' } },
    );

    expect((await engine.revisions()).originDefaultBranch).toBe('origin/main');
  });
});

describe('GitEngine.blob and lineCount', () => {
  it('reads working-tree files from the walked snapshot', async () => {
    const { engine } = await openEngine(runAlways({ 'rev-list HEAD': runOk(HEAD_HASH) }));

    const blob = await engine.blob('a.txt', '.');
    expect(blob).toEqual({ kind: 'bytes', bytes: new TextEncoder().encode(A_TXT) });
  });

  it('serves staged blobs via the git index and cat-file', async () => {
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        [`cat-file -p ${BLOB_HASH}`]: runOk('staged content\nsecond line\n'),
      }),
      {
        files: { '.git/index': buildGitIndex([{ path: 'staged.txt', sha: BLOB_HASH }]) },
      },
    );

    expect(await engine.blob('staged.txt', 'staged')).toEqual({
      kind: 'text',
      text: 'staged content\nsecond line\n',
    });
  });

  it('serves ref blobs via rev-parse and cat-file', async () => {
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        [`rev-parse HEAD:a.txt`]: runOk(BLOB_HASH),
        [`cat-file -p ${BLOB_HASH}`]: runOk('committed content\n'),
      }),
    );

    expect(await engine.blob('a.txt', 'HEAD')).toEqual({
      kind: 'text',
      text: 'committed content\n',
    });
  });

  it('inflates loose objects for binary blobs and errors for packed ones', async () => {
    const binaryContent = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]);
    const loosePath = `.git/objects/${BINARY_BLOB_HASH.slice(0, 2)}/${BINARY_BLOB_HASH.slice(2)}`;
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        [`rev-parse HEAD:img.png`]: runOk(BINARY_BLOB_HASH),
        [`cat-file -p ${BINARY_BLOB_HASH}`]: runOk('\u0000\u0001\u0002'),
      }),
      { files: { [loosePath]: buildLooseObject('blob', binaryContent) } },
    );

    const blob = await engine.blob('img.png', 'HEAD');
    expect(blob.kind).toBe('bytes');
    if (blob.kind === 'bytes') {
      expect(Array.from(blob.bytes)).toEqual(Array.from(binaryContent));
    }

    // Without the loose object (e.g. packed), binary content degrades loudly.
    const { engine: packedEngine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        [`rev-parse HEAD:img.png`]: runOk(BINARY_BLOB_HASH),
        [`cat-file -p ${BINARY_BLOB_HASH}`]: runOk('\u0000\u0001\u0002'),
      }),
    );
    await expect(packedEngine.blob('img.png', 'HEAD')).rejects.toThrow('the object is packed');
  });

  it('counts lines for text blobs and resolves failures to zero', async () => {
    const { engine } = await openEngine(runAlways({ 'rev-list HEAD': runOk(HEAD_HASH) }));

    expect(await engine.lineCount('a.txt', '.')).toBe(3);
    expect(await engine.lineCount('missing.txt', '.')).toBe(0);
  });
});

describe('GitEngine.generatedStatus', () => {
  it('flags generated paths without reading content', async () => {
    const { engine, client } = await openEngine(runAlways({ 'rev-list HEAD': runOk(HEAD_HASH) }));

    expect(await engine.generatedStatus('package-lock.json', 'HEAD')).toEqual({
      path: 'package-lock.json',
      ref: 'HEAD',
      isGenerated: true,
      source: 'path',
    });
    expect(client.runCalls).toEqual([['rev-list', 'HEAD']]);
  });

  it('reports plain files as not generated after the content check', async () => {
    const { engine } = await openEngine(
      runAlways({
        'rev-list HEAD': runOk(HEAD_HASH),
        [`rev-parse HEAD:a.txt`]: runOk(BLOB_HASH),
        [`cat-file -p ${BLOB_HASH}`]: runOk('just some source code\n'),
      }),
    );

    expect(await engine.generatedStatus('a.txt', 'HEAD')).toEqual({
      path: 'a.txt',
      ref: 'HEAD',
      isGenerated: false,
      source: 'path',
    });
  });
});

describe('GitEngine.refresh', () => {
  it('re-mounts freshly walked files without changing the selection', async () => {
    const { engine, client } = await openEngine(runAlways({ 'rev-list HEAD': runOk(HEAD_HASH) }));

    await engine.refresh([{ path: 'a.txt', file: new File(['updated\n'], 'a.txt') }]);
    expect(client.mountedRepoNames).toEqual(['repo', 'repo']);
    expect(engine.currentSelection).toEqual({ baseCommitish: 'HEAD', targetCommitish: '.' });
  });

  it('resolves with the new mount warnings', async () => {
    const client = new FakeGitWorkerClient({
      files: repositoryFiles(),
      run: runAlways({ 'rev-list HEAD': runOk(HEAD_HASH) }),
    });
    const engine = new GitEngine(client);
    await engine.open([], 'repo');
    client.setMountWarnings(['Could not read .git/index: busy']);

    await expect(engine.refresh([])).resolves.toEqual(['Could not read .git/index: busy']);
  });
});

describe('GitEngine stale snapshots', () => {
  const staleThenWorking = (stalePaths: string[]): FakeRunHandler => {
    let hasRunDiff = false;
    return (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') {
        return runOk(HEAD_HASH);
      }
      if (key === 'rev-list HEAD') {
        return runOk(HEAD_HASH);
      }
      if (!key.startsWith('diff')) {
        return runFail(`unexpected git command: ${key}`);
      }
      if (hasRunDiff) {
        return runOk(WORKING_DIFF);
      }
      hasRunDiff = true;
      return runStale(stalePaths);
    };
  };

  it('re-reads the folder and retries a command whose files changed on disk', async () => {
    const { engine, client } = await openEngine(staleThenWorking(['a.txt']));
    const freshFiles = [{ path: 'a.txt', file: new File(['CHANGED\n'], 'a.txt') }];
    engine.setFileSupplier(() => Promise.resolve(freshFiles));

    const diff = await engine.diff();

    expect(diff.files).toHaveLength(1);
    expect(client.mountedFiles.at(-1)).toEqual(freshFiles);
    expect(client.runCalls.filter((args) => args[0] === 'diff')).toHaveLength(2);
  });

  it('walks once when several stale commands overlap', async () => {
    let hasWalked = false;
    const { engine, client } = await openEngine((args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD' || key === 'rev-list HEAD') {
        return runOk(HEAD_HASH);
      }
      if (args[0] !== 'diff') {
        return runFail(`unexpected git command: ${key}`);
      }
      return hasWalked ? runOk(WORKING_DIFF) : runStale(['a.txt']);
    });
    let walkCount = 0;
    let finishWalk = (files: { path: string; file: File }[]): void => void files;
    engine.setFileSupplier(() => {
      walkCount += 1;
      return new Promise((resolve) => {
        finishWalk = resolve;
      });
    });

    const diffs = Promise.all([engine.diff(), engine.diff({ target: 'working' })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    hasWalked = true;
    finishWalk([{ path: 'a.txt', file: new File(['CHANGED\n'], 'a.txt') }]);

    expect(await diffs).toHaveLength(2);
    expect(walkCount).toBe(1);
    expect(client.mountedRepoNames).toEqual(['repo', 'repo']);
  });

  it('explains the failure when the files keep changing under the retry', async () => {
    const { engine } = await openEngine((args) =>
      args[0] === 'diff' ? runStale(['a.txt']) : runOk(HEAD_HASH),
    );
    engine.setFileSupplier(() =>
      Promise.resolve([{ path: 'a.txt', file: new File([A_TXT], 'a.txt') }]),
    );

    await expect(engine.diff()).rejects.toThrow('changed on disk while they were being read');
  });

  it('fails without retrying when no file supplier is installed', async () => {
    const { engine, client } = await openEngine(staleThenWorking(['a.txt']));

    await expect(engine.diff()).rejects.toThrow('changed on disk while they were being read');
    expect(client.runCalls.filter((args) => args[0] === 'diff')).toHaveLength(1);
  });

  it('re-reads a working-tree file whose snapshot went stale', async () => {
    const staleFile = new File([A_TXT], 'a.txt');
    Object.defineProperty(staleFile, 'arrayBuffer', {
      value: () => Promise.reject(new Error('NotReadableError: the file changed')),
    });
    const { engine } = await openEngine(runAlways({ 'rev-list HEAD': runOk(HEAD_HASH) }), {
      walked: [{ path: 'a.txt', file: staleFile }],
    });
    engine.setFileSupplier(() =>
      Promise.resolve([{ path: 'a.txt', file: new File(['CHANGED\n'], 'a.txt') }]),
    );

    const blob = await engine.blob('a.txt', 'working');

    expect(blob.kind).toBe('bytes');
    expect(new TextDecoder().decode(blob.kind === 'bytes' ? blob.bytes : new Uint8Array())).toBe(
      'CHANGED\n',
    );
  });
});
