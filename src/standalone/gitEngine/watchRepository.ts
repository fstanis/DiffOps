// Repository change watching: a FileSystemObserver over the picked folder,
// used purely as a signal that the Refresh button should light up — nothing
// moves under the reader and no refresh is ever triggered automatically.
// Progressive enhancement throughout: a missing API, a rejected observe()
// (e.g. a handle whose read permission lapsed, or an exhausted inotify
// budget on Linux) resolves to null and the app behaves exactly as before.

import type { PickedDirectoryHandle } from './walkDirectory';

/** Structural slice of the FileSystemObserver proposal (Chrome 133+). */
interface ObserverRecord {
  type: 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';
  relativePathComponents?: readonly string[];
}

interface ObserverLike {
  observe(target: unknown, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}

type ObserverConstructor = new (
  callback: (records: ObserverRecord[], observer: ObserverLike) => void,
) => ObserverLike;

export interface RepositoryWatcher {
  disconnect(): void;
}

const DEFAULT_DEBOUNCE_MS = 250;

// git's own churn never means "the review is stale": lock files while a
// command runs, reflog appends, the commit-message scratch file.
const isNoise = (path: string): boolean =>
  path.endsWith('.lock') || path.startsWith('.git/logs/') || path === '.git/COMMIT_EDITMSG';

/**
 * Watches the repository folder for changes made by anything — including
 * other processes such as git run from a terminal. Records are coalesced on
 * a leading edge: the first unfiltered record fires immediately and the rest
 * inside the window are swallowed, so a large `git checkout` (thousands of
 * one-record callbacks) lights the button once instead of resetting a
 * trailing timer for as long as the checkout takes.
 */
export const watchRepository = async (
  handle: PickedDirectoryHandle,
  options: { onChanged: () => void; debounceMs?: number },
): Promise<RepositoryWatcher | null> => {
  const Observer = (globalThis as { FileSystemObserver?: ObserverConstructor }).FileSystemObserver;
  if (!Observer) {
    return null;
  }
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let isDisconnected = false;
  let lastFiredAt = -Infinity;

  let observer: ObserverLike;
  try {
    observer = new Observer((records) => {
      if (isDisconnected) {
        return;
      }
      // A moved record's destination is the signal — `moved .git/index from
      // .git/index.lock` is the single most reliable "the index changed"
      // event git produces — so noise filtering never looks at the source.
      // `errored` is terminal (no further records will ever arrive): treat
      // it as changed and disconnect below. `unknown` means changes happened
      // without their type or order being exposed.
      const isChanged = records.some((record) => {
        if (record.type === 'unknown' || record.type === 'errored') {
          return true;
        }
        const destination = (record.relativePathComponents ?? []).join('/');
        return !isNoise(destination);
      });
      if (!isChanged) {
        return;
      }
      const now = Date.now();
      if (now - lastFiredAt < debounceMs) {
        return;
      }
      lastFiredAt = now;
      options.onChanged();
      if (records.some((record) => record.type === 'errored')) {
        isDisconnected = true;
        observer.disconnect();
      }
    });
    // Observation requires a live read-permission grant; a handle sitting at
    // "prompt" rejects here.
    await observer.observe(handle, { recursive: true });
  } catch {
    return null;
  }

  return {
    disconnect: () => {
      isDisconnected = true;
      observer.disconnect();
    },
  };
};
