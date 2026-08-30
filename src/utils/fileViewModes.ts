import type { FileViewMode } from '../types/diff.js';
import { parseFileViewMode } from './diffMode.js';

const FILE_VIEW_MODES_STORAGE_PREFIX = 'diffops.fileViewModes';

export type FileViewModesByPath = Record<string, FileViewMode>;

// Scoped per repository so two repositories sharing a file path do not share its mode.
const storageKey = (repositoryId: string): string =>
  `${FILE_VIEW_MODES_STORAGE_PREFIX}:${repositoryId}`;

/** Reads a repository's persisted per-file view modes, dropping unrecognized values. */
export function loadFileViewModes(repositoryId: string): FileViewModesByPath {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(storageKey(repositoryId));
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

/** Persists a repository's per-file view modes; storage failures are ignored. */
export function saveFileViewModes(repositoryId: string, modes: FileViewModesByPath): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(storageKey(repositoryId), JSON.stringify(modes));
  } catch {
    // ignore
  }
}
