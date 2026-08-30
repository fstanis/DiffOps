import { describe, expect, it } from 'bun:test';

import { type DiffChunk, type DiffFile, type DiffLine } from '../types/diff';
import {
  NARRATE_PROMPT_MAX_BYTES,
  buildNarratePrompt,
  measureNarratePromptBytes,
} from './narratePrompt';

const createLine = (type: DiffLine['type'], content: string): DiffLine => ({
  type,
  content,
  oldLineNumber: 1,
  newLineNumber: 1,
});

const createChunk = (lines: DiffLine[], header = '@@ -1,3 +1,3 @@'): DiffChunk => ({
  header,
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 3,
  lines,
});

const createFile = (overrides: Partial<DiffFile> = {}): DiffFile => ({
  path: 'src/app.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  chunks: [createChunk([createLine('add', 'change')])],
  ...overrides,
});

describe('buildNarratePrompt', () => {
  it('includes every changed file and the ordering instructions', () => {
    const files = [createFile(), createFile({ path: 'README.md' })];

    const prompt = buildNarratePrompt({ files, commitLabel: 'abc1234...def5678' });

    expect(prompt).toContain('Revision range: abc1234...def5678');
    expect(prompt).toContain('- modified: src/app.ts');
    expect(prompt).toContain('- modified: README.md');
    expect(prompt).toContain('## File: src/app.ts');
    expect(prompt).toContain('## File: README.md');
    expect(prompt).toContain('review order');
    expect(prompt).toContain('exact path');
  });

  it('omits the revision range in diff-file mode', () => {
    const prompt = buildNarratePrompt({ files: [createFile()] });

    expect(prompt).not.toContain('Revision range:');
  });
});

describe('measureNarratePromptBytes', () => {
  it('measures UTF-8 bytes, not characters', () => {
    expect(measureNarratePromptBytes('abc')).toBe(3);
    expect(measureNarratePromptBytes('éあ')).toBe(5);
  });

  it('leaves headroom for real changesets under the narrate cap', () => {
    const files = Array.from({ length: 50 }, (_, index) =>
      createFile({
        path: `src/file-${index}.ts`,
        chunks: [
          createChunk(Array.from({ length: 100 }, (_, i) => createLine('add', `line ${i}`))),
        ],
      }),
    );

    const prompt = buildNarratePrompt({ files });
    expect(measureNarratePromptBytes(prompt)).toBeLessThan(NARRATE_PROMPT_MAX_BYTES);
    expect(NARRATE_PROMPT_MAX_BYTES).toBe(1024 * 1024);
  });
});
