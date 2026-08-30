import { diffWords, diffWordsWithSpace } from 'diff';

export interface DiffSegment {
  value: string;
  type: 'unchanged' | 'added' | 'removed';
}

export interface WordLevelDiffResult {
  oldSegments: DiffSegment[];
  newSegments: DiffSegment[];
}

export function computeWordLevelDiff(oldContent: string, newContent: string): WordLevelDiffResult {
  const changes = diffWordsWithSpace(oldContent, newContent);

  const oldSegments: DiffSegment[] = [];
  const newSegments: DiffSegment[] = [];

  for (const change of changes) {
    if (change.added) {
      newSegments.push({ value: change.value, type: 'added' });
    } else if (change.removed) {
      oldSegments.push({ value: change.value, type: 'removed' });
    } else {
      oldSegments.push({ value: change.value, type: 'unchanged' });
      newSegments.push({ value: change.value, type: 'unchanged' });
    }
  }

  return { oldSegments, newSegments };
}

export function shouldComputeWordDiff(oldContent: string, newContent: string): boolean {
  if (!oldContent.trim() || !newContent.trim()) {
    return false;
  }

  if (oldContent === newContent) {
    return false;
  }

  const changes = diffWords(oldContent, newContent);

  let unchangedLength = 0;
  let totalLength = 0;

  for (const change of changes) {
    totalLength += change.value.length;
    if (!change.added && !change.removed) {
      unchangedLength += change.value.length;
    }
  }

  const similarityRatio = unchangedLength / totalLength;
  return similarityRatio >= 0.2;
}
