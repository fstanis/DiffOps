import type { DiffResponse } from '../types/diff';
import { parseUnifiedDiff } from '../utils/unifiedDiff';

/** A diff the standalone app has parsed out of a user-opened file. */
export interface StandaloneDiffSource {
  fileName: string;
  diff: DiffResponse;
  repositoryId: string;
}

async function hashContent(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return hex.slice(0, 16);
}

/** Reads and parses a unified diff file, throwing when it contains no diff content. */
export async function readDiffFile(file: File): Promise<StandaloneDiffSource> {
  const text = await file.text();
  const files = parseUnifiedDiff(text);

  if (files.length === 0) {
    throw new Error(
      `No unified diff content found in "${file.name}". Expected output of "git diff", "git show", or a .patch file.`,
    );
  }

  return {
    fileName: file.name,
    diff: {
      commit: file.name,
      files,
      isEmpty: false,
    },
    repositoryId: `standalone-${await hashContent(text)}`,
  };
}
