import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';

import {
  type DiffChunk as DiffChunkType,
  type DiffLine,
  type DiffSide,
  type CommentThread,
  type LineNumber,
  type DiffViewMode,
  type LineSelection,
} from '../../types/diff';
import { DEFAULT_DIFF_VIEW_MODE } from '../../utils/diffMode';
import { registerChunkRowVirtualizer } from '../hooks/diffRowVirtualizerRegistry';
import { type CursorPosition } from '../hooks/keyboardNavigation';
import { useDiffRowVirtualizer } from '../hooks/useDiffRowVirtualizer';
import {
  computeWordLevelDiff,
  shouldComputeWordDiff,
  type DiffSegment,
} from '../utils/wordLevelDiff';

import { CommentForm } from './CommentForm';
import { CommentThreadCard } from './CommentThreadCard';
import { DiffLineRow } from './DiffLineRow';
import type { AppearanceSettings } from './SettingsModal';
import { SideBySideDiffChunk } from './SideBySideDiffChunk';

interface DiffChunkProps {
  chunk: DiffChunkType;
  chunkIndex: number;
  threads: CommentThread[];
  showAuthorBadges?: boolean;
  onAddComment: (
    line: LineNumber,
    body: string,
    codeContent?: string,
    side?: DiffSide,
  ) => Promise<void>;
  onGenerateThreadPrompt: (thread: CommentThread) => string;
  onRemoveThread: (threadId: string) => void;
  onReplyToThread: (threadId: string, body: string) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  mode?: DiffViewMode;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  cursor?: CursorPosition | null;
  fileIndex?: number;
  onLineClick?: (
    fileIndex: number,
    chunkIndex: number,
    lineIndex: number,
    side: 'left' | 'right',
  ) => void;
  commentTrigger?: {
    fileIndex: number;
    chunkIndex: number;
    lineIndex: number;
  } | null;
  onCommentTriggerHandled?: () => void;
  filename?: string;
}

export const DiffChunk = memo(function DiffChunk({
  chunk,
  chunkIndex,
  threads,
  showAuthorBadges = false,
  onAddComment,
  onGenerateThreadPrompt,
  onRemoveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  mode = DEFAULT_DIFF_VIEW_MODE,
  syntaxTheme,
  cursor = null,
  fileIndex = 0,
  onLineClick,
  commentTrigger,
  onCommentTriggerHandled,
  filename,
}: DiffChunkProps) {
  const [startLine, setStartLine] = useState<number | null>(null);
  const [endLine, setEndLine] = useState<number | null>(null);
  const [dragSide, setDragSide] = useState<DiffSide | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [commentingLine, setCommentingLine] = useState<{
    side: DiffSide;
    lineNumber: LineNumber;
  } | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<{
    side: DiffSide;
    lineNumber: number;
  } | null>(null);
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);

  useEffect(() => {
    if (commentTrigger?.lineIndex !== undefined) {
      const line = chunk.lines[commentTrigger.lineIndex];
      if (line) {
        const lineNumber = line.newLineNumber || line.oldLineNumber;
        const side: DiffSide = line.type === 'delete' ? 'old' : 'new';
        if (lineNumber) {
          setCommentingLine({ side, lineNumber });
          onCommentTriggerHandled?.();
        }
      }
    }
  }, [commentTrigger, chunk.lines, onCommentTriggerHandled]);

  const handleAddComment = useCallback(
    (side: DiffSide, lineNumber: LineNumber) => {
      if (commentingLine?.side === side && commentingLine?.lineNumber === lineNumber) {
        setCommentingLine(null);
      } else {
        setCommentingLine({ side, lineNumber });
      }
    },
    [commentingLine],
  );

  const getCommentLineFromAnchor = (selection: LineSelection): LineNumber => {
    if (!selectionAnchor || selectionAnchor.side !== selection.side) {
      return selection.lineNumber;
    }

    const min = Math.min(selectionAnchor.lineNumber, selection.lineNumber);
    const max = Math.max(selectionAnchor.lineNumber, selection.lineNumber);
    return min === max ? selection.lineNumber : [min, max];
  };

  const openShiftClickComment = (selection: LineSelection) => {
    handleAddComment(selection.side, getCommentLineFromAnchor(selection));
    setSelectionAnchor(selection);
  };

  const startCommentDrag = (selection: LineSelection) => {
    setSelectionAnchor(selection);
    setStartLine(selection.lineNumber);
    setEndLine(selection.lineNumber);
    setDragSide(selection.side);
    setIsDragging(true);
  };

  const handleCommentButtonMouseDown = ({
    isShiftClick,
    selection,
  }: {
    isShiftClick: boolean;
    selection: LineSelection | null;
  }) => {
    if (!selection) return;

    if (isShiftClick) {
      openShiftClickComment(selection);
      return;
    }

    startCommentDrag(selection);
  };

  const handleRowClick = ({
    isShiftClick,
    lineIndex,
    navigationSide,
    selection,
  }: {
    isShiftClick: boolean;
    lineIndex: number;
    navigationSide: 'left' | 'right';
    selection: LineSelection | null;
  }) => {
    if (!selection) {
      onLineClick?.(fileIndex, chunkIndex, lineIndex, navigationSide);
      return;
    }

    if (isShiftClick) {
      openShiftClickComment(selection);
      return;
    }

    setSelectionAnchor(selection);
    onLineClick?.(fileIndex, chunkIndex, lineIndex, navigationSide);
  };

  // Global mouseup handler: commits the selection wherever the mouse is released, not only on the comment button.
  useEffect(() => {
    if (!isDragging) {
      return undefined;
    }

    const handleGlobalMouseUp = () => {
      // Defer so the click that follows mouseup doesn't immediately close the newly opened comment form.
      setTimeout(() => {
        if (startLine && dragSide) {
          const actualEndLine = endLine ?? startLine;
          if (startLine === actualEndLine) {
            handleAddComment(dragSide, startLine);
          } else {
            const min = Math.min(startLine, actualEndLine);
            const max = Math.max(startLine, actualEndLine);
            handleAddComment(dragSide, [min, max]);
          }
        }
        setIsDragging(false);
        setStartLine(null);
        setEndLine(null);
        setDragSide(null);
      }, 0);
    };

    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, startLine, endLine, dragSide, handleAddComment]);

  // Single document-level listener while dragging, rather than one on every row.
  useEffect(() => {
    if (!isDragging) {
      return undefined;
    }

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!startLine) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const row = target instanceof Element ? target.closest('[data-diff-line-row]') : null;
      const lineNumberAttr = row?.getAttribute('data-line-number');
      if (!lineNumberAttr) return;
      const lineNumber = Number(lineNumberAttr);
      if (Number.isFinite(lineNumber)) {
        setEndLine(lineNumber);
      }
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
    };
  }, [isDragging, startLine]);

  const handleCancelComment = useCallback(() => {
    setCommentingLine(null);
  }, []);

  const getSelectedCodeContent = useCallback((): string => {
    if (!commentingLine) return '';

    const { side, lineNumber } = commentingLine;
    const lines = chunk.lines;

    if (typeof lineNumber === 'number') {
      const line = lines.find((l) =>
        side === 'old' ? l.oldLineNumber === lineNumber : l.newLineNumber === lineNumber,
      );
      return line?.content ?? '';
    } else {
      const [start, end] = lineNumber;
      const selectedLines = lines.filter((l) => {
        const ln = side === 'old' ? l.oldLineNumber : l.newLineNumber;
        return ln !== undefined && ln >= start && ln <= end;
      });
      return selectedLines.map((l) => l.content ?? '').join('\n');
    }
  }, [commentingLine, chunk.lines]);

  const handleSubmitComment = useCallback(
    async (body: string) => {
      if (commentingLine !== null) {
        const codeContent = getSelectedCodeContent();
        await onAddComment(commentingLine.lineNumber, body, codeContent, commentingLine.side);
        setCommentingLine(null);
      }
    },
    [commentingLine, onAddComment, getSelectedCodeContent],
  );

  const getThreadsForLine = (lineNumber: number, side: DiffSide) => {
    return threads
      .filter((thread) => {
        const lineMatches = Array.isArray(thread.line)
          ? thread.line[1] === lineNumber
          : thread.line === lineNumber;
        const sideMatches = !thread.side || thread.side === side;
        return lineMatches && sideMatches;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  const getCommentLayout = (line: DiffLine): 'left' | 'right' | 'full' => {
    if (mode === 'unified' || mode === 'full') {
      return 'full';
    }

    switch (line.type) {
      case 'delete':
        return 'left';
      case 'add':
        return 'right';
      default:
        return 'full';
    }
  };

  const getSelectedLineStyle = (lineNumber: number | undefined, side: DiffSide): string => {
    if (!lineNumber) {
      return '';
    }

    if (isDragging && startLine && endLine) {
      const min = Math.min(startLine, endLine);
      const max = Math.max(startLine, endLine);
      if (lineNumber >= min && lineNumber <= max) {
        let classes = 'drag-selected';
        if (lineNumber === min) {
          classes += ' drag-selected-first';
        }
        if (lineNumber === max) {
          classes += ' drag-selected-last';
        }
        return classes;
      }
    }

    if (commentingLine && commentingLine.side === side) {
      const start = Array.isArray(commentingLine.lineNumber)
        ? commentingLine.lineNumber[0]
        : commentingLine.lineNumber;
      const end = Array.isArray(commentingLine.lineNumber)
        ? commentingLine.lineNumber[1]
        : commentingLine.lineNumber;
      if (lineNumber >= start && lineNumber <= end) {
        return 'comment-selected';
      }
    }

    return '';
  };

  const wordLevelDiffMap = useMemo(() => {
    const map = new Map<number, DiffSegment[]>();
    const lines = chunk.lines;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line) {
        i++;
        continue;
      }

      if (line.type === 'delete') {
        let j = i + 1;
        while (j < lines.length && lines[j]?.type === 'delete') {
          j++;
        }

        const deleteLines = lines.slice(i, j);
        const deleteStartIndex = i;
        const addLines: { line: DiffLine; index: number }[] = [];

        while (j < lines.length && lines[j]?.type === 'add') {
          const addLine = lines[j];
          if (addLine) {
            addLines.push({ line: addLine, index: j });
          }
          j++;
        }

        const maxLines = Math.max(deleteLines.length, addLines.length);
        for (let k = 0; k < maxLines; k++) {
          const deleteLine = deleteLines[k];
          const addLineInfo = addLines[k];

          if (deleteLine && addLineInfo) {
            if (shouldComputeWordDiff(deleteLine.content, addLineInfo.line.content)) {
              const wordLevelDiff = computeWordLevelDiff(
                deleteLine.content,
                addLineInfo.line.content,
              );
              map.set(deleteStartIndex + k, wordLevelDiff.oldSegments);
              map.set(addLineInfo.index, wordLevelDiff.newSegments);
            }
          }
        }

        i = j;
      } else {
        i++;
      }
    }

    return map;
  }, [chunk.lines]);

  const rowCount = mode === 'split' ? 0 : chunk.lines.length;
  const { wrapperRef, isVirtualized, scrollRowIntoView, virtualItems, paddingTop, paddingBottom } =
    useDiffRowVirtualizer(rowCount);

  useEffect(() => {
    if (mode === 'split' || !isVirtualized) return undefined;

    registerChunkRowVirtualizer(fileIndex, chunkIndex, (originalLineIndex) => {
      if (originalLineIndex < 0 || originalLineIndex >= chunk.lines.length) return false;
      return scrollRowIntoView(originalLineIndex);
    });
    return () => registerChunkRowVirtualizer(fileIndex, chunkIndex, null);
  }, [mode, isVirtualized, fileIndex, chunkIndex, chunk.lines.length, scrollRowIntoView]);

  const renderLineGroup = (line: DiffLine, index: number, isVirtualRow = false) => {
    const currentLineNumber = line.newLineNumber || line.oldLineNumber || 0;
    const currentLineSide: DiffSide = line.type === 'delete' ? 'old' : 'new';
    const formTargetLineNumber = commentingLine
      ? Array.isArray(commentingLine.lineNumber)
        ? commentingLine.lineNumber[1]
        : commentingLine.lineNumber
      : null;

    const commentLineNumber = line.type === 'delete' ? line.oldLineNumber : line.newLineNumber;
    const commentSide: DiffSide = line.type === 'delete' ? 'old' : 'new';
    const lineThreads = commentLineNumber ? getThreadsForLine(commentLineNumber, commentSide) : [];
    // Generate ID for all lines to match the format used in useKeyboardNavigation
    const lineId = `file-${fileIndex}-chunk-${chunkIndex}-line-${index}`;
    const isCurrentLine = cursor && cursor.chunkIndex === chunkIndex && cursor.lineIndex === index;
    const selection = commentLineNumber
      ? { side: commentSide, lineNumber: commentLineNumber }
      : null;

    return (
      <React.Fragment key={index}>
        <DiffLineRow
          line={line}
          index={index}
          lineId={lineId}
          dataIndex={isVirtualRow ? index : undefined}
          isCurrentLine={isCurrentLine || false}
          hoveredLineIndex={hoveredLine}
          selectedLineStyle={getSelectedLineStyle(
            line.newLineNumber || line.oldLineNumber,
            line.type === 'delete' ? 'old' : 'new',
          )}
          onMouseEnter={() => {
            setHoveredLine(index);
          }}
          onMouseLeave={() => setHoveredLine(null)}
          onCommentButtonMouseDown={(e) => {
            e.stopPropagation();
            if (e.shiftKey) {
              e.preventDefault();
            }
            handleCommentButtonMouseDown({
              isShiftClick: e.shiftKey,
              selection,
            });
          }}
          syntaxTheme={syntaxTheme}
          filename={filename}
          diffSegments={wordLevelDiffMap.get(index)}
          onClick={(e) => {
            const side = line.type === 'delete' ? 'left' : 'right';
            if (e.shiftKey) {
              e.preventDefault();
            }
            handleRowClick({
              isShiftClick: e.shiftKey,
              lineIndex: index,
              navigationSide: side,
              selection,
            });
          }}
        />

        {lineThreads.map((thread) => {
          const layout = getCommentLayout(line);
          return (
            <tr key={thread.id} data-diff-extra-row="true" className="bg-github-bg-secondary">
              <td colSpan={3} className="p-0 border-t border-github-border">
                <div
                  className={`flex ${
                    layout === 'left'
                      ? 'justify-start'
                      : layout === 'right'
                        ? 'justify-end'
                        : 'justify-center'
                  }`}
                >
                  <div className={`${layout === 'full' ? 'w-full' : 'w-1/2'} m-2 mx-4`}>
                    <CommentThreadCard
                      thread={thread}
                      showAuthorBadges={showAuthorBadges}
                      onGeneratePrompt={onGenerateThreadPrompt}
                      onRemoveThread={onRemoveThread}
                      onReplyToThread={onReplyToThread}
                      onRemoveMessage={onRemoveMessage}
                      onUpdateMessage={onUpdateMessage}
                      syntaxTheme={syntaxTheme}
                    />
                  </div>
                </div>
              </td>
            </tr>
          );
        })}

        {commentingLine &&
          commentingLine.side === currentLineSide &&
          formTargetLineNumber === currentLineNumber && (
            <tr data-diff-extra-row="true" className="bg-[var(--bg-secondary)]">
              <td colSpan={3} className="p-0">
                <div
                  className={`flex ${
                    getCommentLayout(line) === 'left'
                      ? 'justify-start'
                      : getCommentLayout(line) === 'right'
                        ? 'justify-end'
                        : 'justify-center'
                  }`}
                >
                  <div className={`${getCommentLayout(line) === 'full' ? 'w-full' : 'w-1/2'}`}>
                    <CommentForm
                      onSubmit={handleSubmitComment}
                      onCancel={handleCancelComment}
                      selectedCode={getSelectedCodeContent()}
                      syntaxTheme={syntaxTheme}
                      filename={filename}
                    />
                  </div>
                </div>
              </td>
            </tr>
          )}
      </React.Fragment>
    );
  };

  if (mode === 'split') {
    return (
      <SideBySideDiffChunk
        chunk={chunk}
        chunkIndex={chunkIndex}
        threads={threads}
        showAuthorBadges={showAuthorBadges}
        onAddComment={onAddComment}
        onGenerateThreadPrompt={onGenerateThreadPrompt}
        onRemoveThread={onRemoveThread}
        onReplyToThread={onReplyToThread}
        onRemoveMessage={onRemoveMessage}
        onUpdateMessage={onUpdateMessage}
        syntaxTheme={syntaxTheme}
        cursor={cursor}
        fileIndex={fileIndex}
        onLineClick={onLineClick}
        filename={filename}
        commentTrigger={commentTrigger}
        onCommentTriggerHandled={onCommentTriggerHandled}
      />
    );
  }

  // `table-fixed` takes its column widths from the first row, which is a spacer
  // whenever the rows above the mounted range are collapsed into one. Without a
  // colgroup the code column then loses its width, the same line wraps to a
  // different height depending on where the range sits, and re-measuring it
  // moves the range again — an oscillation that never settles.
  const columns = (
    <colgroup>
      <col className="w-[var(--line-number-width)]" />
      <col className="w-[var(--line-number-width)]" />
      <col />
    </colgroup>
  );

  if (!isVirtualized) {
    return (
      <div ref={wrapperRef} className="bg-github-bg-primary">
        <table className="w-full table-fixed border-collapse font-mono text-sm leading-5">
          {columns}
          <tbody>{chunk.lines.map((line, index) => renderLineGroup(line, index))}</tbody>
        </table>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="bg-github-bg-primary">
      <table className="w-full table-fixed border-collapse font-mono text-sm leading-5">
        {columns}
        <tbody>
          {paddingTop > 0 && (
            <tr style={{ height: paddingTop }} aria-hidden="true">
              <td colSpan={3} className="p-0" />
            </tr>
          )}
          {virtualItems.map((virtualItem) => {
            const line = chunk.lines[virtualItem.index];
            if (!line) return null;
            return renderLineGroup(line, virtualItem.index, true);
          })}
          {paddingBottom > 0 && (
            <tr style={{ height: paddingBottom }} aria-hidden="true">
              <td colSpan={3} className="p-0" />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
});
