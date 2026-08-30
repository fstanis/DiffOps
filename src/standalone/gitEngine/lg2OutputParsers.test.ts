import { describe, expect, it } from 'bun:test';

import { buildGitIndex } from './fakeGitWorkerClient';
import {
  findUnsupportedIndexEntries,
  parseGitIndex,
  parseHeadRef,
  parseLg2ForEachRef,
  parseLg2Log,
  parseLooseObjectHeader,
  parseOriginHeadRef,
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

  it('rejects non-index files', () => {
    expect(() => parseGitIndex(new TextEncoder().encode('not an index'))).toThrow(
      'Not a git index file',
    );
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
