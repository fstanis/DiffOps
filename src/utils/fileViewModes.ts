import type { FileViewMode } from '../types/diff.js';
import { parseFileViewMode } from './diffMode.js';

const FILE_VIEW_MODES_STORAGE_KEY = 'diffops.fileViewModes';

export type FileViewModesByPath = Record<string, FileViewMode>;

/** Reads the persisted per-file view-mode selections, dropping unrecognized values. */
export function loadFileViewModes(): FileViewModesByPath {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(FILE_VIEW_MODES_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    const modes: FileViewModesByPath = {};
    for (const [path, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        continue;
      }
      const mode = parseFileViewMode(value);
      if (mode) {
        modes[path] = mode;
      }
    }
    return modes;
  } catch {
    return {};
  }
}

/** Persists the per-file view-mode selections; storage failures are ignored. */
export function saveFileViewModes(modes: FileViewModesByPath): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(FILE_VIEW_MODES_STORAGE_KEY, JSON.stringify(modes));
  } catch {
    // ignore
  }
}
