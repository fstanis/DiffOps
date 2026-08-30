import { type DiffFile, type DiffLine } from '../types/diff';

// ~50k tokens; the server rejects larger payloads and the client disables the
// Explain button up front at the same threshold.
export const EXPLAIN_PROMPT_MAX_BYTES = 200 * 1024;

/** Default explain model; owners override it with DIFFOPS_EXPLAIN_MODEL. */
export const DEFAULT_EXPLAIN_MODEL = 'anthropic/claude-sonnet-5';

export interface ExplainPromptContext {
  file: DiffFile;
  allFiles: DiffFile[];
  commitLabel?: string;
}

const textEncoder = new TextEncoder();

/** Measures a prompt in UTF-8 bytes — the unit both client and server cap. */
export function measureExplainPromptBytes(prompt: string): number {
  return textEncoder.encode(prompt).length;
}

export function hasExplainableDiffContent(file: DiffFile): boolean {
  return file.chunks.some((chunk) => chunk.lines.length > 0);
}

const getDiffLinePrefix = (type: DiffLine['type']): string | null => {
  switch (type) {
    case 'add':
      return '+';
    case 'delete':
    case 'remove':
      return '-';
    case 'normal':
    case 'context':
      return ' ';
    default:
      return null;
  }
};

// Rebuilds a unified diff from the parsed hunks. Line content is stored
// prefix-stripped, so +/-/space prefixes are restored here.
function buildUnifiedDiff(file: DiffFile): string {
  return file.chunks
    .map((chunk) => {
      const lines = chunk.lines
        .map((line) => {
          const prefix = getDiffLinePrefix(line.type);
          return prefix === null ? null : `${prefix}${line.content}`;
        })
        .filter((line): line is string => line !== null);
      return [chunk.header, ...lines].join('\n');
    })
    .filter((chunkDiff) => chunkDiff.length > 0)
    .join('\n');
}

// Reconstructs the full new-file content from the hunks of an added file:
// added and context lines, minus their diff prefixes.
function buildNewFileContent(file: DiffFile): string {
  return file.chunks
    .flatMap((chunk) =>
      chunk.lines
        .filter((line) => {
          const prefix = getDiffLinePrefix(line.type);
          return prefix !== null && prefix !== '-';
        })
        .map((line) => line.content),
    )
    .join('\n');
}

/** Lists the changeset's files with status and rename notes, one `- ` line each. */
export const formatChangedFileList = (files: DiffFile[]): string =>
  files
    .map((file) => {
      if (file.status === 'renamed' && file.oldPath && file.oldPath !== file.path) {
        return `- renamed: ${file.oldPath} -> ${file.path}`;
      }
      return `- ${file.status}: ${file.path}`;
    })
    .join('\n');

function buildChangesetHeader(context: ExplainPromptContext): string {
  const lines = ['## Changeset context'];
  if (context.commitLabel) {
    lines.push(`Revision range: ${context.commitLabel}`);
  }
  lines.push('Changed files in this changeset:', formatChangedFileList(context.allFiles));
  return lines.join('\n');
}

/** Formats one changed file's diff as a titled markdown section for prompts. */
export function buildFileSection(file: DiffFile): string {
  const statusSuffix =
    file.status === 'renamed' && file.oldPath && file.oldPath !== file.path
      ? ` (renamed from ${file.oldPath})`
      : ` (${file.status})`;

  if (file.status === 'added') {
    return [
      `## File: ${file.path} (added)`,
      'This file is new. Full content of the new file:',
      '````',
      buildNewFileContent(file),
      '````',
    ].join('\n');
  }

  if (file.status === 'deleted') {
    return [
      `## File: ${file.path} (deleted)`,
      'This file is being deleted. Unified diff of the deletion:',
      '````',
      buildUnifiedDiff(file),
      '````',
    ].join('\n');
  }

  return [
    `## File: ${file.path}${statusSuffix}`,
    'Unified diff of the change:',
    '````',
    buildUnifiedDiff(file),
    '````',
  ].join('\n');
}

export function buildExplainPrompt(context: ExplainPromptContext): string {
  return [
    'Explain the change to the file below for a code reviewer.',
    '',
    buildChangesetHeader(context),
    '',
    buildFileSection(context.file),
    '',
    'Keep the explanation short — a few sentences or a tight bullet list. ' +
      'Focus on what the change does and, where the other changed files clarify ' +
      'it, how it fits into the rest of the changeset. Markdown is allowed.',
  ].join('\n');
}
