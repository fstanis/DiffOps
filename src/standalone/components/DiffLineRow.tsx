import React from 'react';

import { type DiffLine, type ExpandedLine } from '../../types/diff';
import { type DiffSegment } from '../utils/wordLevelDiff';

import { CommentButton } from './CommentButton';
import { DiffCodeLine } from './DiffCodeLine';
import type { AppearanceSettings } from './SettingsModal';

interface DiffLineRowProps {
  line: DiffLine | ExpandedLine;
  index: number;
  lineId?: string;
  isCurrentLine?: boolean;
  hoveredLineIndex: number | null;
  selectedLineStyle: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onCommentButtonMouseDown: (e: React.MouseEvent<HTMLButtonElement>) => void;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  onClick?: (e: React.MouseEvent<HTMLTableRowElement>) => void;
  filename?: string;
  diffSegments?: DiffSegment[];
  /** Index within the virtualizer; set only on virtualized rows, which the chunk measures by it. */
  dataIndex?: number;
}

const getLineClass = (line: DiffLine | ExpandedLine) => {
  if ('isExpanded' in line && line.isExpanded) {
    return 'bg-github-bg-tertiary/80';
  }
  switch (line.type) {
    case 'add':
      return 'bg-diff-addition-bg';
    case 'delete':
      return 'bg-diff-deletion-bg';
    default:
      return 'bg-transparent';
  }
};

export const DiffLineRow: React.FC<DiffLineRowProps> = React.memo(
  ({
    line,
    index,
    lineId,
    isCurrentLine = false,
    hoveredLineIndex,
    selectedLineStyle,
    onMouseEnter,
    onMouseLeave,
    onCommentButtonMouseDown,
    syntaxTheme,
    onClick,
    filename,
    diffSegments,
    dataIndex,
  }) => {
    const lineNumber = line.newLineNumber || line.oldLineNumber;
    const showLineActions = hoveredLineIndex === index && lineNumber;

    const highlightClass = isCurrentLine ? 'keyboard-cursor' : '';

    return (
      <tr
        id={lineId}
        data-diff-line-row="true"
        data-index={dataIndex}
        data-line-number={lineNumber || undefined}
        className={`group ${getLineClass(line)} relative ${selectedLineStyle} ${highlightClass} cursor-pointer`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      >
        <td className="w-[var(--line-number-width)] min-w-[var(--line-number-width)] max-w-[var(--line-number-width)] px-2 text-right text-github-text-muted bg-github-bg-secondary border-r border-github-border select-none align-top relative">
          {line.oldLineNumber || ''}
        </td>
        <td className="w-[var(--line-number-width)] min-w-[var(--line-number-width)] max-w-[var(--line-number-width)] px-2 text-right text-github-text-muted bg-github-bg-secondary border-r border-github-border select-none align-top relative overflow-visible">
          <span>{line.newLineNumber || ''}</span>
          {showLineActions && <CommentButton onMouseDown={onCommentButtonMouseDown} />}
        </td>
        <td className="p-0 w-full relative align-top">
          <DiffCodeLine
            line={line}
            syntaxTheme={syntaxTheme}
            filename={filename}
            diffSegments={diffSegments}
          />
        </td>
      </tr>
    );
  },
);

DiffLineRow.displayName = 'DiffLineRow';
