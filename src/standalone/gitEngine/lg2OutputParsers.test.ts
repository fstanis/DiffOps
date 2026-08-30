import { describe, expect, it } from 'bun:test';

import { buildGitIndex } from './fakeGitWorkerClient';
import {
  findBlockingIndexExtension,
  findUnsupportedIndexEntries,
  parseGitIndex,
  parseHeadRef,
  parseLg2ForEachRef,
  parseLg2Log,
  parseLooseObjectHeader,
  parseOriginHeadRef,
  parseTrackedWorktreePaths,
} from './lg2OutputParsers';

const COMMIT_A = '5a29ad326040fd305c942e461bc78c8c642e5812';
const COMMIT_B = '864681f05278d072e0eae561a35858e2045330e5';

describe('parseLg2Log', () => {
  it('parses commits with their messages from the default git log format', () => {
    const stdout = [
      `commit ${COMMIT_A}`,
      'Author: P <p@example.com>',
      'Date:   Fri Aug 28 16:40:09 2026 -0400',
      '',
      '    rename it',
      '',
      `commit ${COMMIT_B}`,
      'Author: P <p@example.com>',
      'Date:   Fri Aug 28 16:40:09 2026 -0400',
      '',
      '    first',
      '',
    ].join('\n');

    expect(parseLg2Log(stdout)).toEqual([
      { hash: COMMIT_A, message: 'rename it' },
      { hash: COMMIT_B, message: 'first' },
    ]);
  });

  it('keeps multi-paragraph and multi-line messages intact', () => {
    const stdout = [
      `commit ${COMMIT_A}`,
      'Merge: abc1234 def5678',
      'Author: P <p@example.com>',
      'Date:   Fri Aug 28 16:40:09 2026 -0400',
      '',
      '    subject line',
      '',
      '    second paragraph',
      '    wrapped continuation',
      '',
    ].join('\n');

    expect(parseLg2Log(stdout)).toEqual([
      { hash: COMMIT_A, message: 'subject line\n\nsecond paragraph\nwrapped continuation' },
    ]);
  });

  it('returns no commits for empty output', () => {
    expect(parseLg2Log('')).toEqual([]);
  });
});

describe('parseLg2ForEachRef', () => {
  it('parses hash, type, and ref name per line and skips noise', () => {
    const stdout = [
      `${COMMIT_A} commit\trefs/heads/main`,
      `${COMMIT_B} commit\trefs/remotes/origin/main`,
      'warning: something irrelevant',
    ].join('\n');

    expect(parseLg2ForEachRef(stdout)).toEqual([
      { hash: COMMIT_A, type: 'commit', name: 'refs/heads/main' },
      { hash: COMMIT_B, type: 'commit', name: 'refs/remotes/origin/main' },
    ]);
  });
});

describe('parseHeadRef', () => {
  it('extracts the ref a symbolic HEAD points at', () => {
    expect(parseHeadRef('ref: refs/heads/main\n')).toBe('refs/heads/main');
  });

  it('returns null for a detached HEAD hash', () => {
    expect(parseHeadRef(`${COMMIT_A}\n`)).toBeNull();
  });
});

describe('parseOriginHeadRef', () => {
  it('extracts the origin branch name from refs/remotes/origin/HEAD', () => {
    expect(parseOriginHeadRef('ref: refs/remotes/origin/main\n')).toBe('main');
  });

  it('returns null for anything else', () => {
    expect(parseOriginHeadRef('ref: refs/heads/main\n')).toBeNull();
    expect(parseOriginHeadRef(`${COMMIT_A}\n`)).toBeNull();
  });
});

describe('parseGitIndex', () => {
  it('maps stage-0 entry paths to their blob shas', () => {
    const shaA = 'a'.repeat(40);
    const shaB = '0123456789abcdef0123456789abcdef01234567';
    const index = buildGitIndex([
      { path: 'a.txt', sha: shaA },
      { path: 'nested/dir/b.txt', sha: shaB },
    ]);

    expect(parseGitIndex(index)).toEqual(
      new Map([
        ['a.txt', shaA],
        ['nested/dir/b.txt', shaB],
      ]),
    );
  });

  it('parses index v4 prefix-compressed paths', () => {
    const shaA = 'a'.repeat(40);
    const shaB = '0'.repeat(40);
    const index = buildGitIndex(
      [
        { path: 'src/commands/checkout.ts', sha: shaA },
        { path: 'src/commands/commit.ts', sha: shaB },
        { path: 'src/index.ts', sha: shaA },
      ],
      { version: 4 },
    );

    expect(parseGitIndex(index)).toEqual(
      new Map([
        ['src/commands/checkout.ts', shaA],
        ['src/commands/commit.ts', shaB],
        ['src/index.ts', shaA],
      ]),
    );
  });

  it('parses index v4 entries whose shared prefix needs a multi-byte varint', () => {
    const sha = 'a'.repeat(40);
    const longShared = 'd'.repeat(300);
    const index = buildGitIndex(
      [
        { path: `${longShared}/first.txt`, sha },
        { path: `${longShared}/second.txt`, sha },
      ],
      { version: 4 },
    );

    expect(parseTrackedWorktreePaths(index)).toEqual([
      `${longShared}/first.txt`,
      `${longShared}/second.txt`,
    ]);
  });

  it('parses index v3 entries carrying extended flags', () => {
    const sha = 'a'.repeat(40);
    const index = buildGitIndex(
      [
        { path: 'sparse-dir/', sha, mode: 0o040000, extendedFlags: 0 },
        { path: 'regular.txt', sha },
      ],
      { version: 3, extensions: [{ signature: 'sdir', payload: new Uint8Array(1) }] },
    );

    expect(parseGitIndex(index)).toEqual(
      new Map([
        ['sparse-dir/', sha],
        ['regular.txt', sha],
      ]),
    );
    expect(findBlockingIndexExtension(index)).toBe('sdir');
  });

  it('rejects non-index files', () => {
    expect(() => parseGitIndex(new TextEncoder().encode('not an index'))).toThrow(
      'Not a git index file',
    );
  });

  it('rejects unsupported versions', () => {
    const index = buildGitIndex([{ path: 'a.txt', sha: 'a'.repeat(40) }]);
    const view = new DataView(index.buffer);
    view.setUint32(4, 5);

    expect(() => parseGitIndex(index)).toThrow('Unsupported git index version 5');
  });
});

describe('parseTrackedWorktreePaths', () => {
  it('unions conflicted stages 1-3 into one path', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const index = buildGitIndex([
      { path: 'clean.txt', sha },
      { path: 'conflicted.txt', sha, stage: 1 },
      { path: 'conflicted.txt', sha: 'a'.repeat(40), stage: 2 },
      { path: 'conflicted.txt', sha: 'b'.repeat(40), stage: 3 },
    ]);

    expect(parseTrackedWorktreePaths(index)).toEqual(['clean.txt', 'conflicted.txt']);
  });

  it('excludes gitlinks and sparse directory entries', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const index = buildGitIndex([
      { path: 'tracked.txt', sha },
      { path: 'vendor/lib', sha, mode: 0o160000 },
      { path: 'sparse/dir/', sha, mode: 0o040000, extendedFlags: 0 },
    ]);

    expect(parseTrackedWorktreePaths(index)).toEqual(['tracked.txt']);
  });

  it('keeps symlinks in the tracked set', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const index = buildGitIndex([{ path: 'link', sha, mode: 0o120000 }]);

    expect(parseTrackedWorktreePaths(index)).toEqual(['link']);
  });
});

describe('findBlockingIndexExtension', () => {
  it('detects a split index link extension', () => {
    const index = buildGitIndex([{ path: 'a.txt', sha: 'a'.repeat(40) }], {
      extensions: [{ signature: 'link', payload: new Uint8Array(20) }],
    });

    expect(findBlockingIndexExtension(index)).toBe('link');
  });

  it('detects a sparse index sdir extension', () => {
    const index = buildGitIndex([{ path: 'a.txt', sha: 'a'.repeat(40) }], {
      extensions: [{ signature: 'sdir', payload: new Uint8Array(1) }],
    });

    expect(findBlockingIndexExtension(index)).toBe('sdir');
  });

  it('ignores the extensions a healthy index carries', () => {
    const index = buildGitIndex([{ path: 'a.txt', sha: 'a'.repeat(40) }], {
      extensions: [
        { signature: 'UNTR', payload: new Uint8Array(32) },
        { signature: 'TREE', payload: new Uint8Array(8) },
      ],
    });

    expect(findBlockingIndexExtension(index)).toBeNull();
  });
});

describe('findUnsupportedIndexEntries', () => {
  it('finds symlinks and gitlinks while ignoring regular and executable files', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const index = buildGitIndex([
      { path: 'a.txt', sha },
      { path: 'run.sh', sha, mode: 0o100755 },
      { path: 'plain-link', sha, mode: 0o120000 },
      { path: 'nested/link', sha, mode: 0o120000 },
      { path: 'vendor/lib', sha, mode: 0o160000 },
    ]);

    expect(findUnsupportedIndexEntries(index)).toEqual({
      symlinkPaths: ['plain-link', 'nested/link'],
      gitlinkPaths: ['vendor/lib'],
    });
  });

  it('returns empty lists for an ordinary repository', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const index = buildGitIndex([{ path: 'a.txt', sha }]);

    expect(findUnsupportedIndexEntries(index)).toEqual({
      symlinkPaths: [],
      gitlinkPaths: [],
    });
  });
});

describe('parseLooseObjectHeader', () => {
  it('locates type, size, and content start', () => {
    const content = new TextEncoder().encode('\0\x01\x02binary');
    const header = new TextEncoder().encode('blob 9\0');
    const store = new Uint8Array(header.byteLength + content.byteLength);
    store.set(header);
    store.set(content, header.byteLength);

    expect(parseLooseObjectHeader(store)).toEqual({
      type: 'blob',
      size: 9,
      contentStart: header.byteLength,
    });
  });

  it('throws for a malformed header', () => {
    expect(() => parseLooseObjectHeader(new TextEncoder().encode('blob'))).toThrow(
      'Malformed loose object',
    );
  });
});
