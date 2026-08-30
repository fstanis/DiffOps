import type { DiffCommentThread } from '../../types/diff';

import type { PickedDirectoryHandle } from '../gitEngine/walkDirectory';
import { createMemoryKvStore, openIndexedDbKvStore, type KVStore } from './kvStore';

const DATABASE_NAME = 'diffops-standalone';
const COMMENT_SESSIONS_STORE = 'commentSessions';
const RECENT_DIFFS_STORE = 'recentDiffs';
const RECENT_REPOS_STORE = 'recentRepos';
const LAST_REPO_KEY = 'last';
const RECENT_DIFF_LIMIT = 10;
// v2 added recentRepos; raise again whenever a new store joins the list.
const DATABASE_VERSION = 2;

/** A persisted comment session: threads plus the version the next writer must base on. */
export interface StoredCommentSession {
  threads: DiffCommentThread[];
  version: number;
  updatedAt: string;
}

/** One entry of the "recent diffs" diary, keyed by diff content and file name. */
export interface RecentDiffEntry {
  key: string;
  fileName: string;
  repositoryId: string;
  fileSize: number;
  openedAt: string;
  /** Monotonic ordering; openedAt alone can tie within one millisecond. */
  sequence: number;
}

/** A recent-diffs entry decorated with the diff's persisted comment count. */
export interface RecentDiffSummary extends RecentDiffEntry {
  commentCount: number;
}

/** The last opened repository: its directory handle (re-grantable) plus identity. */
export interface StoredLastRepo {
  repoName: string;
  repositoryId: string;
  openedAt: string;
  handle: PickedDirectoryHandle;
}

/**
 * Builds the storage key mirroring the server's per-selection comment sessions:
 * the same diff content (repositoryId is a content hash) plus the same
 * pseudo-refs share comments.
 */
export const buildCommentSessionKey = (
  repositoryId: string,
  base: string,
  target: string,
  baseMode: string = '',
): string => [repositoryId, base, target, baseMode].join('|');

/** IndexedDB-backed persistence for the standalone app (see kvStore.ts for the fallback story). */
export class StandaloneStore {
  private readonly kv: KVStore;

  constructor(kv: KVStore) {
    this.kv = kv;
  }

  async loadCommentSession(key: string): Promise<StoredCommentSession | undefined> {
    return this.kv.get<StoredCommentSession>(COMMENT_SESSIONS_STORE, key);
  }

  async saveCommentSession(
    key: string,
    threads: DiffCommentThread[],
    version: number,
  ): Promise<void> {
    await this.kv.put<StoredCommentSession>(COMMENT_SESSIONS_STORE, key, {
      threads,
      version,
      updatedAt: new Date().toISOString(),
    });
  }

  async countCommentThreads(repositoryId: string): Promise<number> {
    const sessions = await this.kv.getAll<StoredCommentSession>(COMMENT_SESSIONS_STORE);
    return sessions
      .filter((session) => session.key.startsWith(`${repositoryId}|`))
      .reduce((total, session) => total + session.value.threads.length, 0);
  }

  async recordRecentDiff(fileName: string, repositoryId: string, fileSize: number): Promise<void> {
    const key = `${repositoryId}:${fileName}`;
    const entries = await this.listRecentDiffEntries();
    const sequence = (entries[0]?.sequence ?? 0) + 1;
    await this.kv.put<RecentDiffEntry>(RECENT_DIFFS_STORE, key, {
      key,
      fileName,
      repositoryId,
      fileSize,
      openedAt: new Date().toISOString(),
      sequence,
    });

    // Prune from the post-put state so the stored list never exceeds the cap.
    const latest = await this.listRecentDiffEntries();
    const excess = latest
      .slice(RECENT_DIFF_LIMIT)
      .map((entry) => this.kv.delete(RECENT_DIFFS_STORE, entry.key));
    await Promise.all(excess);
  }

  async forgetRecentDiff(key: string): Promise<void> {
    await this.kv.delete(RECENT_DIFFS_STORE, key);
  }

  async saveLastRepo(entry: StoredLastRepo): Promise<void> {
    await this.kv.put<StoredLastRepo>(RECENT_REPOS_STORE, LAST_REPO_KEY, entry);
  }

  async loadLastRepo(): Promise<StoredLastRepo | undefined> {
    return this.kv.get<StoredLastRepo>(RECENT_REPOS_STORE, LAST_REPO_KEY);
  }

  async forgetLastRepo(): Promise<void> {
    await this.kv.delete(RECENT_REPOS_STORE, LAST_REPO_KEY);
  }

  async listRecentDiffs(): Promise<RecentDiffSummary[]> {
    const entries = await this.listRecentDiffEntries();
    return Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        commentCount: await this.countCommentThreads(entry.repositoryId),
      })),
    );
  }

  private async listRecentDiffEntries(): Promise<RecentDiffEntry[]> {
    const entries = await this.kv.getAll<RecentDiffEntry>(RECENT_DIFFS_STORE);
    return entries
      .map((entry) => entry.value)
      .sort((left, right) => right.sequence - left.sequence);
  }
}

const openBestEffortStore = (): StandaloneStore => {
  if (typeof indexedDB === 'undefined') {
    return new StandaloneStore(createMemoryKvStore());
  }
  try {
    return new StandaloneStore(
      openIndexedDbKvStore(
        DATABASE_NAME,
        [COMMENT_SESSIONS_STORE, RECENT_DIFFS_STORE, RECENT_REPOS_STORE],
        { version: DATABASE_VERSION },
      ),
    );
  } catch (error) {
    console.warn('diffops: IndexedDB unavailable, persistence is session-only:', error);
    return new StandaloneStore(createMemoryKvStore());
  }
};

let store: StandaloneStore | null = null;

/** Returns the app-wide standalone store, opening it (best-effort) on first use. */
export const getStandaloneStore = (): StandaloneStore => {
  store ??= openBestEffortStore();
  return store;
};

/** Drops the app-wide store so the next getStandaloneStore() reopens storage. */
export const resetStandaloneStoreForTests = (): void => {
  store = null;
};
