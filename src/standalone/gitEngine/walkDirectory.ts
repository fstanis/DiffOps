// Folder access for the git engine: recursive walk of a picked directory
// handle into {path, file} pairs (the WORKERFS mount payload), with progress
// reporting for the UI. Structural types keep the picker seam testable.

/** Structural slice of FileSystemFileHandle the walker needs. */
export interface PickedFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

/** Structural slice of FileSystemDirectoryHandle the app needs (incl. permissions). */
export interface PickedDirectoryHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[name: string, handle: PickedHandle]>;
  /** Present on real handles; resolves a child file even when `entries()` spells its name differently. */
  getFileHandle?(name: string): Promise<PickedFileHandle>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export type PickedHandle = PickedFileHandle | PickedDirectoryHandle;

/** A picked file addressed by its repo-relative path. */
export interface WalkedFile {
  path: string;
  file: File;
}

interface WalkProgress {
  filesFound: number;
  bytesFound: number;
}

/** The walked snapshot plus the entries that could not be read. */
export interface WalkResult {
  files: WalkedFile[];
  unreadablePaths: string[];
}

export interface WalkOptions {
  /** Skip a directory and everything under it. Not consulted for the walk root. */
  shouldDescend?: (path: string) => boolean;
  /** Skip taking a File handle for this path. */
  shouldTake?: (path: string) => boolean;
  onProgress?: (progress: WalkProgress) => void;
  /** Receives every directory handle the walk descends into, keyed by its walked path. */
  onDirectory?: (path: string, handle: PickedDirectoryHandle) => void;
}

// Progress ticks at most ~10/s: a per-file callback on a 300k-file worktree
// becomes a re-render storm in the UI layer.
const PROGRESS_INTERVAL_MS = 100;

/**
 * Every file's File handle is taken eagerly so the WORKERFS mount sees a
 * point-in-time snapshot. Entries are read concurrently — a serial
 * await-per-file walk makes huge worktrees (100k+ files) take minutes, while
 * pipelined getFile calls are bounded only by the browser's file-system
 * queue. Result order is unspecified; consumers address files by path.
 * Entries that fail to read (a file moved mid-walk, a permission edge) are
 * collected into unreadablePaths instead of failing the whole walk.
 */
export const walkDirectoryHandle = async (
  handle: PickedDirectoryHandle,
  options?: WalkOptions,
): Promise<WalkResult> => {
  const files: WalkedFile[] = [];
  const unreadablePaths: string[] = [];
  let bytesFound = 0;
  let lastProgressAt = 0;

  const reportProgress = (): void => {
    if (!options?.onProgress) {
      return;
    }
    const now = performance.now();
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    lastProgressAt = now;
    options.onProgress({ filesFound: files.length, bytesFound });
  };

  const walk = async (directory: PickedDirectoryHandle, prefix: string): Promise<void> => {
    const children: [string, PickedHandle][] = [];
    try {
      for await (const entry of directory.entries()) {
        children.push(entry);
      }
    } catch {
      unreadablePaths.push(prefix.replace(/\/$/, ''));
      return;
    }
    await Promise.all(
      children.map(async ([name, entry]) => {
        if (entry.kind === 'file') {
          if (options?.shouldTake?.(prefix + name) === false) {
            return;
          }
          try {
            const file = await entry.getFile();
            files.push({ path: prefix + name, file });
            bytesFound += file.size;
          } catch {
            unreadablePaths.push(prefix + name);
          }
          reportProgress();
        } else {
          const directoryPath = prefix + name;
          if (options?.shouldDescend?.(directoryPath) === false) {
            return;
          }
          options?.onDirectory?.(directoryPath, entry);
          await walk(entry, `${directoryPath}/`);
        }
      }),
    );
  };

  await walk(handle, '');
  options?.onProgress?.({ filesFound: files.length, bytesFound });
  return { files, unreadablePaths };
};

export type PermissionName = 'granted' | 'denied' | 'prompt';

/** Reads whether a stored handle may still be read, defaulting to "granted". */
export const queryReadPermission = async (
  handle: PickedDirectoryHandle,
): Promise<PermissionName> => {
  if (!handle.queryPermission) {
    return 'granted';
  }
  return (await handle.queryPermission({ mode: 'read' })) as PermissionName;
};

/**
 * Re-requests read access for a stored handle; must run inside a user gesture
 * or the browser rejects the prompt.
 */
export const requestReadPermission = async (
  handle: PickedDirectoryHandle,
): Promise<PermissionName> => {
  if (!handle.requestPermission) {
    return 'granted';
  }
  return (await handle.requestPermission({ mode: 'read' })) as PermissionName;
};
