import { type DiffFile } from '../types/diff';
import { buildFileSection, formatChangedFileList } from './explainPrompt';

// Whole-changeset budget (~250k tokens), deliberately larger than explain's
// per-file cap; the server rejects larger payloads and the client disables the
// narrated-view toggle up front at the same threshold.
export const NARRATE_PROMPT_MAX_BYTES = 1024 * 1024;

/** Default narration model; owners override it with DIFFOPS_NARRATE_MODEL. */
export const DEFAULT_NARRATE_MODEL = 'anthropic/claude-opus-5';

export interface NarratePromptContext {
  files: DiffFile[];
  commitLabel?: string;
}

const textEncoder = new TextEncoder();

export function measureNarratePromptBytes(prompt: string): number {
  return textEncoder.encode(prompt).length;
}

const NARRATION_INSTRUCTIONS = [
  'You are preparing a guided review of the complete changeset below.',
  'Decide the order in which a reviewer should read the changed files to build',
  'understanding progressively, then produce:',
  '',
  '- an intro: what this changeset tries to do overall and where to start;',
  '- one card per changed file, ordered as the review order: what is going on',
  '  in the file and what to watch for while reviewing it;',
  '- an epilogue: cross-cutting risks and what a human should verify manually.',
  '',
  'Rules:',
  '- Refer to changed files by their exact path from the list below — exact',
  '  paths become clickable links for the reviewer; anything else stays plain.',
  '- Cards are connective tissue, not essays: a few sentences each.',
  '- Do not justify the order; the card position already says it.',
  '- Markdown is allowed.',
].join('\n');

/** Builds the whole-changeset narration prompt from every file's diff. */
export function buildNarratePrompt(context: NarratePromptContext): string {
  const header = context.commitLabel ? `Revision range: ${context.commitLabel}\n` : '';
  const changesetContext = [
    '## Changeset',
    header + `Changed files (${context.files.length}):`,
    formatChangedFileList(context.files),
  ].join('\n');

  return [
    NARRATION_INSTRUCTIONS,
    '',
    changesetContext,
    '',
    context.files.map(buildFileSection).join('\n\n'),
  ].join('\n');
}
