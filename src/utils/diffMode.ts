import type { DiffViewMode, FileViewMode } from '../types/diff.js';

export const DEFAULT_DIFF_VIEW_MODE: DiffViewMode = 'unified';
/** @alias */
export const DEFAULT_FILE_VIEW_MODE: FileViewMode = DEFAULT_DIFF_VIEW_MODE;

export function normalizeDiffViewMode(mode?: string | null): DiffViewMode {
  switch (mode) {
    case 'split':
    case 'side-by-side':
      return 'split';
    case 'unified':
    case 'inline':
      return 'unified';
    case 'full':
    case 'current':
      // "current" is the pre-rework name of the whole-new-file view
      return 'full';
    default:
      return DEFAULT_DIFF_VIEW_MODE;
  }
}

/** Parses a persisted per-file view mode, returning null for unrecognized values. */
export function parseFileViewMode(mode?: string | null): FileViewMode | null {
  switch (mode) {
    case 'split':
    case 'unified':
    case 'full':
    case 'diff-preview':
    case 'full-preview':
      return mode;
    case 'current':
      return 'full';
    case 'diff':
      // The markdown viewers' old "diff" tab followed the global split/unified mode
      return 'unified';
    case 'side-by-side':
      return 'split';
    case 'inline':
      return 'unified';
    default:
      return null;
  }
}

export function normalizeFileViewMode(mode?: string | null): FileViewMode {
  return parseFileViewMode(mode) ?? DEFAULT_FILE_VIEW_MODE;
}
