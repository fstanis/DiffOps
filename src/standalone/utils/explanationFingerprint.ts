import { type DiffFile } from '../../types/diff';
import { getDiffContentForHashing } from './diffUtils';
import { hashString } from './narrationFingerprint';

/** Invalidates a cached explanation when the commit label or the file's diff changes. */
export function buildFileExplanationFingerprint(commitLabel: string, file: DiffFile): string {
  return hashString(
    JSON.stringify({
      commitLabel,
      path: file.path,
      oldPath: file.oldPath ?? '',
      status: file.status,
      diff: getDiffContentForHashing(file),
    }),
  );
}
