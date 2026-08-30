import { describe, expect, it } from 'bun:test';

import { type DiffChunk, type DiffFile, type DiffLine } from '../types/diff';
import {
  MIN_EXPLAINABLE_NON_EMPTY_LINES,
  buildExplainReaskPrompt,
  buildWholeFileExplainPrompt,
  countNonEmptyLines,
  EXPLAIN_PROMPT_MAX_BYTES,
  hasExplainableDiffContent,
  measureExplainPromptBytes,
} from './explainPrompt';

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
  chunks: [],
  ...overrides,
});

describe('buildWholeFileExplainPrompt', () => {
  it('wraps the whole current file content without any diff', () => {
    const prompt = buildWholeFileExplainPrompt({
      path: 'src/app.ts',
      content: 'import x from "./y";\n\nexport const x = 1;\n',
      candidateFiles: [],
    });

    expect(prompt).toContain('## File: src/app.ts');
    expect(prompt).toContain('import x from "./y";');
    expect(prompt).toContain('export const x = 1;');
    expect(prompt).not.toContain('Unified diff');
    expect(prompt).not.toContain('Revision range');
    expect(prompt).not.toContain('Changeset');
  });

  it('offers the candidate files and the request rule when candidates exist', () => {
    const prompt = buildWholeFileExplainPrompt({
      path: 'src/app.ts',
      content: 'const x = 1;',
      candidateFiles: ['src/helper.ts', 'src/util/index.ts'],
    });

    expect(prompt).toContain('## Files you may request');
    expect(prompt).toContain('- src/helper.ts');
    expect(prompt).toContain('- src/util/index.ts');
    expect(prompt).toContain('additionalFilesNeeded');
  });

  it('uses the no-request instructions when the candidate list is empty', () => {
    const prompt = buildWholeFileExplainPrompt({
      path: 'src/app.ts',
      content: 'const x = 1;',
      candidateFiles: [],
    });

    expect(prompt).not.toContain('## Files you may request');
    expect(prompt).not.toContain('additionalFilesNeeded');
    expect(prompt).toContain('The file is all you get');
  });

  it('states the outline contract: reading order, skipped trivia, natural contracts', () => {
    const prompt = buildWholeFileExplainPrompt({
      path: 'src/app.ts',
      content: 'const x = 1;',
      candidateFiles: [],
    });

    expect(prompt).toContain('order a reviewer should');
    expect(prompt).toContain('Skip trivial or self-explanatory symbols');
    expect(prompt).toContain('a colleague would');
  });
});

describe('buildExplainReaskPrompt', () => {
  it('includes the main file and every supporting file whole, labeled', () => {
    const prompt = buildExplainReaskPrompt({
      path: 'src/app.ts',
      content: 'import { helper } from "./helper";',
      supportingFiles: [
        { path: 'src/helper.ts', content: 'export const helper = 1;' },
        { path: 'src/types.ts', content: 'export type A = string;' },
      ],
    });

    expect(prompt).toContain('## File: src/app.ts');
    expect(prompt).toContain('import { helper } from "./helper";');
    expect(prompt).toContain('## Supporting files');
    expect(prompt).toContain('### src/helper.ts');
    expect(prompt).toContain('export const helper = 1;');
    expect(prompt).toContain('### src/types.ts');
    expect(prompt).toContain('export type A = string;');
  });

  it('tells the model this is the final round', () => {
    const prompt = buildExplainReaskPrompt({
      path: 'src/app.ts',
      content: 'const x = 1;',
      supportingFiles: [{ path: 'src/helper.ts', content: 'export const helper = 1;' }],
    });

    expect(prompt).toContain('final round');
    expect(prompt).toContain('do not request more files');
    expect(prompt).not.toContain('## Files you may request');
  });
});

describe('countNonEmptyLines', () => {
  it('counts only lines with non-whitespace content', () => {
    expect(countNonEmptyLines([])).toBe(0);
    expect(countNonEmptyLines([''])).toBe(0);
    expect(countNonEmptyLines(['', '   ', '\t'])).toBe(0);
    expect(countNonEmptyLines(['const a = 1;', '', '   ', 'const b = 2;'])).toBe(2);
  });

  it('gates at the documented threshold', () => {
    const lines = Array.from({ length: MIN_EXPLAINABLE_NON_EMPTY_LINES - 1 }, () => 'x');
    expect(countNonEmptyLines([...lines, '', '  '])).toBe(MIN_EXPLAINABLE_NON_EMPTY_LINES - 1);

    lines.push('one more');
    expect(countNonEmptyLines(lines)).toBe(MIN_EXPLAINABLE_NON_EMPTY_LINES);
  });
});

describe('hasExplainableDiffContent', () => {
  it('is true for a file with diff lines', () => {
    const file = createFile({ chunks: [createChunk([createLine('add', 'x')])] });
    expect(hasExplainableDiffContent(file)).toBe(true);
  });

  it('is false for files with no hunks (images and other binaries)', () => {
    const image = createFile({ path: 'assets/logo.png', status: 'modified', chunks: [] });
    const emptyChunk = createFile({ chunks: [createChunk([])] });
    expect(hasExplainableDiffContent(image)).toBe(false);
    expect(hasExplainableDiffContent(emptyChunk)).toBe(false);
  });
});

describe('measureExplainPromptBytes', () => {
  it('measures UTF-8 bytes, not characters', () => {
    expect(measureExplainPromptBytes('abc')).toBe(3);
    // 'é' is 2 bytes in UTF-8, 'あ' is 3.
    expect(measureExplainPromptBytes('éあ')).toBe(5);
  });

  it('exposes the size threshold used by both client and server', () => {
    const prompt = buildWholeFileExplainPrompt({
      path: 'src/app.ts',
      content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'),
      candidateFiles: ['src/helper.ts'],
    });

    expect(measureExplainPromptBytes(prompt)).toBeLessThan(EXPLAIN_PROMPT_MAX_BYTES);
  });
});
