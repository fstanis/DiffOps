import { describe, expect, it } from 'bun:test';

import {
  queryReadPermission,
  requestReadPermission,
  walkDirectoryHandle,
  type PickedDirectoryHandle,
  type PickedFileHandle,
  type PickedHandle,
} from './walkDirectory';

const fileHandle = (name: string, content: string): PickedFileHandle => ({
  kind: 'file',
  name,
  getFile: () => Promise.resolve(new File([content], name)),
});

const directoryHandle = (
  name: string,
  children: PickedHandle[],
): PickedDirectoryHandle & { children: PickedHandle[] } => ({
  kind: 'directory',
  name,
  children,
  async *entries() {
    for (const child of children) {
      yield [child.name, child];
    }
  },
});

const nestedTreeFiles = (): { path: string; content: string }[] => [
  { path: 'README.md', content: '# repo\n' },
  { path: '.git/HEAD', content: 'ref: refs/heads/main\n' },
  { path: '.git/refs/heads/main', content: 'abc\n' },
  { path: 'src/app.ts', content: 'console.log(1);\n' },
];

const nestedTree = (): PickedDirectoryHandle =>
  directoryHandle('repo', [
    fileHandle('README.md', '# repo\n'),
    directoryHandle('.git', [
      fileHandle('HEAD', 'ref: refs/heads/main\n'),
      directoryHandle('refs', [directoryHandle('heads', [fileHandle('main', 'abc\n')])]),
    ]),
    directoryHandle('src', [fileHandle('app.ts', 'console.log(1);\n')]),
  ]);

describe('walkDirectoryHandle', () => {
  it('walks the tree into repo-relative paths, including .git', async () => {
    const { files, unreadablePaths } = await walkDirectoryHandle(nestedTree());

    expect(files.map(({ path }) => path).sort()).toEqual([
      '.git/HEAD',
      '.git/refs/heads/main',
      'README.md',
      'src/app.ts',
    ]);
    expect(files[0]?.file).toBeInstanceOf(File);
    expect(unreadablePaths).toEqual([]);
  });

  it('reports throttled, monotonic progress ending at the total', async () => {
    const counts: number[] = [];
    await walkDirectoryHandle(nestedTree(), {
      onProgress: (progress) => {
        counts.push(progress.filesFound);
      },
    });

    expect(counts[counts.length - 1]).toBe(4);
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]).toBeGreaterThanOrEqual(counts[index - 1] ?? 0);
    }
  });

  it('reports the walked byte total in the final progress tick', async () => {
    const ticks: { filesFound: number; bytesFound: number }[] = [];
    await walkDirectoryHandle(nestedTree(), {
      onProgress: (progress) => {
        ticks.push(progress);
      },
    });

    const finalTick = ticks[ticks.length - 1];
    expect(finalTick?.filesFound).toBe(4);
    expect(finalTick?.bytesFound).toBe(
      nestedTreeFiles().reduce((total, { content }) => total + content.length, 0),
    );
  });

  it('reads files within a directory concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowFile = (name: string): PickedFileHandle => ({
      kind: 'file',
      name,
      getFile: () =>
        new Promise<File>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve(new File(['x'], name));
          }, 10);
        }),
    });
    const wide = directoryHandle('repo', [
      slowFile('a.txt'),
      slowFile('b.txt'),
      slowFile('c.txt'),
      slowFile('d.txt'),
    ]);

    await walkDirectoryHandle(wide);

    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('walks an empty folder to nothing', async () => {
    const result = await walkDirectoryHandle(directoryHandle('empty', []));
    expect(result.files).toEqual([]);
    expect(result.unreadablePaths).toEqual([]);
  });

  it('collects unreadable files instead of failing the walk', async () => {
    const brokenFile = (name: string): PickedFileHandle => ({
      kind: 'file',
      name,
      getFile: () => Promise.reject(new Error('gone')),
    });
    const tree = directoryHandle('repo', [
      fileHandle('ok.txt', 'fine\n'),
      brokenFile('vanished.txt'),
      directoryHandle('sub', [brokenFile('also-gone.txt'), fileHandle('kept.txt', 'kept\n')]),
    ]);

    const { files, unreadablePaths } = await walkDirectoryHandle(tree);

    expect(files.map(({ path }) => path).sort()).toEqual(['ok.txt', 'sub/kept.txt']);
    expect(unreadablePaths.sort()).toEqual(['sub/also-gone.txt', 'vanished.txt']);
  });

  it('collects a directory whose entries cannot be listed', async () => {
    const brokenDir: PickedDirectoryHandle = {
      kind: 'directory',
      name: 'locked',
      entries: () => {
        throw new Error('permission denied');
      },
    };
    const tree = directoryHandle('repo', [fileHandle('ok.txt', 'fine\n'), brokenDir]);

    const { files, unreadablePaths } = await walkDirectoryHandle(tree);

    expect(files.map(({ path }) => path)).toEqual(['ok.txt']);
    expect(unreadablePaths).toEqual(['locked']);
  });

  it('prunes skipped directories without enumerating them', async () => {
    const nodeModules: PickedDirectoryHandle = {
      kind: 'directory',
      name: 'node_modules',
      entries: () => {
        throw new Error('entries() must not be called on a pruned directory');
      },
    };
    const tree = directoryHandle('repo', [
      fileHandle('kept.txt', 'kept\n'),
      nodeModules,
      directoryHandle('src', [fileHandle('app.ts', 'app\n')]),
    ]);

    const { files, unreadablePaths } = await walkDirectoryHandle(tree, {
      shouldDescend: (path) => path !== 'node_modules',
    });

    expect(files.map(({ path }) => path).sort()).toEqual(['kept.txt', 'src/app.ts']);
    expect(unreadablePaths).toEqual([]);
  });

  it('skips taking handles for filtered files but still reports progress for the rest', async () => {
    const tree = directoryHandle('repo', [
      fileHandle('tracked.txt', 'yes\n'),
      fileHandle('ignored.log', 'no\n'),
    ]);
    const finalCounts: number[] = [];

    const { files } = await walkDirectoryHandle(tree, {
      shouldTake: (path) => path !== 'ignored.log',
      onProgress: (progress) => {
        finalCounts.push(progress.filesFound);
      },
    });

    expect(files.map(({ path }) => path)).toEqual(['tracked.txt']);
    expect(finalCounts[finalCounts.length - 1]).toBe(1);
  });

  it('hands descended directory handles to onDirectory', async () => {
    const seen = new Map<string, string>();
    const tree = nestedTree();

    await walkDirectoryHandle(tree, {
      onDirectory: (path, handle) => {
        seen.set(path, handle.name);
      },
    });

    expect([...seen.keys()].sort()).toEqual(['.git', '.git/refs', '.git/refs/heads', 'src']);
    expect(seen.get('.git/refs/heads')).toBe('heads');
  });
});

describe('permission helpers', () => {
  it('queries and requests read permission through the handle', async () => {
    let requestedMode = '';
    const handle = directoryHandle('repo', []);
    handle.queryPermission = async (descriptor) => {
      requestedMode = descriptor.mode;
      return 'prompt' as PermissionState;
    };
    handle.requestPermission = async () => 'granted' as PermissionState;

    expect(await queryReadPermission(handle)).toBe('prompt');
    expect(await requestReadPermission(handle)).toBe('granted');
    expect(requestedMode).toBe('read');
  });

  it('treats handles without permission APIs as granted', async () => {
    const handle = directoryHandle('repo', []);
    expect(await queryReadPermission(handle)).toBe('granted');
    expect(await requestReadPermission(handle)).toBe('granted');
  });
});
