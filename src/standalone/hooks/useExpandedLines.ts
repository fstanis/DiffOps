import { useState, useCallback, useRef, useEffect } from 'react';

import {
  type DiffFile,
  type DiffChunk,
  type DiffLine,
  type ExpandedLinesState,
  type FileExpandedState,
} from '../../types/diff';

const DEFAULT_EXPAND_COUNT = 20;

interface UseExpandedLinesOptions {
  baseCommitish?: string;
  targetCommitish?: string;
  diffIdentity?: string | number;
}

export interface MergedChunk extends DiffChunk {
  originalIndices: number[];
  hiddenLinesBefore: number;
  hiddenLinesAfter: number;
}

interface UseExpandedLinesResult {
  expandedState: ExpandedLinesState;
  isLoading: boolean;
  lastUpdatedFilePath: string | null;
  lastUpdatedAt: number;
  expandLines: (
    file: DiffFile,
    chunkIndex: number,
    direction: 'up' | 'down',
    count?: number,
  ) => Promise<void>;
  expandAllBetweenChunks: (
    file: DiffFile,
    chunkIndex: number,
    hiddenLines: number,
  ) => Promise<void>;
  prefetchFileContent: (file: DiffFile) => Promise<void>;
  getMergedChunks: (file: DiffFile) => MergedChunk[];
  getHiddenLinesBefore: (file: DiffFile, chunk: DiffChunk, chunkIndex: number) => number;
  getHiddenLinesAfter: (file: DiffFile, chunk: DiffChunk, chunkIndex: number) => number;
}

async function fetchFileContent(
  filePath: string,
  commitish: string,
): Promise<{ lines: string[]; totalLines: number }> {
  const encodedPath = encodeURIComponent(filePath);
  const response = await fetch(`/api/blob/${encodedPath}?ref=${encodeURIComponent(commitish)}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch file content: ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.split('\n');
  // Remove last empty line if file doesn't end with newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return { lines, totalLines: lines.length };
}

async function fetchLineCount(
  filePath: string,
  oldRef?: string,
  newRef?: string,
  oldPath?: string,
): Promise<{ oldLineCount?: number; newLineCount?: number }> {
  const encodedPath = encodeURIComponent(filePath);
  const params = new URLSearchParams();
  if (oldRef) params.set('oldRef', oldRef);
  if (newRef) params.set('newRef', newRef);
  if (oldPath && oldPath !== filePath) params.set('oldPath', oldPath);

  const response = await fetch(`/api/line-count/${encodedPath}?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch line count: ${response.statusText}`);
  }
  return response.json() as Promise<{ oldLineCount?: number; newLineCount?: number }>;
}

export function useExpandedLines({
  baseCommitish,
  targetCommitish,
  diffIdentity,
}: UseExpandedLinesOptions): UseExpandedLinesResult {
  const [expandedState, setExpandedState] = useState<ExpandedLinesState>({});
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdatedFilePath, setLastUpdatedFilePath] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0);
  // Track pending fetch promises to allow waiting for in-flight requests
  const pendingFetchesRef = useRef<Map<string, Promise<FileExpandedState | null>>>(new Map());
  // Use ref to access current state without causing a dependency loop
  const expandedStateRef = useRef<ExpandedLinesState>({});
  expandedStateRef.current = expandedState;
  const revisionGenerationRef = useRef(0);

  useEffect(() => {
    revisionGenerationRef.current += 1;
    pendingFetchesRef.current.clear();
    expandedStateRef.current = {};
    setExpandedState({});
    setIsLoading(false);
    setLastUpdatedFilePath(null);
    setLastUpdatedAt(0);
  }, [baseCommitish, targetCommitish, diffIdentity]);

  const ensureFileContent = useCallback(
    async (file: DiffFile): Promise<FileExpandedState | null> => {
      const revisionGeneration = revisionGenerationRef.current;
      const pendingFetchKey = `${revisionGeneration}:${file.path}`;

      // Check if fetch is already in progress - wait for it instead of returning stale data
      const pendingFetch = pendingFetchesRef.current.get(pendingFetchKey);
      if (pendingFetch) {
        return pendingFetch;
      }

      const fetchPromise = (async (): Promise<FileExpandedState | null> => {
        // Read current state via ref to avoid dependency on expandedState
        const existingState = expandedStateRef.current[file.path];

        if (existingState?.oldContent && existingState?.newContent) {
          return existingState;
        }

        const state: FileExpandedState = {
          ...existingState,
          expandedRanges: existingState?.expandedRanges || [],
        };

        if (file.status !== 'added' && baseCommitish) {
          const oldPath = file.oldPath || file.path;
          try {
            const { lines, totalLines } = await fetchFileContent(oldPath, baseCommitish);
            if (revisionGenerationRef.current !== revisionGeneration) {
              return null;
            }
            state.oldContent = lines;
            state.oldTotalLines = totalLines;
          } catch (error) {
            console.error('Failed to fetch old file content:', error);
            state.oldContent = [];
            state.oldTotalLines = 0;
          }
        }

        if (file.status !== 'deleted' && targetCommitish) {
          try {
            const { lines, totalLines } = await fetchFileContent(file.path, targetCommitish);
            if (revisionGenerationRef.current !== revisionGeneration) {
              return null;
            }
            state.newContent = lines;
            state.newTotalLines = totalLines;
          } catch (error) {
            console.error('Failed to fetch new file content:', error);
            state.newContent = [];
            state.newTotalLines = 0;
          }
        }

        return state;
      })();

      pendingFetchesRef.current.set(pendingFetchKey, fetchPromise);

      try {
        return await fetchPromise;
      } finally {
        pendingFetchesRef.current.delete(pendingFetchKey);
      }
    },
    [baseCommitish, targetCommitish],
  );

  const markFileUpdated = useCallback((filePath: string) => {
    setLastUpdatedFilePath(filePath);
    setLastUpdatedAt((prev) => prev + 1);
  }, []);

  const expandLines = useCallback(
    async (
      file: DiffFile,
      chunkIndex: number,
      direction: 'up' | 'down',
      count: number = DEFAULT_EXPAND_COUNT,
    ) => {
      const revisionGeneration = revisionGenerationRef.current;
      setIsLoading(true);
      try {
        const fileState = await ensureFileContent(file);
        if (!fileState || revisionGenerationRef.current !== revisionGeneration) {
          return;
        }

        setExpandedState((prev) => {
          const currentFileState = prev[file.path];
          const currentRanges = currentFileState?.expandedRanges || fileState.expandedRanges || [];

          const existingRangeIndex = currentRanges.findIndex(
            (r) => r.chunkIndex === chunkIndex && r.direction === direction,
          );

          const newRanges = [...currentRanges];

          if (existingRangeIndex >= 0 && newRanges[existingRangeIndex]) {
            const existingRange = newRanges[existingRangeIndex];
            newRanges[existingRangeIndex] = {
              chunkIndex: existingRange.chunkIndex,
              direction: existingRange.direction,
              count: existingRange.count + count,
            };
          } else {
            newRanges.push({ chunkIndex, direction, count });
          }

          return {
            ...prev,
            [file.path]: {
              oldContent: currentFileState?.oldContent ?? fileState.oldContent,
              newContent: currentFileState?.newContent ?? fileState.newContent,
              oldTotalLines: currentFileState?.oldTotalLines ?? fileState.oldTotalLines,
              newTotalLines: currentFileState?.newTotalLines ?? fileState.newTotalLines,
              expandedRanges: newRanges,
            },
          };
        });
        markFileUpdated(file.path);
      } finally {
        setIsLoading(false);
      }
    },
    [ensureFileContent, markFileUpdated],
  );

  const expandAllBetweenChunks = useCallback(
    async (file: DiffFile, chunkIndex: number, hiddenLines: number) => {
      const revisionGeneration = revisionGenerationRef.current;
      setIsLoading(true);
      try {
        const fileState = await ensureFileContent(file);
        if (!fileState || revisionGenerationRef.current !== revisionGeneration) {
          return;
        }

        setExpandedState((prev) => {
          const currentFileState = prev[file.path];
          const currentRanges = currentFileState?.expandedRanges || fileState.expandedRanges || [];

          const newRanges = [...currentRanges];

          // The gap before chunkIndex may be recorded as this chunk's 'up' range or as the previous chunk's 'down' range, since the two expand buttons call different functions depending on position.
          const existingUpIndex = newRanges.findIndex(
            (r) => r.chunkIndex === chunkIndex && r.direction === 'up',
          );

          const existingDownPrevIndex = newRanges.findIndex(
            (r) => r.chunkIndex === chunkIndex - 1 && r.direction === 'down',
          );

          let alreadyExpandedUp = 0;
          let alreadyExpandedDownPrev = 0;

          if (existingUpIndex >= 0 && newRanges[existingUpIndex]) {
            alreadyExpandedUp = newRanges[existingUpIndex].count;
          }
          if (existingDownPrevIndex >= 0 && newRanges[existingDownPrevIndex]) {
            alreadyExpandedDownPrev = newRanges[existingDownPrevIndex].count;
          }

          // hiddenLines is the remaining count, not the total.
          const totalToExpand = alreadyExpandedUp + alreadyExpandedDownPrev + hiddenLines;

          // The previous chunk's 'down' range must be removed before writing the consolidated 'up' range, or the index lookups below shift.
          const filteredRanges = newRanges.filter(
            (r) => !(r.chunkIndex === chunkIndex - 1 && r.direction === 'down'),
          );

          const upIndexInFiltered = filteredRanges.findIndex(
            (r) => r.chunkIndex === chunkIndex && r.direction === 'up',
          );

          if (upIndexInFiltered >= 0 && filteredRanges[upIndexInFiltered]) {
            filteredRanges[upIndexInFiltered] = {
              chunkIndex,
              direction: 'up',
              count: totalToExpand,
            };
          } else {
            filteredRanges.push({ chunkIndex, direction: 'up', count: totalToExpand });
          }

          return {
            ...prev,
            [file.path]: {
              oldContent: currentFileState?.oldContent ?? fileState.oldContent,
              newContent: currentFileState?.newContent ?? fileState.newContent,
              oldTotalLines: currentFileState?.oldTotalLines ?? fileState.oldTotalLines,
              newTotalLines: currentFileState?.newTotalLines ?? fileState.newTotalLines,
              expandedRanges: filteredRanges,
            },
          };
        });
        markFileUpdated(file.path);
      } finally {
        setIsLoading(false);
      }
    },
    [ensureFileContent, markFileUpdated],
  );

  // Pre-fetch only line counts (lightweight) to show bottom expand button
  const prefetchFileContent = useCallback(
    async (file: DiffFile) => {
      const revisionGeneration = revisionGenerationRef.current;
      const existing = expandedStateRef.current[file.path];
      if (existing?.oldTotalLines !== undefined || existing?.newTotalLines !== undefined) {
        return;
      }

      const oldRef = file.status !== 'added' ? baseCommitish : undefined;
      const newRef = file.status !== 'deleted' ? targetCommitish : undefined;

      if (!oldRef && !newRef) return;

      try {
        const { oldLineCount, newLineCount } = await fetchLineCount(
          file.path,
          oldRef,
          newRef,
          file.oldPath,
        );
        if (revisionGenerationRef.current !== revisionGeneration) {
          return;
        }

        setExpandedState((prev) => {
          const current = prev[file.path];
          if (current?.oldTotalLines !== undefined || current?.newTotalLines !== undefined) {
            return prev;
          }
          return {
            ...prev,
            [file.path]: {
              ...current,
              expandedRanges: current?.expandedRanges || [],
              oldTotalLines: oldLineCount,
              newTotalLines: newLineCount,
            },
          };
        });
        markFileUpdated(file.path);
      } catch (error) {
        console.error('Failed to prefetch line count:', error);
      }
    },
    [baseCommitish, targetCommitish, markFileUpdated],
  );

  const getExpandedCount = useCallback(
    (filePath: string, chunkIndex: number, direction: 'up' | 'down'): number => {
      const fileState = expandedState[filePath];
      if (!fileState) return 0;

      const range = fileState.expandedRanges.find(
        (r) => r.chunkIndex === chunkIndex && r.direction === direction,
      );
      return range?.count || 0;
    },
    [expandedState],
  );

  const getHiddenLinesBefore = useCallback(
    (file: DiffFile, chunk: DiffChunk, chunkIndex: number): number => {
      // Fully added/deleted files show all lines in the diff - no hidden lines
      if (file.status === 'added' || file.status === 'deleted') {
        return 0;
      }

      const prevChunk = file.chunks[chunkIndex - 1];
      let hiddenLines: number;

      if (!prevChunk) {
        hiddenLines = chunk.oldStart - 1;
      } else {
        const prevEnd = prevChunk.oldStart + prevChunk.oldLines;
        hiddenLines = chunk.oldStart - prevEnd;
      }

      // The "up" direction covers already-expanded lines before this chunk.
      const expandedUp = getExpandedCount(file.path, chunkIndex, 'up');
      // The previous chunk's "down" direction also expands into this gap.
      const expandedDownPrev =
        chunkIndex > 0 ? getExpandedCount(file.path, chunkIndex - 1, 'down') : 0;

      return Math.max(0, hiddenLines - expandedUp - expandedDownPrev);
    },
    [getExpandedCount],
  );

  /**
   * @returns `-1` when the total file line count is not yet known, `0` when a
   * later chunk's hiddenLinesBefore will compute this gap instead, otherwise
   * the actual hidden line count.
   */
  const getHiddenLinesAfter = useCallback(
    (file: DiffFile, chunk: DiffChunk, chunkIndex: number): number => {
      // Fully added/deleted files show all lines in the diff - no hidden lines
      if (file.status === 'added' || file.status === 'deleted') {
        return 0;
      }

      const fileState = expandedState[file.path];
      const totalLines = fileState?.oldTotalLines || fileState?.newTotalLines;

      if (totalLines === undefined) {
        const nextChunk = file.chunks[chunkIndex + 1];
        if (!nextChunk) {
          return -1;
        }
        return 0;
      }

      const nextChunk = file.chunks[chunkIndex + 1];
      if (nextChunk) {
        return 0;
      }

      const chunkEnd = chunk.oldStart + chunk.oldLines - 1;
      const hiddenLines = totalLines - chunkEnd;

      const expandedDown = getExpandedCount(file.path, chunkIndex, 'down');

      return Math.max(0, hiddenLines - expandedDown);
    },
    [expandedState, getExpandedCount],
  );

  const getExpandedChunk = useCallback(
    (file: DiffFile, chunk: DiffChunk, chunkIndex: number): DiffChunk => {
      const fileState = expandedState[file.path];
      if (!fileState) return chunk;

      const expandedUp = getExpandedCount(file.path, chunkIndex, 'up');
      const expandedDown = getExpandedCount(file.path, chunkIndex, 'down');

      if (expandedUp === 0 && expandedDown === 0) {
        return chunk;
      }

      const oldContent = fileState.oldContent || [];
      const newContent = fileState.newContent || [];

      const newLines: DiffLine[] = [];

      if (expandedUp > 0) {
        const prevChunk = file.chunks[chunkIndex - 1];
        let startOld: number;

        if (!prevChunk) {
          startOld = Math.max(0, chunk.oldStart - 1 - expandedUp);
        } else {
          const prevEndOld = prevChunk.oldStart + prevChunk.oldLines - 1;
          startOld = prevEndOld;
        }

        const endOld = chunk.oldStart - 1;
        const endNew = chunk.newStart - 1;

        const linesToShowOld = Math.min(expandedUp, endOld - startOld);
        const actualStartOld = endOld - linesToShowOld;
        const actualStartNew = endNew - linesToShowOld;

        for (let i = 0; i < linesToShowOld; i++) {
          const oldLineNum = actualStartOld + i + 1;
          const newLineNum = actualStartNew + i + 1;
          const content = oldContent[oldLineNum - 1] ?? newContent[newLineNum - 1] ?? '';

          newLines.push({
            type: 'normal',
            content: content,
            oldLineNumber: oldLineNum,
            newLineNumber: newLineNum,
            isExpanded: true,
          } as DiffLine);
        }
      }

      newLines.push(...chunk.lines);

      if (expandedDown > 0) {
        const chunkEndOld = chunk.oldStart + chunk.oldLines - 1;
        const chunkEndNew = chunk.newStart + chunk.newLines - 1;

        const nextChunk = file.chunks[chunkIndex + 1];
        const maxOld = nextChunk ? nextChunk.oldStart - 1 : fileState.oldTotalLines || chunkEndOld;

        const linesToShow = Math.min(expandedDown, maxOld - chunkEndOld);

        for (let i = 0; i < linesToShow; i++) {
          const oldLineNum = chunkEndOld + i + 1;
          const newLineNum = chunkEndNew + i + 1;
          const content = oldContent[oldLineNum - 1] ?? newContent[newLineNum - 1] ?? '';

          newLines.push({
            type: 'normal',
            content: content,
            oldLineNumber: oldLineNum,
            newLineNumber: newLineNum,
            isExpanded: true,
          } as DiffLine);
        }
      }

      const firstLine = newLines[0];
      const lastLine = newLines[newLines.length - 1];

      return {
        ...chunk,
        lines: newLines,
        oldStart: firstLine?.oldLineNumber ?? chunk.oldStart,
        newStart: firstLine?.newLineNumber ?? chunk.newStart,
        oldLines:
          (lastLine?.oldLineNumber ?? chunk.oldStart + chunk.oldLines - 1) -
          (firstLine?.oldLineNumber ?? chunk.oldStart) +
          1,
        newLines:
          (lastLine?.newLineNumber ?? chunk.newStart + chunk.newLines - 1) -
          (firstLine?.newLineNumber ?? chunk.newStart) +
          1,
      };
    },
    [expandedState, getExpandedCount],
  );

  const getMergedChunks = useCallback(
    (file: DiffFile): MergedChunk[] => {
      const mergedChunks: MergedChunk[] = [];

      for (let i = 0; i < file.chunks.length; i++) {
        const chunk = file.chunks[i];
        if (!chunk) continue;

        const expandedChunk = getExpandedChunk(file, chunk, i);
        const hiddenBefore = getHiddenLinesBefore(file, chunk, i);
        const hiddenAfter = getHiddenLinesAfter(file, chunk, i);

        const lastMerged = mergedChunks[mergedChunks.length - 1];
        if (lastMerged && hiddenBefore === 0) {
          lastMerged.lines = [...lastMerged.lines, ...expandedChunk.lines];
          lastMerged.originalIndices.push(i);
          lastMerged.hiddenLinesAfter = hiddenAfter;
          const lastLine = lastMerged.lines[lastMerged.lines.length - 1];
          lastMerged.oldLines =
            (lastLine?.oldLineNumber ?? lastMerged.oldStart + lastMerged.oldLines - 1) -
            lastMerged.oldStart +
            1;
          lastMerged.newLines =
            (lastLine?.newLineNumber ?? lastMerged.newStart + lastMerged.newLines - 1) -
            lastMerged.newStart +
            1;
        } else {
          mergedChunks.push({
            ...expandedChunk,
            originalIndices: [i],
            hiddenLinesBefore: hiddenBefore,
            hiddenLinesAfter: hiddenAfter,
          });
        }
      }

      return mergedChunks;
    },
    [getExpandedChunk, getHiddenLinesBefore, getHiddenLinesAfter],
  );

  return {
    expandedState,
    isLoading,
    lastUpdatedFilePath,
    lastUpdatedAt,
    expandLines,
    expandAllBetweenChunks,
    prefetchFileContent,
    getMergedChunks,
    getHiddenLinesBefore,
    getHiddenLinesAfter,
  };
}
