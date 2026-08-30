import { describe, expect, it } from 'bun:test';

import { type DiffFile, type Narration } from '../../types/diff';
import { buildChangesetFingerprint, orderFilesByNarration } from './narrationFingerprint';

const createFile = (path: string, content = 'same'): DiffFile => ({
  path,
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
        { type: 'delete', content: 'old', oldLineNumber: 1 },
        { type: 'add', content, newLineNumber: 1 },
      ],
    },
  ],
});

describe('buildChangesetFingerprint', () => {
  it('is stable across file orderings', () => {
    const left = buildChangesetFingerprint('main...feature', [
      createFile('a.ts'),
      createFile('b.ts'),
    ]);
    const right = buildChangesetFingerprint('main...feature', [
      createFile('b.ts'),
      createFile('a.ts'),
    ]);

    expect(left).toBe(right);
  });

  it('changes when a file diff changes', () => {
    const before = buildChangesetFingerprint('main...feature', [createFile('a.ts', 'one')]);
    const after = buildChangesetFingerprint('main...feature', [createFile('a.ts', 'two')]);

    expect(before).not.toBe(after);
  });

  it('changes when the commit label or file list changes', () => {
    const base = buildChangesetFingerprint('main...feature', [createFile('a.ts')]);

    expect(buildChangesetFingerprint('main...other', [createFile('a.ts')])).not.toBe(base);
    expect(
      buildChangesetFingerprint('main...feature', [createFile('a.ts'), createFile('b.ts')]),
    ).not.toBe(base);
  });
});

describe('orderFilesByNarration', () => {
  const narration: Narration = {
    intro: 'intro',
    epilogue: 'epilogue',
    cards: [
      { path: 'z-last.ts', narrative: 'start here' },
      { path: 'a-first.ts', narrative: 'then this' },
    ],
  };

  it('reorders files into the narration card order', () => {
    const ordered = orderFilesByNarration(
      [createFile('a-first.ts'), createFile('m-middle.ts'), createFile('z-last.ts')],
      narration,
    );

    expect(ordered.map((file) => file.path)).toEqual(['z-last.ts', 'a-first.ts', 'm-middle.ts']);
  });

  it('appends files the narration omits and drops unknown cards', () => {
    const ordered = orderFilesByNarration([createFile('a-first.ts'), createFile('z-last.ts')], {
      ...narration,
      cards: [...narration.cards, { path: 'not-in-changeset.ts', narrative: 'x' }],
    });

    expect(ordered.map((file) => file.path)).toEqual(['z-last.ts', 'a-first.ts']);
  });
});
