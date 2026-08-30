import type { DiffSide } from '../../../types/diff';
import type { CursorPosition, ViewMode } from '../../hooks/keyboardNavigation/types';

/** Format: file-{fileIndex}-chunk-{chunkIndex}-line-{lineIndex}[-{side}] */
export function getElementId(position: CursorPosition, viewMode: ViewMode): string {
  const baseId = `file-${position.fileIndex}-chunk-${position.chunkIndex}-line-${position.lineIndex}`;
  return viewMode === 'split' ? `${baseId}-${position.side}` : baseId;
}

const ELEMENT_ID_PATTERN = /^file-(\d+)-chunk-(\d+)-line-(\d+)(?:-(?:left|right))?$/;

/** Reverses getElementId's format, e.g. to find which chunk a not-yet-mounted (virtualized) line belongs to. */
export function parseElementId(
  elementId: string,
): { fileIndex: number; chunkIndex: number; lineIndex: number } | null {
  const match = ELEMENT_ID_PATTERN.exec(elementId);
  if (!match) return null;

  const [, fileIndex, chunkIndex, lineIndex] = match;
  return {
    fileIndex: Number(fileIndex),
    chunkIndex: Number(chunkIndex),
    lineIndex: Number(lineIndex),
  };
}

export function getCommentKey(filePath: string, lineNumber: number, side?: DiffSide): string {
  return `${filePath}:${lineNumber}:${side ?? 'any'}`;
}
