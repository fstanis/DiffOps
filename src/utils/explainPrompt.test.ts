import { describe, expect, it } from 'bun:test';

import { type DiffChunk, type DiffFile, type DiffLine } from '../types/diff';
import {
  buildExplainPrompt,
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

describe('buildExplainPrompt', () => {
  it('includes the changeset header with revision range and changed file list', () => {
    const file = createFile({
      chunks: [createChunk([createLine('normal', 'shared')])],
    });
    const allFiles = [
      file,
      createFile({ path: 'src/new.ts', status: 'added' }),
      createFile({ path: 'src/gone.ts', status: 'deleted' }),
      createFile({ path: 'src/moved.ts', status: 'renamed', oldPath: 'src/old.ts' }),
    ];

    const prompt = buildExplainPrompt({ file, allFiles, commitLabel: 'abc1234...def5678' });

    expect(prompt).toContain('Revision range: abc1234...def5678');
    expect(prompt).toContain('- modified: src/app.ts');
    expect(prompt).toContain('- added: src/new.ts');
    expect(prompt).toContain('- deleted: src/gone.ts');
    expect(prompt).toContain('- renamed: src/old.ts -> src/moved.ts');
  });

  it('omits the revision range when no commit label is available', () => {
    const file = createFile({
      chunks: [createChunk([createLine('normal', 'shared')])],
    });

    const prompt = buildExplainPrompt({ file, allFiles: [file] });

    expect(prompt).not.toContain('Revision range:');
  });

  it('reconstructs the unified diff for a modified file with hunk headers and prefixes', () => {
    const file = createFile({
      chunks: [
        createChunk(
          [
            createLine('normal', 'context line'),
            createLine('delete', 'old line'),
            createLine('add', 'new line'),
          ],
          '@@ -10,7 +10,8 @@ function hello()',
        ),
      ],
    });

    const prompt = buildExplainPrompt({ file, allFiles: [file] });

    expect(prompt).toContain('## File: src/app.ts (modified)');
    expect(prompt).toContain('Unified diff of the change:');
    expect(prompt).toContain(
      ['@@ -10,7 +10,8 @@ function hello()', ' context line', '-old line', '+new line'].join('\n'),
    );
  });

  it('joins multiple hunks for a modified file', () => {
    const file = createFile({
      chunks: [
        createChunk([createLine('add', 'first')], '@@ -1,1 +1,1 @@'),
        createChunk([createLine('add', 'second')], '@@ -20,1 +20,1 @@'),
      ],
    });

    const prompt = buildExplainPrompt({ file, allFiles: [file] });

    expect(prompt).toContain(['@@ -1,1 +1,1 @@', '+first'].join('\n'));
    expect(prompt).toContain(['@@ -20,1 +20,1 @@', '+second'].join('\n'));
  });

  it('reconstructs the whole file content for an added file', () => {
    const file = createFile({
      status: 'added',
      chunks: [
        createChunk(
          [
            createLine('add', 'import x from "y";'),
            createLine('add', ''),
            createLine('add', 'export const x = 1;'),
          ],
          '@@ -0,0 +1,3 @@',
        ),
      ],
    });

    const prompt = buildExplainPrompt({ file, allFiles: [file] });

    expect(prompt).toContain('## File: src/app.ts (added)');
    expect(prompt).toContain('Full content of the new file:');
    expect(prompt).toContain(['import x from "y";', '', 'export const x = 1;'].join('\n'));
    expect(prompt).not.toContain('+import x from "y";');
  });

  it('includes the rename note and the change beyond the rename for a renamed file', () => {
    const file = createFile({
      status: 'renamed',
      oldPath: 'src/old-name.ts',
      path: 'src/new-name.ts',
      chunks: [createChunk([createLine('normal', 'same'), createLine('add', 'extra')])],
    });

    const prompt = buildExplainPrompt({ file, allFiles: [file] });

    expect(prompt).toContain('## File: src/new-name.ts (renamed from src/old-name.ts)');
    expect(prompt).toContain(' same');
    expect(prompt).toContain('+extra');
  });

  it('renders the deletion diff for a deleted file', () => {
    const file = createFile({
      status: 'deleted',
      chunks: [
        createChunk(
          [createLine('delete', 'removed capability'), createLine('delete', 'second line')],
          '@@ -1,2 +0,0 @@',
        ),
      ],
    });

    const prompt = buildExplainPrompt({ file, allFiles: [file] });

    expect(prompt).toContain('## File: src/app.ts (deleted)');
    expect(prompt).toContain('Unified diff of the deletion:');
    expect(prompt).toContain(['@@ -1,2 +0,0 @@', '-removed capability', '-second line'].join('\n'));
  });

  it('ends with the short-output instruction', () => {
    const file = createFile({
      chunks: [createChunk([createLine('normal', 'shared')])],
    });

    const prompt = buildExplainPrompt({ file, allFiles: [file] });

    expect(prompt).toContain('Keep the explanation short');
    expect(prompt).toContain('Markdown is allowed');
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
    const file = createFile({
      chunks: [createChunk(Array.from({ length: 100 }, (_, i) => createLine('add', `line ${i}`)))],
    });
    const prompt = buildExplainPrompt({ file, allFiles: [file] });

    expect(measureExplainPromptBytes(prompt)).toBeLessThan(EXPLAIN_PROMPT_MAX_BYTES);
  });
});
