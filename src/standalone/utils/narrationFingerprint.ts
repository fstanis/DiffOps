import { type DiffFile, type Narration } from '../../types/diff';
import { getDiffContentForHashing } from './diffUtils';

// Deterministic per payload, not cryptographically strong; a narration is only
// invalidated, never secured, by this hash.
const hashString = (value: string): string => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * Fingerprints a changeset so a cached narration can be invalidated when the
 * diff moves: commit label, the sorted changed-file list, and per-file diffs.
 */
export function buildChangesetFingerprint(commitLabel: string, files: DiffFile[]): string {
  const entries = files
    .map((file) => ({
      path: file.path,
      oldPath: file.oldPath ?? '',
      status: file.status,
      diff: getDiffContentForHashing(file),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return hashString(JSON.stringify({ commitLabel, entries }));
}

/**
 * Reorders files into the narration's review order; files the narration omits
 * keep their git-order position at the end.
 */
export function orderFilesByNarration(files: DiffFile[], narration: Narration): DiffFile[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const ordered: DiffFile[] = [];
  const seen = new Set<string>();

  for (const card of narration.cards) {
    const file = filesByPath.get(card.path);
    if (!file || seen.has(card.path)) {
      continue;
    }
    seen.add(card.path);
    ordered.push(file);
  }

  for (const file of files) {
    if (!seen.has(file.path)) {
      ordered.push(file);
    }
  }

  return ordered;
}
