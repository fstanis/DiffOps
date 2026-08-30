import type { DiffFile } from '../../../types/diff';
import { getElementId } from '../../utils/navigation/domHelpers';
import { fixSide } from '../../utils/navigation/lineHelpers';

import type {
  CursorPosition,
  NavigationDirection,
  NavigationFilter,
  NavigationResult,
  ViewMode,
} from './types';

export function getStartPosition(cursor: CursorPosition | null): CursorPosition {
  return cursor || { fileIndex: 0, chunkIndex: 0, lineIndex: -1, side: 'right' };
}

function hasWrappedAround(
  current: CursorPosition,
  start: CursorPosition,
  started: boolean,
): boolean {
  return (
    started &&
    current.fileIndex === start.fileIndex &&
    current.chunkIndex === start.chunkIndex &&
    current.lineIndex === start.lineIndex
  );
}

function advancePosition(
  pos: CursorPosition,
  direction: NavigationDirection,
  files: DiffFile[],
): CursorPosition | null {
  let { fileIndex, chunkIndex, lineIndex } = pos;
  const totalFiles = files.length;
  let wrappedCount = 0;

  if (direction === 'next') {
    lineIndex++;

    while (wrappedCount < totalFiles) {
      if (files[fileIndex]?.chunks[chunkIndex]?.lines[lineIndex]) {
        return { ...pos, fileIndex, chunkIndex, lineIndex };
      }

      chunkIndex++;
      lineIndex = 0;

      if (!files[fileIndex]?.chunks[chunkIndex]) {
        fileIndex++;
        chunkIndex = 0;
        lineIndex = 0;

        if (fileIndex >= totalFiles) {
          fileIndex = 0;
          wrappedCount++;
        }
      }
    }
  } else {
    lineIndex--;

    while (wrappedCount < totalFiles) {
      if (lineIndex < 0) {
        chunkIndex--;

        if (chunkIndex < 0) {
          fileIndex--;

          if (fileIndex < 0) {
            fileIndex = totalFiles - 1;
            wrappedCount++;
          }

          const file = files[fileIndex];
          if (file && file.chunks.length > 0) {
            chunkIndex = file.chunks.length - 1;
            const chunk = file.chunks[chunkIndex];
            lineIndex = chunk && chunk.lines.length > 0 ? chunk.lines.length - 1 : -1;
          } else {
            chunkIndex = -1;
            lineIndex = -1;
          }
        } else {
          const chunk = files[fileIndex]?.chunks[chunkIndex];
          lineIndex = chunk && chunk.lines.length > 0 ? chunk.lines.length - 1 : -1;
        }
      }

      if (lineIndex >= 0 && files[fileIndex]?.chunks[chunkIndex]?.lines[lineIndex]) {
        return { ...pos, fileIndex, chunkIndex, lineIndex };
      }

      if (lineIndex < 0) {
        continue;
      }

      lineIndex--;
    }
  }

  return null;
}

export function findNextMatchingPosition(
  startPos: CursorPosition,
  direction: NavigationDirection,
  filter: NavigationFilter,
  files: DiffFile[],
  getViewMode: (fileIndex: number) => ViewMode,
): NavigationResult {
  let current: CursorPosition | null = startPos;
  let started = false;

  while (true) {
    if (!current) break;

    const nextPos = advancePosition(current, direction, files);
    if (!nextPos) break;

    current = nextPos;

    if (hasWrappedAround(current, startPos, started)) {
      break;
    }
    started = true;

    if (filter(current, files)) {
      const fixed = fixSide(current, files);
      return {
        position: fixed,
        scrollTarget: getElementId(fixed, getViewMode(fixed.fileIndex)),
      };
    }
  }

  return { position: null, scrollTarget: null };
}
