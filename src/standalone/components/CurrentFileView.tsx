import React, { useState, useEffect, useCallback, useMemo } from 'react';

import {
  type CommentThread,
  type DiffFile,
  type DiffSide,
  type LineNumber,
} from '../../types/diff';
import { type CursorPosition } from '../hooks/keyboardNavigation';

import { CommentButton } from './CommentButton';
import { CommentForm } from './CommentForm';
import { CommentThreadCard } from './CommentThreadCard';
import { DiffCodeLine } from './DiffCodeLine';
import type { AppearanceSettings } from './SettingsModal';

interface AnchorPosition {
  chunkIndex: number;
  lineIndex: number;
}

interface CurrentFileViewProps {
  file: DiffFile;
  fileIndex: number;
  lines: string[];
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
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  cursor?: CursorPosition | null;
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
}

export const CurrentFileView = React.memo(function CurrentFileView({
  file,
  fileIndex,
  lines,
  threads,
  showAuthorBadges = false,
  onAddComment,
  onGenerateThreadPrompt,
  onRemoveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  syntaxTheme,
  cursor = null,
  onLineClick,
  commentTrigger,
  onCommentTriggerHandled,
}: CurrentFileViewProps) {
  const [startLine, setStartLine] = useState<number | null>(null);
  const [endLine, setEndLine] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [commentingLine, setCommentingLine] = useState<LineNumber | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Lines that changed since the base revision. A brand-new file consists
  // entirely of additions, so no lines are marked in that case.
  const changedLineNumbers = useMemo(() => {
    const changed = new Set<number>();
    if (file.status === 'added') {
      return changed;
    }
    for (const chunk of file.chunks) {
      for (const line of chunk.lines) {
        if (line.type === 'add' && line.newLineNumber !== undefined) {
          changed.add(line.newLineNumber);
        }
      }
    }
    return changed;
  }, [file]);

  // Map each new-file line number to the diff positions that reference it, so
  // keyboard navigation (which walks real chunk data) finds anchor elements
  // and clicks can report a valid cursor position.
  const anchorsByLineNumber = useMemo(() => {
    const anchors = new Map<number, AnchorPosition[]>();
    file.chunks.forEach((chunk, chunkIndex) => {
      chunk.lines.forEach((line, lineIndex) => {
        if (line.newLineNumber === undefined) {
          return;
        }
        const positions = anchors.get(line.newLineNumber);
        if (positions) {
          positions.push({ chunkIndex, lineIndex });
        } else {
          anchors.set(line.newLineNumber, [{ chunkIndex, lineIndex }]);
        }
      });
    });
    return anchors;
  }, [file]);

  const cursorLineNumber = useMemo(() => {
    if (!cursor) {
      return null;
    }
    const line = file.chunks[cursor.chunkIndex]?.lines[cursor.lineIndex];
    return line?.newLineNumber ?? null;
  }, [cursor, file]);

  // Handle comment trigger from keyboard navigation
  useEffect(() => {
    if (!commentTrigger) {
      return;
    }
    const line = file.chunks[commentTrigger.chunkIndex]?.lines[commentTrigger.lineIndex];
    if (line?.newLineNumber !== undefined) {
      setCommentingLine(line.newLineNumber);
    }
    onCommentTriggerHandled?.();
  }, [commentTrigger, file.chunks, onCommentTriggerHandled]);

  const handleCommentToggle = useCallback((lineNumber: LineNumber) => {
    setCommentingLine((current) => (current === lineNumber ? null : lineNumber));
  }, []);

  const getLineFromAnchor = (lineNumber: number): LineNumber => {
    if (selectionAnchor === null) {
      return lineNumber;
    }
    const min = Math.min(selectionAnchor, lineNumber);
    const max = Math.max(selectionAnchor, lineNumber);
    return min === max ? lineNumber : [min, max];
  };

  const openShiftClickComment = (lineNumber: number) => {
    handleCommentToggle(getLineFromAnchor(lineNumber));
    setSelectionAnchor(lineNumber);
  };

  const startCommentDrag = (lineNumber: number) => {
    setSelectionAnchor(lineNumber);
    setStartLine(lineNumber);
    setEndLine(lineNumber);
    setIsDragging(true);
  };

  const handleCommentButtonMouseDown = (
    e: React.MouseEvent<HTMLButtonElement>,
    lineNumber: number,
  ) => {
    e.stopPropagation();
    if (e.shiftKey) {
      e.preventDefault();
    }
    if (e.shiftKey) {
      openShiftClickComment(lineNumber);
      return;
    }
    startCommentDrag(lineNumber);
  };

  const handleRowClick = (e: React.MouseEvent<HTMLTableRowElement>, lineNumber: number) => {
    if (e.shiftKey) {
      e.preventDefault();
      openShiftClickComment(lineNumber);
      return;
    }
    setSelectionAnchor(lineNumber);
    const anchor = anchorsByLineNumber.get(lineNumber)?.[0];
    if (anchor) {
      onLineClick?.(fileIndex, anchor.chunkIndex, anchor.lineIndex, 'right');
    }
  };

  // Global mouse up handler for drag selection: commit the selection wherever
  // the mouse is released, not only on the comment button itself
  useEffect(() => {
    if (!isDragging) {
      return undefined;
    }

    const handleGlobalMouseUp = () => {
      // Defer so the click event fired after mouseup doesn't immediately
      // close the newly opened (still empty) comment form
      setTimeout(() => {
        if (startLine !== null) {
          const actualEndLine = endLine ?? startLine;
          if (startLine === actualEndLine) {
            handleCommentToggle(startLine);
          } else {
            const min = Math.min(startLine, actualEndLine);
            const max = Math.max(startLine, actualEndLine);
            handleCommentToggle([min, max]);
          }
        }
        setIsDragging(false);
        setStartLine(null);
        setEndLine(null);
      }, 0);
    };

    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, startLine, endLine, handleCommentToggle]);

  const handleCancelComment = useCallback(() => {
    setCommentingLine(null);
  }, []);

  // Get the code content for the selected lines (for suggestion feature)
  const getSelectedCodeContent = useCallback((): string => {
    if (commentingLine === null) {
      return '';
    }
    if (typeof commentingLine === 'number') {
      return lines[commentingLine - 1] ?? '';
    }
    const [start, end] = commentingLine;
    return lines.slice(start - 1, end).join('\n');
  }, [commentingLine, lines]);

  const handleSubmitComment = useCallback(
    async (body: string) => {
      if (commentingLine !== null) {
        const codeContent = getSelectedCodeContent();
        await onAddComment(commentingLine, body, codeContent, 'new');
        setCommentingLine(null);
      }
    },
    [commentingLine, onAddComment, getSelectedCodeContent],
  );

  const getThreadsForLine = (lineNumber: number) => {
    return threads
      .filter((thread) => {
        const lineMatches = Array.isArray(thread.line)
          ? thread.line[1] === lineNumber
          : thread.line === lineNumber;
        const sideMatches = !thread.side || thread.side === 'new';
        return lineMatches && sideMatches;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  const getSelectedLineStyle = (lineNumber: number): string => {
    // Show selection during drag
    if (isDragging && startLine !== null) {
      const min = Math.min(startLine, endLine ?? startLine);
      const max = Math.max(startLine, endLine ?? startLine);
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

    // Show selection for existing comment
    if (commentingLine !== null) {
      const start = Array.isArray(commentingLine) ? commentingLine[0] : commentingLine;
      const end = Array.isArray(commentingLine) ? commentingLine[1] : commentingLine;
      if (lineNumber >= start && lineNumber <= end) {
        return 'comment-selected';
      }
    }

    return '';
  };

  const formTargetLineNumber = commentingLine
    ? Array.isArray(commentingLine)
      ? commentingLine[1]
      : commentingLine
    : null;

  return (
    <div className="bg-github-bg-primary">
      <table className="w-full table-fixed border-collapse font-mono text-sm leading-5">
        <tbody>
          {lines.map((content, index) => {
            const lineNumber = index + 1;
            const isChanged = changedLineNumbers.has(lineNumber);
            const isCurrentLine = cursorLineNumber === lineNumber;
            const anchors = anchorsByLineNumber.get(lineNumber);
            const showLineActions = hoveredIndex === index;

            return (
              <React.Fragment key={index}>
                <tr
                  data-diff-line-row="true"
                  className={`group bg-transparent relative cursor-pointer ${getSelectedLineStyle(
                    lineNumber,
                  )} ${isChanged ? 'current-changed-row' : ''} ${
                    isCurrentLine ? 'keyboard-cursor' : ''
                  }`}
                  onMouseEnter={() => {
                    setHoveredIndex(index);
                  }}
                  onMouseLeave={() => {
                    setHoveredIndex(null);
                  }}
                  onMouseMove={() => {
                    if (isDragging && startLine !== null) {
                      setEndLine(lineNumber);
                    }
                  }}
                  onClick={(e) => handleRowClick(e, lineNumber)}
                >
                  <td className="w-[var(--line-number-width)] min-w-[var(--line-number-width)] max-w-[var(--line-number-width)] px-2 text-right text-github-text-muted bg-github-bg-secondary border-r border-github-border select-none align-top relative overflow-visible">
                    {anchors?.map((anchor) => (
                      <span
                        key={`${anchor.chunkIndex}-${anchor.lineIndex}`}
                        id={`file-${fileIndex}-chunk-${anchor.chunkIndex}-line-${anchor.lineIndex}`}
                        className="absolute w-0 h-0"
                        aria-hidden="true"
                      />
                    ))}
                    <span>{lineNumber}</span>
                    {showLineActions && (
                      <CommentButton
                        onMouseDown={(e) => handleCommentButtonMouseDown(e, lineNumber)}
                      />
                    )}
                  </td>
                  <td className="p-0 w-full relative align-top">
                    <DiffCodeLine
                      line={{
                        type: isChanged ? 'add' : 'normal',
                        content,
                        newLineNumber: lineNumber,
                      }}
                      showPrefix={false}
                      syntaxTheme={syntaxTheme}
                      filename={file.path}
                    />
                  </td>
                </tr>

                {getThreadsForLine(lineNumber).map((thread) => (
                  <tr key={thread.id} className="bg-github-bg-secondary">
                    <td colSpan={2} className="p-0 border-t border-github-border">
                      {/* Flex wrapper lets the w-full card shrink inside its
                          mx-4 margins; a plain block would overflow the row */}
                      <div className="flex justify-center">
                        <div className="w-full m-2 mx-4">
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
                ))}

                {formTargetLineNumber === lineNumber && (
                  <tr className="bg-[var(--bg-secondary)]">
                    <td colSpan={2} className="p-0">
                      <div className="w-full">
                        <CommentForm
                          onSubmit={handleSubmitComment}
                          onCancel={handleCancelComment}
                          selectedCode={getSelectedCodeContent()}
                          syntaxTheme={syntaxTheme}
                          filename={file.path}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
