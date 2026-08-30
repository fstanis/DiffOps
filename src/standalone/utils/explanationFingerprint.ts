import { type DiffFile } from '../../types/diff';
import { getDiffContentForHashing } from './diffUtils';
import { hashString } from './narrationFingerprint';

/**
 * Fingerprints one file's change so a cached whole-file explanation is
 * invalidated when either the commit label or the file's diff moves.
 */
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
