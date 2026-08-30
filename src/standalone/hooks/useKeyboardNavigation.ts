import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { DEFAULT_DIFF_VIEW_MODE } from '../../utils/diffMode';
import { NAVIGATION_SELECTORS } from '../constants/navigation';
import { getElementId, getCommentKey } from '../utils/navigation/domHelpers';
import { fixSide, hasContentOnSide } from '../utils/navigation/lineHelpers';

import {
  type CursorPosition,
  type NavigationDirection,
  type NavigationFilter,
  type NavigationResult,
  type UseKeyboardNavigationProps,
  type UseKeyboardNavigationReturn,
  createNavigationFilters,
  createScrollToElement,
} from './keyboardNavigation';
import type { CommentNavigationItem } from './keyboardNavigation/types';
import { getStartPosition, findNextMatchingPosition } from './keyboardNavigation/navigationCore';

/** Gerrit-style keyboard shortcuts for navigating diffs. */
export function useKeyboardNavigation({
  files,
  comments,
  getViewMode = () => DEFAULT_DIFF_VIEW_MODE,
  reviewedFiles,
  onToggleReviewed,
  onCreateComment,
  onCopyAllComments,
  onDeleteAllComments,
  onShowCommentsList,
  onRefresh,
  getHoveredFileIndex,
  onScrollToFile,
}: UseKeyboardNavigationProps): UseKeyboardNavigationReturn {
  const [cursor, setCursor] = useState<CursorPosition | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // Remembered so navigation resumes from here after the cursor is cleared (e.g. by a mouse click).
  const lastCursorRef = useRef<CursorPosition | null>(null);
  useEffect(() => {
    if (cursor) {
      lastCursorRef.current = cursor;
    }
  }, [cursor]);

  const scrollToElement = useMemo(() => createScrollToElement(), []);

  // File-level jumps anchor the section start so content above the first line is never cut off.
  const scrollToFilePosition = useCallback(
    (position: CursorPosition) => {
      if (onScrollToFile) {
        const filePath = files[position.fileIndex]?.path;
        if (filePath) {
          onScrollToFile(filePath);
        }
        return;
      }
      scrollToElement(getElementId(position, getViewMode(position.fileIndex)));
    },
    [onScrollToFile, files, scrollToElement, getViewMode],
  );

  const commentIndex = useMemo(() => {
    const index = new Map<string, CommentNavigationItem[]>();
    comments.forEach((thread) => {
      const lineNum = Array.isArray(thread.line) ? thread.line[0] : thread.line;
      const key = getCommentKey(thread.file, lineNum, thread.side);
      if (!index.has(key)) {
        index.set(key, []);
      }
      index.get(key)?.push(thread);
    });
    return index;
  }, [comments]);

  const filters = useMemo(
    () => createNavigationFilters(files, commentIndex, getViewMode, reviewedFiles),
    [files, commentIndex, getViewMode, reviewedFiles],
  );

  const navigate = useCallback(
    (direction: NavigationDirection, filter: NavigationFilter): NavigationResult => {
      if (files.length === 0) {
        return { position: null, scrollTarget: null };
      }

      const startPosition = getStartPosition(cursor ?? lastCursorRef.current);
      return findNextMatchingPosition(startPosition, direction, filter, files, getViewMode);
    },
    [cursor, files, getViewMode],
  );

  const createNavigationCommand = useCallback(
    (filter: NavigationFilter) => {
      return (direction: NavigationDirection) => {
        const result = navigate(direction, filter);
        if (result.position) {
          setCursor(result.position);
          if (result.scrollTarget) {
            scrollToElement(result.scrollTarget);
          }
        }
      };
    },
    [navigate, scrollToElement],
  );

  const navigateToLine = useMemo(
    () => createNavigationCommand(filters.line),
    [createNavigationCommand, filters.line],
  );

  const navigateToChunk = useMemo(
    () => createNavigationCommand(filters.chunk),
    [createNavigationCommand, filters.chunk],
  );

  const navigateToFile = useCallback(
    (direction: NavigationDirection) => {
      const result = navigate(direction, filters.file);
      if (result.position) {
        setCursor(result.position);
        scrollToFilePosition(result.position);
      }
    },
    [navigate, filters.file, scrollToFilePosition],
  );

  const navigateToComment = useMemo(
    () => createNavigationCommand(filters.comment),
    [createNavigationCommand, filters.comment],
  );

  const switchSide = useCallback(
    (side: 'left' | 'right') => {
      if (!cursor || getViewMode(cursor.fileIndex) !== 'split') return;

      let newCursor = { ...cursor, side };

      // Delete/add pairs share a visual line in split view but have distinct line indices.
      const currentLine =
        files[cursor.fileIndex]?.chunks[cursor.chunkIndex]?.lines[cursor.lineIndex];
      if (currentLine) {
        if (side === 'left' && currentLine.type === 'add' && cursor.lineIndex > 0) {
          const prevLine =
            files[cursor.fileIndex]?.chunks[cursor.chunkIndex]?.lines[cursor.lineIndex - 1];
          if (prevLine?.type === 'delete') {
            newCursor = { ...newCursor, lineIndex: cursor.lineIndex - 1 };
            setCursor(newCursor);
            scrollToElement(getElementId(newCursor, getViewMode(newCursor.fileIndex)));
            return;
          }
        } else if (side === 'right' && currentLine.type === 'delete') {
          const nextLine =
            files[cursor.fileIndex]?.chunks[cursor.chunkIndex]?.lines[cursor.lineIndex + 1];
          if (nextLine?.type === 'add') {
            newCursor = { ...newCursor, lineIndex: cursor.lineIndex + 1 };
            setCursor(newCursor);
            scrollToElement(getElementId(newCursor, getViewMode(newCursor.fileIndex)));
            return;
          }
        }
      }

      if (!hasContentOnSide(newCursor, files)) {
        const file = files[cursor.fileIndex];
        if (!file) return;

        const currentChunk = file.chunks[cursor.chunkIndex];
        if (currentChunk) {
          for (let i = cursor.lineIndex + 1; i < currentChunk.lines.length; i++) {
            const testPos = { ...newCursor, lineIndex: i };
            if (hasContentOnSide(testPos, files)) {
              newCursor = testPos;
              break;
            }
          }

          if (!hasContentOnSide(newCursor, files)) {
            for (let i = cursor.lineIndex - 1; i >= 0; i--) {
              const testPos = { ...newCursor, lineIndex: i };
              if (hasContentOnSide(testPos, files)) {
                newCursor = testPos;
                break;
              }
            }
          }
        }

        if (!hasContentOnSide(newCursor, files)) {
          for (let chunkIdx = cursor.chunkIndex + 1; chunkIdx < file.chunks.length; chunkIdx++) {
            const chunk = file.chunks[chunkIdx];
            if (!chunk) continue;
            for (let lineIdx = 0; lineIdx < chunk.lines.length; lineIdx++) {
              const testPos = {
                ...newCursor,
                chunkIndex: chunkIdx,
                lineIndex: lineIdx,
              };
              if (hasContentOnSide(testPos, files)) {
                newCursor = testPos;
                break;
              }
            }
            if (hasContentOnSide(newCursor, files)) break;
          }

          if (!hasContentOnSide(newCursor, files)) {
            for (let chunkIdx = cursor.chunkIndex - 1; chunkIdx >= 0; chunkIdx--) {
              const chunk = file.chunks[chunkIdx];
              if (!chunk) continue;
              for (let lineIdx = chunk.lines.length - 1; lineIdx >= 0; lineIdx--) {
                const testPos = {
                  ...newCursor,
                  chunkIndex: chunkIdx,
                  lineIndex: lineIdx,
                };
                if (hasContentOnSide(testPos, files)) {
                  newCursor = testPos;
                  break;
                }
              }
              if (hasContentOnSide(newCursor, files)) break;
            }
          }
        }
      }

      setCursor(newCursor);
      scrollToElement(getElementId(newCursor, getViewMode(newCursor.fileIndex)));
    },
    [cursor, getViewMode, scrollToElement, files],
  );

  const moveToCenterOfViewport = useCallback(() => {
    const scrollContainer = document.querySelector(
      NAVIGATION_SELECTORS.SCROLL_CONTAINER,
    ) as HTMLElement | null;
    if (!scrollContainer) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;

    let closestDistance = Infinity;
    let closestPosition: CursorPosition | null = null;

    files.forEach((file, fileIndex) => {
      const fileViewMode = getViewMode(fileIndex);
      file.chunks.forEach((chunk, chunkIndex) => {
        chunk.lines.forEach((_, lineIndex) => {
          const sides =
            fileViewMode === 'split' ? (['left', 'right'] as const) : (['right'] as const);

          for (const side of sides) {
            const position: CursorPosition = {
              fileIndex,
              chunkIndex,
              lineIndex,
              side,
            };

            if (fileViewMode === 'split' && !hasContentOnSide(position, files)) {
              continue;
            }

            const elementId = getElementId(position, fileViewMode);
            const element = document.getElementById(elementId);

            if (element) {
              const rect = element.getBoundingClientRect();
              const elementCenterY = rect.top + rect.height / 2;
              const distance = Math.abs(elementCenterY - centerY);

              if (rect.top < containerRect.bottom && rect.bottom > containerRect.top) {
                if (distance < closestDistance) {
                  closestDistance = distance;
                  closestPosition = position;
                }
              }
            }
          }
        });
      });
    });

    if (closestPosition) {
      setCursor(closestPosition);
      // Don't scroll: the target is already visible.
    }
  }, [files, getViewMode, setCursor]);

  const setCursorPosition = useCallback(
    (position: CursorPosition | null) => {
      if (!position) {
        setCursor(null);
        return;
      }
      const fixedPosition = fixSide(position, files);
      setCursor(fixedPosition);
      scrollToElement(getElementId(fixedPosition, getViewMode(fixedPosition.fileIndex)));
    },
    [files, getViewMode, scrollToElement],
  );

  const hotkeyOptions = {
    scopes: 'navigation',
    enableOnFormTags: false,
    preventDefault: true,
  };

  useHotkeys('j, down', () => navigateToLine('next'), hotkeyOptions, [navigateToLine]);
  useHotkeys('k, up', () => navigateToLine('prev'), hotkeyOptions, [navigateToLine]);

  useHotkeys('n', () => navigateToChunk('next'), hotkeyOptions, [navigateToChunk]);
  useHotkeys('p', () => navigateToChunk('prev'), hotkeyOptions, [navigateToChunk]);

  useHotkeys('shift+n', () => navigateToComment('next'), hotkeyOptions, [navigateToComment]);
  useHotkeys('shift+p', () => navigateToComment('prev'), hotkeyOptions, [navigateToComment]);

  useHotkeys(']', () => navigateToFile('next'), { ...hotkeyOptions, useKey: true }, [
    navigateToFile,
  ]);
  useHotkeys('[', () => navigateToFile('prev'), { ...hotkeyOptions, useKey: true }, [
    navigateToFile,
  ]);

  useHotkeys(
    '{',
    () => {
      if (files.length === 0) return;
      const position: CursorPosition = {
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 0,
        side: getViewMode(0) === 'split' ? 'left' : 'right',
      };
      setCursor(position);
      scrollToFilePosition(position);
    },
    { ...hotkeyOptions, useKey: true },
    [files, getViewMode, scrollToFilePosition],
  );

  useHotkeys(
    '}',
    () => {
      const lastFileIndex = files.length - 1;
      const lastFile = files[lastFileIndex];
      if (!lastFile || lastFile.chunks.length === 0) return;
      const position: CursorPosition = {
        fileIndex: lastFileIndex,
        chunkIndex: 0,
        lineIndex: 0,
        side: getViewMode(lastFileIndex) === 'split' ? 'left' : 'right',
      };
      setCursor(position);
      scrollToFilePosition(position);
    },
    { ...hotkeyOptions, useKey: true },
    [files, getViewMode, scrollToFilePosition],
  );

  useHotkeys(
    'h, left',
    () => switchSide('left'),
    { ...hotkeyOptions, enabled: cursor !== null && getViewMode(cursor.fileIndex) === 'split' },
    [switchSide, cursor, getViewMode],
  );
  useHotkeys(
    'l, right',
    () => switchSide('right'),
    { ...hotkeyOptions, enabled: cursor !== null && getViewMode(cursor.fileIndex) === 'split' },
    [switchSide, cursor, getViewMode],
  );

  // Wraps around but never lands back on the starting file.
  const focusNextUnviewedFile = useCallback(
    (afterIndex: number) => {
      const totalFiles = files.length;
      for (let offset = 1; offset < totalFiles; offset++) {
        const fileIndex = (afterIndex + offset) % totalFiles;
        const file = files[fileIndex];
        if (!file || !file.chunks[0]?.lines[0]) continue;
        if (reviewedFiles.has(file.path)) continue;

        const position = fixSide(
          {
            fileIndex,
            chunkIndex: 0,
            lineIndex: 0,
            side: getViewMode(fileIndex) === 'split' ? 'left' : 'right',
          },
          files,
        );
        setCursor(position);
        scrollToFilePosition(position);
        return;
      }
    },
    [files, reviewedFiles, getViewMode, scrollToFilePosition],
  );

  // Updates the remembered position without showing the cursor, so mouse-only
  // interactions (e.g. the Viewed button) don't surface keyboard UI.
  const rememberFilePosition = useCallback(
    (fileIndex: number) => {
      const file = files[fileIndex];
      if (!file || !file.chunks[0]?.lines[0]) return;

      lastCursorRef.current = fixSide(
        {
          fileIndex,
          chunkIndex: 0,
          lineIndex: 0,
          side: getViewMode(fileIndex) === 'split' ? 'left' : 'right',
        },
        files,
      );
    },
    [files, getViewMode],
  );

  // Targets the cursor file, or the hovered file when there is no cursor.
  useHotkeys(
    'v',
    () => {
      const fileIndex = cursor?.fileIndex ?? getHoveredFileIndex?.() ?? null;
      if (fileIndex !== null) {
        const file = files[fileIndex];
        if (file) {
          onToggleReviewed(file.path);
        }
      }
    },
    hotkeyOptions,
    [cursor, files, onToggleReviewed, getHoveredFileIndex],
  );

  useHotkeys(
    'shift+v',
    () => {
      const fileIndex =
        cursor?.fileIndex ?? getHoveredFileIndex?.() ?? lastCursorRef.current?.fileIndex ?? null;
      if (fileIndex === null) return;
      const file = files[fileIndex];
      if (!file) return;

      if (!reviewedFiles.has(file.path)) {
        onToggleReviewed(file.path);
      }
      focusNextUnviewedFile(fileIndex);
    },
    hotkeyOptions,
    [cursor, files, reviewedFiles, onToggleReviewed, getHoveredFileIndex, focusNextUnviewedFile],
  );

  useHotkeys(
    'shift+r',
    () => {
      if (onRefresh) {
        onRefresh();
      }
    },
    hotkeyOptions,
    [onRefresh],
  );

  useHotkeys(
    'c',
    () => {
      if (cursor && onCreateComment) {
        const line = files[cursor.fileIndex]?.chunks[cursor.chunkIndex]?.lines[cursor.lineIndex];
        if (line && line.type !== 'delete') {
          onCreateComment();
        }
      }
    },
    hotkeyOptions,
    [cursor, files, onCreateComment],
  );

  useHotkeys('?', () => setIsHelpOpen(!isHelpOpen), { ...hotkeyOptions, useKey: true }, [
    isHelpOpen,
  ]);

  useHotkeys(
    '.',
    (event) => {
      if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
        return;
      }
      moveToCenterOfViewport();
      event.preventDefault();
    },
    { ...hotkeyOptions, useKey: true, preventDefault: false },
    [moveToCenterOfViewport],
  );

  useHotkeys(
    'shift+c',
    () => {
      if (onCopyAllComments) {
        onCopyAllComments();
      }
    },
    { ...hotkeyOptions, scopes: ['navigation', 'comments-list'] },
    [onCopyAllComments],
  );

  useHotkeys(
    'shift+d',
    () => {
      if (onDeleteAllComments) {
        onDeleteAllComments();
      }
    },
    { ...hotkeyOptions, scopes: ['navigation', 'comments-list'] },
    [onDeleteAllComments],
  );

  useHotkeys(
    'shift+l',
    () => {
      if (onShowCommentsList) {
        onShowCommentsList();
      }
    },
    hotkeyOptions,
    [onShowCommentsList],
  );

  return {
    cursor,
    isHelpOpen,
    setIsHelpOpen,
    setCursorPosition,
    rememberFilePosition,
  };
}
