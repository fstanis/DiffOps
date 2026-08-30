import type { DiffFile } from '../../../types/diff';
import { getCommentKey } from '../../utils/navigation/domHelpers';
import { hasContentOnSide } from '../../utils/navigation/lineHelpers';

import type { CommentNavigationItem, CursorPosition, ViewMode } from './types';

function hasCommentAtPosition(
  filePath: string,
  line: DiffFile['chunks'][number]['lines'][number],
  commentIndex: Map<string, CommentNavigationItem[]>,
): boolean {
  const keys: string[] = [];

  if (line.oldLineNumber !== undefined) {
    keys.push(getCommentKey(filePath, line.oldLineNumber, 'old'));
    keys.push(getCommentKey(filePath, line.oldLineNumber));
  }

  if (line.newLineNumber !== undefined) {
    keys.push(getCommentKey(filePath, line.newLineNumber, 'new'));
    keys.push(getCommentKey(filePath, line.newLineNumber));
  }

  return keys.some((key) => commentIndex.has(key));
}

/**
 * Creates navigation filters for different navigation targets
 */
export function createNavigationFilters(
  files: DiffFile[],
  commentIndex: Map<string, CommentNavigationItem[]>,
  viewMode: ViewMode,
  reviewedFiles?: Set<string>,
) {
  return {
    /**
     * Line navigation - navigates to lines with content on the current side
     * In unified mode, all lines are navigable
     * In split mode, only lines with content on the current side
     * Skip lines in reviewed/collapsed files
     */
    line: (pos: CursorPosition): boolean => {
      const file = files[pos.fileIndex];
      if (!file) return false;

      // Skip if file is reviewed/collapsed
      if (reviewedFiles?.has(file.path)) return false;

      if (viewMode === 'unified') return true;

      // Current mode renders only the new file, so lines without a new line
      // number (deleted lines) have no row to land on
      if (viewMode === 'current') {
        return file.chunks[pos.chunkIndex]?.lines[pos.lineIndex]?.newLineNumber !== undefined;
      }

      return hasContentOnSide(pos, files);
    },

    /**
     * Chunk navigation - navigates to the first line of each change chunk
     * Skips normal (unchanged) lines and finds boundaries between chunks
     * Skip chunks in reviewed/collapsed files
     */
    chunk: (pos: CursorPosition): boolean => {
      const file = files[pos.fileIndex];
      if (!file) return false;

      // Skip if file is reviewed/collapsed
      if (reviewedFiles?.has(file.path)) return false;

      const line = file.chunks[pos.chunkIndex]?.lines[pos.lineIndex];
      if (!line || line.type === 'normal') return false;

      if (viewMode === 'current') {
        // Deleted lines are not rendered in current mode, so a changed region
        // begins at its first line that exists in the new file
        if (line.newLineNumber === undefined) return false;
        if (pos.lineIndex === 0) return true;
        const prevLine = file.chunks[pos.chunkIndex]?.lines[pos.lineIndex - 1];
        return !prevLine || prevLine.type === 'normal' || prevLine.newLineNumber === undefined;
      }

      // First line of a chunk is always a chunk boundary
      if (pos.lineIndex === 0) return true;

      // Check if previous line is normal (indicating start of a change chunk)
      const prevLine = file.chunks[pos.chunkIndex]?.lines[pos.lineIndex - 1];
      return !prevLine || prevLine.type === 'normal';
    },

    /**
     * Comment navigation - navigates to lines that have comments
     * Skip comments in reviewed/collapsed files
     */
    comment: (pos: CursorPosition): boolean => {
      const file = files[pos.fileIndex];
      if (!file) return false;

      // Skip if file is reviewed/collapsed
      if (reviewedFiles?.has(file.path)) return false;

      const line = file.chunks[pos.chunkIndex]?.lines[pos.lineIndex];
      if (!line) return false;

      // In current mode, only threads anchored to lines of the new file are
      // visible
      if (viewMode === 'current' && line.newLineNumber === undefined) return false;

      return hasCommentAtPosition(file.path, line, commentIndex);
    },

    /**
     * File navigation - navigates to the first line of each file
     */
    file: (pos: CursorPosition): boolean => {
      return pos.chunkIndex === 0 && pos.lineIndex === 0;
    },
  };
}
