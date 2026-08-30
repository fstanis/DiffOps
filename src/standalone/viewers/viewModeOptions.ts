import type { DiffFile, FileViewMode } from '../../types/diff';

import { getViewerForFile } from './registry';

const DIFF_MODES: FileViewMode[] = ['unified', 'split'];
const PREVIEW_MODES: FileViewMode[] = ['diff-preview', 'full-preview'];

/**
 * The view modes worth offering for a file, in tab order. An added file's diff
 * is the whole file, so it is read as a file rather than as a diff, and its
 * diff preview would render exactly what the full preview renders. A deleted
 * file has no new side for the full views.
 */
const getFileViewModeOptions = (file: DiffFile): FileViewMode[] => {
  const { supportsPreview } = getViewerForFile(file);
  if (file.status === 'added') {
    return supportsPreview ? ['full', 'full-preview'] : ['full'];
  }
  const previewModes = supportsPreview ? PREVIEW_MODES : [];
  if (file.status === 'deleted') {
    return [...DIFF_MODES, ...previewModes];
  }
  return [...DIFF_MODES, 'full', ...previewModes];
};

export interface FileViewModeResolution {
  /** The file's options that stay readable at the current viewport width. */
  selectableModes: FileViewMode[];
  /** The stored preference when this file offers it, else the file's default. */
  mode: FileViewMode;
}

/**
 * Resolves what to render for a file: its own first offered mode stands in
 * whenever the stored preference is not on offer. Split and the diff gutters
 * are unreadable below the mobile breakpoint, so only the previews stay
 * selectable there.
 */
export const resolveFileViewMode = (
  file: DiffFile,
  storedMode: FileViewMode,
  isNarrowViewport: boolean,
): FileViewModeResolution => {
  const options = getFileViewModeOptions(file);
  const selectableModes = isNarrowViewport
    ? options.filter((mode) => PREVIEW_MODES.includes(mode))
    : options;
  const defaultMode = options[0] as FileViewMode;

  return {
    selectableModes,
    mode: selectableModes.includes(storedMode) ? storedMode : defaultMode,
  };
};
