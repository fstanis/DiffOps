import { describe, expect, it } from 'bun:test';

import { type DiffFile } from '../../types/diff';
import { buildFileExplanationFingerprint } from './explanationFingerprint';

const createFile = (overrides: Partial<DiffFile> = {}): DiffFile => ({
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
  ...overrides,
});

describe('buildFileExplanationFingerprint', () => {
  it('is stable for identical inputs', () => {
    expect(buildFileExplanationFingerprint('abc123', createFile())).toBe(
      buildFileExplanationFingerprint('abc123', createFile()),
    );
  });

  it('moves with the commit label', () => {
    expect(buildFileExplanationFingerprint('abc123', createFile())).not.toBe(
      buildFileExplanationFingerprint('def456', createFile()),
    );
  });

  it('moves with the file path, status, rename, and diff content', () => {
    const base = buildFileExplanationFingerprint('abc123', createFile());

    expect(
      buildFileExplanationFingerprint('abc123', createFile({ path: 'src/other.ts' })),
    ).not.toBe(base);
    expect(buildFileExplanationFingerprint('abc123', createFile({ status: 'added' }))).not.toBe(
      base,
    );
    expect(
      buildFileExplanationFingerprint('abc123', createFile({ oldPath: 'src/old.ts' })),
    ).not.toBe(base);

    const changedDiff = createFile({
      chunks: [
        {
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { type: 'delete', content: 'const version = 1;', oldLineNumber: 1 },
            { type: 'add', content: 'const version = 3;', newLineNumber: 1 },
          ],
        },
      ],
    });
    expect(buildFileExplanationFingerprint('abc123', changedDiff)).not.toBe(base);
  });

  it('ignores fields outside the documented fingerprint', () => {
    expect(
      buildFileExplanationFingerprint('abc123', createFile({ additions: 99, deletions: 42 })),
    ).toBe(buildFileExplanationFingerprint('abc123', createFile()));
  });
});
