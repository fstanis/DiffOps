// Repository read policy: mount exactly what the git engine needs instead of
// the whole picked folder. Phase 1 walks `.git` keeping only the paths libgit2
// reads (see gitDirPaths.ts); the index it yields then drives phase 2, which
// touches only tracked worktree paths plus each submodule's gitdir marker.
// The engine never runs `status` (see git-worker.ts) and none of its diff,
// log, or cat-file commands report untracked files, so everything else —
// node_modules, build output, ignored trees — is skipped entirely.

import { isMirroredGitDirectory, isMirroredGitPath } from './gitDirPaths';
import {
  findBlockingIndexExtension,
  findUnsupportedIndexEntries,
  parseTrackedWorktreePaths,
  type BlockingIndexExtension,
} from './lg2OutputParsers';
import {
  walkDirectoryHandle,
  type PickedDirectoryHandle,
  type PickedHandle,
  type WalkedFile,
  type WalkOptions,
} from './walkDirectory';

/** Reasons phase 2 falls back to walking the whole worktree. */
export type FullWalkReason =
  | 'none'
  | 'missing-index'
  | 'unreadable-index'
  | 'unsupported-index-version';

export type { BlockingIndexExtension };

export interface RepositoryWalkProgress {
  phase: 'git' | 'worktree';
  filesFound: number;
  bytesFound: number;
  /** Tracked-file total; 0 until the index is parsed. */
  totalFiles: number;
}

export interface RepositoryWalk {
  /** `.git` mirror files then tracked worktree files — the worker mount payload. */
  files: WalkedFile[];
  unreadablePaths: string[];
  /** Tracked paths the folder no longer has: staged deletions, sparse checkout. */
  missingTrackedPaths: string[];
  fullWalkReason: FullWalkReason;
  /** Set when the index is one libgit2 cannot open at all; nothing was walked. */
  blockingIndexExtension?: BlockingIndexExtension;
}

const normalizeNfc = (path: string): string => path.normalize('NFC');

const isUnsupportedVersionError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('Unsupported git index version');

/**
 * Reads a repository folder into the worker mount payload. A `link` or `sdir`
 * index returns early with `blockingIndexExtension` (the engine cannot open
 * those repositories at all, so a full walk would only delay the failure);
 * every other unparseable index falls back to today's whole-tree walk.
 */
export const walkRepositoryHandle = async (
  handle: PickedDirectoryHandle,
  options?: { onProgress?: (progress: RepositoryWalkProgress) => void },
): Promise<RepositoryWalk> => {
  const gitEntry = await findGitEntry(handle);
  if (!gitEntry) {
    // The worker raises its existing "No .git directory found" error.
    return {
      files: [],
      unreadablePaths: [],
      missingTrackedPaths: [],
      fullWalkReason: 'missing-index',
    };
  }
  if (gitEntry.kind === 'file') {
    // Stop here so verifyRepository can raise its worktree/submodule message.
    try {
      return {
        files: [{ path: '.git', file: await gitEntry.getFile() }],
        unreadablePaths: [],
        missingTrackedPaths: [],
        fullWalkReason: 'none',
      };
    } catch {
      return {
        files: [],
        unreadablePaths: ['.git'],
        missingTrackedPaths: [],
        fullWalkReason: 'none',
      };
    }
  }

  const gitWalk = await walkDirectoryHandle(gitEntry, {
    shouldDescend: isMirroredGitDirectory,
    shouldTake: isMirroredGitPath,
    onProgress: (progress) => {
      options?.onProgress?.({ ...progress, phase: 'git', totalFiles: 0 });
    },
  });
  const gitFiles = gitWalk.files.map(({ path, file }) => ({ path: `.git/${path}`, file }));
  const unreadablePaths = gitWalk.unreadablePaths.map((path) => (path ? `.git/${path}` : '.git'));

  const indexEntry = gitWalk.files.find(({ path }) => path === 'index');
  if (!indexEntry) {
    return finishWithFallback(handle, gitFiles, unreadablePaths, 'missing-index', options);
  }

  let indexBytes: Uint8Array;
  try {
    indexBytes = new Uint8Array(await indexEntry.file.arrayBuffer());
  } catch {
    return finishWithFallback(handle, gitFiles, unreadablePaths, 'unreadable-index', options);
  }

  let trackedPaths: string[];
  try {
    const blockingExtension = findBlockingIndexExtension(indexBytes);
    if (blockingExtension) {
      return {
        files: gitFiles,
        unreadablePaths,
        missingTrackedPaths: [],
        fullWalkReason: 'none',
        blockingIndexExtension: blockingExtension,
      };
    }
    trackedPaths = parseTrackedWorktreePaths(indexBytes);
  } catch (error) {
    const reason = isUnsupportedVersionError(error)
      ? 'unsupported-index-version'
      : 'unreadable-index';
    return finishWithFallback(handle, gitFiles, unreadablePaths, reason, options);
  }

  const { symlinkPaths, gitlinkPaths } = findUnsupportedIndexEntries(indexBytes);

  // Index spellings map through NFC so a folder whose names decompose
  // differently (macOS stores NFD, git indexes what it read) still matches;
  // the trie is never case-folded, because case collisions are real on
  // case-sensitive volumes and the per-path retry covers the rare mismatch.
  const trackedFileSpellings = new Map<string, string>();
  const trackedDirectories = new Set<string>();
  for (const trackedPath of trackedPaths) {
    trackedFileSpellings.set(normalizeNfc(trackedPath), trackedPath);
    const segments = trackedPath.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      trackedDirectories.add(normalizeNfc(segments.slice(0, depth).join('/')));
    }
  }

  // Gitlink directories are descended into even though nothing under them is
  // tracked, so their `.git` marker (file or directory) reaches the mount —
  // without any node at the gitlink path libgit2 reports a false deletion.
  const submoduleDirectories = new Set<string>();
  const submoduleGitPrefixes: string[] = [];
  for (const gitlinkPath of gitlinkPaths) {
    const nfcPath = normalizeNfc(gitlinkPath);
    submoduleDirectories.add(nfcPath);
    const segments = gitlinkPath.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      submoduleDirectories.add(normalizeNfc(segments.slice(0, depth).join('/')));
    }
    submoduleGitPrefixes.push(`${nfcPath}/.git/`);
  }
  /** Path relative to a submodule's own `.git`, '' for the marker itself, or null. */
  const submoduleGitRelative = (nfcPath: string): string | null => {
    for (const prefix of submoduleGitPrefixes) {
      if (nfcPath === prefix.slice(0, -1)) {
        return '';
      }
      if (nfcPath.startsWith(prefix)) {
        return nfcPath.slice(prefix.length);
      }
    }
    return null;
  };

  // The retry needs the handle of each descended directory, keyed alongside
  // the trie so Unicode and case drift cannot hide the parent.
  const directoriesByNfc = new Map<string, PickedDirectoryHandle>();
  const worktreeOptions: WalkOptions = {
    shouldDescend: (path) => {
      const nfcPath = normalizeNfc(path);
      const subRelative = submoduleGitRelative(nfcPath);
      if (subRelative !== null) {
        return isMirroredGitDirectory(subRelative);
      }
      return trackedDirectories.has(nfcPath) || submoduleDirectories.has(nfcPath);
    },
    shouldTake: (path) => {
      const nfcPath = normalizeNfc(path);
      const subRelative = submoduleGitRelative(nfcPath);
      if (subRelative === '') {
        return true;
      }
      if (subRelative !== null) {
        return isMirroredGitPath(subRelative);
      }
      return trackedFileSpellings.has(nfcPath);
    },
    onDirectory: (path, directoryHandle) => {
      directoriesByNfc.set(normalizeNfc(path), directoryHandle);
    },
    onProgress: (progress) => {
      options?.onProgress?.({ ...progress, phase: 'worktree', totalFiles: trackedPaths.length });
    },
  };

  const worktreeWalk = await walkDirectoryHandle(handle, worktreeOptions);
  unreadablePaths.push(...worktreeWalk.unreadablePaths);

  const files: WalkedFile[] = [...gitFiles];
  const mountedTrackedPaths = new Set<string>();
  for (const { path, file } of worktreeWalk.files) {
    if (submoduleGitRelative(normalizeNfc(path)) !== null) {
      // Submodule gitdir internals keep the on-disk spelling, as today.
      files.push({ path, file });
      continue;
    }
    const indexSpelling = trackedFileSpellings.get(normalizeNfc(path));
    if (indexSpelling) {
      files.push({ path: indexSpelling, file });
      mountedTrackedPaths.add(indexSpelling);
    }
  }

  // Chromium's FSA resolves names the enumeration spells differently (NFC
  // stored under an NFD query, case drift on case-insensitive volumes), so
  // each missing tracked path gets one bounded lookup through its parent.
  const retryMissingFile = async (trackedPath: string): Promise<File | null> => {
    const separatorAt = trackedPath.lastIndexOf('/');
    const parentPath = separatorAt === -1 ? '' : trackedPath.slice(0, separatorAt);
    const parent = parentPath === '' ? handle : directoriesByNfc.get(normalizeNfc(parentPath));
    if (!parent?.getFileHandle) {
      return null;
    }
    try {
      return await (await parent.getFileHandle(trackedPath.slice(separatorAt + 1))).getFile();
    } catch {
      return null;
    }
  };

  const symlinkPathSet = new Set(symlinkPaths);
  const missingTrackedPaths: string[] = [];
  for (const trackedPath of trackedPaths) {
    if (mountedTrackedPaths.has(trackedPath)) {
      continue;
    }
    // Symlinks are unreachable through the FSA entirely; the engine's symlink
    // warning carries them instead of the missing-path log.
    if (symlinkPathSet.has(trackedPath)) {
      continue;
    }
    const file = await retryMissingFile(trackedPath);
    if (file) {
      files.push({ path: trackedPath, file });
    } else {
      missingTrackedPaths.push(trackedPath);
    }
  }

  return { files, unreadablePaths, missingTrackedPaths, fullWalkReason: 'none' };
};

const findGitEntry = async (handle: PickedDirectoryHandle): Promise<PickedHandle | undefined> => {
  try {
    for await (const [name, entry] of handle.entries()) {
      if (name === '.git') {
        return entry;
      }
    }
  } catch {
    // An unlistable root leaves nothing to walk; the worker's own
    // "No .git directory found" error is the clearest result left.
  }
  return undefined;
};

/** Today's behaviour: mirrored `.git` plus every worktree file except `.git`. */
const finishWithFallback = async (
  handle: PickedDirectoryHandle,
  gitFiles: WalkedFile[],
  unreadablePaths: string[],
  fullWalkReason: FullWalkReason,
  options?: { onProgress?: (progress: RepositoryWalkProgress) => void },
): Promise<RepositoryWalk> => {
  const worktreeWalk = await walkDirectoryHandle(handle, {
    shouldDescend: (path) => path !== '.git',
    onProgress: (progress) => {
      options?.onProgress?.({ ...progress, phase: 'worktree', totalFiles: 0 });
    },
  });
  return {
    files: [...gitFiles, ...worktreeWalk.files],
    unreadablePaths: [...unreadablePaths, ...worktreeWalk.unreadablePaths],
    missingTrackedPaths: [],
    fullWalkReason,
  };
};
