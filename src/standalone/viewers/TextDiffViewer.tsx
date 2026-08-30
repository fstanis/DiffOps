import React from 'react';

import { type DiffViewMode } from '../../types/diff';
import { CurrentFileView } from '../components/CurrentFileView';
import { DiffChunk } from '../components/DiffChunk';
import { ExpandButton } from '../components/ExpandButton';
import { useCurrentFileContent } from '../hooks/useCurrentFileContent';

import type { DiffViewerBodyProps } from './types';

export function TextDiffViewer({
  file,
  threads,
  showAuthorBadges,
  viewMode,
  syntaxTheme,
  targetCommitish,
  cursor,
  fileIndex,
  mergedChunks,
  isExpandLoading,
  expandHiddenLines,
  expandAllBetweenChunks,
  onAddComment,
  onGenerateThreadPrompt,
  onRemoveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  onLineClick,
  commentTrigger,
  onCommentTriggerHandled,
}: DiffViewerBodyProps) {
  // Full mode renders the whole new file with changed lines marked.
  // Deleted files have no new side, so they stay on the unified diff.
  const isFullView = viewMode === 'full' && file.status !== 'deleted';
  const currentContent = useCurrentFileContent(file, isFullView ? targetCommitish : undefined);

  if (isFullView) {
    if (currentContent.isLoading) {
      return (
        <div className="bg-github-bg-primary px-4 py-3 text-sm text-github-text-secondary select-none">
          Loading file…
        </div>
      );
    }

    if (currentContent.lines) {
      return (
        <CurrentFileView
          file={file}
          fileIndex={fileIndex ?? 0}
          lines={currentContent.lines}
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
          onLineClick={onLineClick}
          commentTrigger={commentTrigger}
          onCommentTriggerHandled={onCommentTriggerHandled}
        />
      );
    }

    // Content unavailable (e.g. blob fetch failed): fall through to the
    // unified diff below.
  }

  // Preview modes never reach the text viewer; full mode is not applicable
  // here either, so render chunks as unified.
  const chunkMode: DiffViewMode = viewMode === 'split' ? 'split' : 'unified';

  const renderExpandButton = (
    position: 'top' | 'middle' | 'bottom',
    mergedChunk: (typeof mergedChunks)[number],
    firstOriginalIndex: number,
    lastOriginalIndex: number,
  ) => {
    if (position === 'top' && mergedChunk.hiddenLinesBefore > 0) {
      return (
        <ExpandButton
          direction="down"
          hiddenLines={mergedChunk.hiddenLinesBefore}
          onExpandDown={() => expandHiddenLines(file, firstOriginalIndex, 'up')}
          onExpandAll={() =>
            expandAllBetweenChunks(file, firstOriginalIndex, mergedChunk.hiddenLinesBefore)
          }
          isLoading={isExpandLoading}
        />
      );
    }

    if (position === 'middle' && mergedChunk.hiddenLinesBefore > 0) {
      return (
        <ExpandButton
          direction="both"
          hiddenLines={mergedChunk.hiddenLinesBefore}
          onExpandUp={() => expandHiddenLines(file, firstOriginalIndex - 1, 'down')}
          onExpandDown={() => expandHiddenLines(file, firstOriginalIndex, 'up')}
          onExpandAll={() =>
            expandAllBetweenChunks(file, firstOriginalIndex, mergedChunk.hiddenLinesBefore)
          }
          isLoading={isExpandLoading}
        />
      );
    }

    if (position === 'bottom' && mergedChunk.hiddenLinesAfter > 0) {
      return (
        <ExpandButton
          direction="up"
          hiddenLines={mergedChunk.hiddenLinesAfter}
          onExpandUp={() => expandHiddenLines(file, lastOriginalIndex, 'down')}
          onExpandAll={() =>
            expandHiddenLines(file, lastOriginalIndex, 'down', mergedChunk.hiddenLinesAfter)
          }
          isLoading={isExpandLoading}
        />
      );
    }

    return null;
  };

  return (
    <>
      {mergedChunks.map((mergedChunk, mergedIndex) => {
        const isFirstMerged = mergedIndex === 0;
        const isLastMerged = mergedIndex === mergedChunks.length - 1;
        const firstOriginalIndex = mergedChunk.originalIndices[0] ?? 0;
        const lastOriginalIndex =
          mergedChunk.originalIndices[mergedChunk.originalIndices.length - 1] ?? 0;

        return (
          <React.Fragment key={mergedIndex}>
            {isFirstMerged &&
              renderExpandButton('top', mergedChunk, firstOriginalIndex, lastOriginalIndex)}

            {!isFirstMerged &&
              renderExpandButton('middle', mergedChunk, firstOriginalIndex, lastOriginalIndex)}

            <div id={`chunk-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}-${mergedIndex}`}>
              <DiffChunk
                chunk={mergedChunk}
                chunkIndex={mergedIndex}
                threads={threads}
                showAuthorBadges={showAuthorBadges}
                onAddComment={onAddComment}
                onGenerateThreadPrompt={onGenerateThreadPrompt}
                onRemoveThread={onRemoveThread}
                onReplyToThread={onReplyToThread}
                onRemoveMessage={onRemoveMessage}
                onUpdateMessage={onUpdateMessage}
                mode={chunkMode}
                syntaxTheme={syntaxTheme}
                cursor={cursor && cursor.chunkIndex === mergedIndex ? cursor : null}
                fileIndex={fileIndex}
                onLineClick={onLineClick}
                commentTrigger={
                  commentTrigger && commentTrigger.chunkIndex === mergedIndex
                    ? commentTrigger
                    : null
                }
                onCommentTriggerHandled={onCommentTriggerHandled}
                filename={file.path}
              />
            </div>

            {isLastMerged &&
              renderExpandButton('bottom', mergedChunk, firstOriginalIndex, lastOriginalIndex)}
          </React.Fragment>
        );
      })}
    </>
  );
}
