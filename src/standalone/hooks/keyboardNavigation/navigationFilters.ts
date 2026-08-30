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

export function createNavigationFilters(
  files: DiffFile[],
  commentIndex: Map<string, CommentNavigationItem[]>,
  getViewMode: (fileIndex: number) => ViewMode,
  reviewedFiles?: Set<string>,
) {
  return {
    line: (pos: CursorPosition): boolean => {
      const file = files[pos.fileIndex];
      if (!file) return false;

      if (reviewedFiles?.has(file.path)) return false;

      if (getViewMode(pos.fileIndex) === 'unified') return true;

      // Full mode renders only the new file; deleted lines (no newLineNumber) have no row to land on
      if (getViewMode(pos.fileIndex) === 'full') {
        return file.chunks[pos.chunkIndex]?.lines[pos.lineIndex]?.newLineNumber !== undefined;
      }

      return hasContentOnSide(pos, files);
    },

    chunk: (pos: CursorPosition): boolean => {
      const file = files[pos.fileIndex];
      if (!file) return false;

      if (reviewedFiles?.has(file.path)) return false;

      const line = file.chunks[pos.chunkIndex]?.lines[pos.lineIndex];
      if (!line || line.type === 'normal') return false;

      if (getViewMode(pos.fileIndex) === 'full') {
        // Deleted lines aren't rendered in full mode, so a changed region begins at its first line in the new file
        if (line.newLineNumber === undefined) return false;
        if (pos.lineIndex === 0) return true;
        const prevLine = file.chunks[pos.chunkIndex]?.lines[pos.lineIndex - 1];
        return !prevLine || prevLine.type === 'normal' || prevLine.newLineNumber === undefined;
      }

      if (pos.lineIndex === 0) return true;

      const prevLine = file.chunks[pos.chunkIndex]?.lines[pos.lineIndex - 1];
      return !prevLine || prevLine.type === 'normal';
    },

    comment: (pos: CursorPosition): boolean => {
      const file = files[pos.fileIndex];
      if (!file) return false;

      if (reviewedFiles?.has(file.path)) return false;

      const line = file.chunks[pos.chunkIndex]?.lines[pos.lineIndex];
      if (!line) return false;

      // In full mode, only threads anchored to lines of the new file are visible
      if (getViewMode(pos.fileIndex) === 'full' && line.newLineNumber === undefined) {
        return false;
      }

      return hasCommentAtPosition(file.path, line, commentIndex);
    },

    file: (pos: CursorPosition): boolean => {
      return pos.chunkIndex === 0 && pos.lineIndex === 0;
    },
  };
}
