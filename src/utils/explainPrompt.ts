import { type DiffFile, type DiffLine } from '../types/diff';

// ~50k tokens; the server rejects larger payloads and the client disables the
// Explain button up front at the same threshold.
export const EXPLAIN_PROMPT_MAX_BYTES = 200 * 1024;

/** Default explain model; owners override it with DIFFOPS_EXPLAIN_MODEL. */
export const DEFAULT_EXPLAIN_MODEL = 'anthropic/claude-sonnet-5';

/** Files below this many non-empty lines are not worth a model call. */
export const MIN_EXPLAINABLE_NON_EMPTY_LINES = 20;

const textEncoder = new TextEncoder();

/** Measures a prompt in UTF-8 bytes — the unit both client and server cap. */
export function measureExplainPromptBytes(prompt: string): number {
  return textEncoder.encode(prompt).length;
}

/** Counts lines with at least one non-whitespace character. */
export function countNonEmptyLines(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (line.trim().length > 0) {
      count += 1;
    }
  }
  return count;
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

export interface WholeFileExplainPromptContext {
  path: string;
  /** The whole current version of the file. */
  content: string;
  /** Verified import targets the model may request; empty means no re-ask round. */
  candidateFiles: string[];
}

export interface ExplainSupportingFile {
  path: string;
  content: string;
}

export interface ExplainReaskPromptContext {
  path: string;
  content: string;
  supportingFiles: ExplainSupportingFile[];
}

const FILE_OUTLINE_INSTRUCTIONS = [
  'You are explaining one source file to a code reviewer who wants to understand',
  'what the file is — not what recently changed in it.',
  '',
  'Produce:',
  '- fileSummary: a few sentences on what this file does as a whole and its role.',
  "- symbols: the file's meaningful named units (functions, methods, classes, hooks,",
  '  components, significant constants) as an outline in the order a reviewer should',
  '  read them. The order carries meaning; source order is irrelevant.',
  '- Skip trivial or self-explanatory symbols entirely; keep the outline scannable.',
  '- Give most callable symbols a contract: input (what it takes, named by parameter',
  '  or in prose) and output (what it produces) — phrased the way a colleague would',
  '  explain it, not as a signature dump.',
  "- type records the symbol kind ('function' | 'method' | 'class' | 'constant' |",
  "  'other'); it is structural metadata only.",
];

const REQUEST_FILES_RULE = [
  '- If the file alone is not enough to explain it faithfully, list the additional',
  '  files you need in additionalFilesNeeded — exclusively exact paths from',
  '  "Files you may request" below. When the file is enough on its own, return an',
  '  empty list.',
];

const NO_REQUESTS_RULE = ['- The file is all you get: explain it as it is.'];

const FINAL_ROUND_RULE = [
  '- This is the final round: work with what you have — the file plus the supporting',
  '  files below — and do not request more files.',
];

const outlineInstructions = (requestRule: string[]): string =>
  [...FILE_OUTLINE_INSTRUCTIONS, ...requestRule].join('\n');

const mainFileSection = (path: string, content: string): string =>
  [`## File: ${path}`, 'The whole current version of the file:', '````', content, '````'].join(
    '\n',
  );

/** Builds the first-round whole-file prompt, optionally offering askable files. */
export function buildWholeFileExplainPrompt(context: WholeFileExplainPromptContext): string {
  const hasCandidates = context.candidateFiles.length > 0;
  const sections = [
    outlineInstructions(hasCandidates ? REQUEST_FILES_RULE : NO_REQUESTS_RULE),
    mainFileSection(context.path, context.content),
  ];
  if (hasCandidates) {
    sections.push(
      ['## Files you may request', ...context.candidateFiles.map((path) => `- ${path}`)].join('\n'),
    );
  }
  return sections.join('\n\n');
}

/** Builds the final-round prompt: the main file plus its requested supporting files. */
export function buildExplainReaskPrompt(context: ExplainReaskPromptContext): string {
  const supportingSections = context.supportingFiles.map((file) =>
    [`### ${file.path}`, '````', file.content, '````'].join('\n'),
  );

  return [
    outlineInstructions(FINAL_ROUND_RULE),
    mainFileSection(context.path, context.content),
    ['## Supporting files', ...supportingSections].join('\n\n'),
  ].join('\n\n');
}
