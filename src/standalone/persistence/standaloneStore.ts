import type { DiffCommentThread, FileExplanation, Narration } from '../../types/diff';

import type { PickedDirectoryHandle } from '../gitEngine/walkDirectory';
import { createMemoryKvStore, openIndexedDbKvStore, type KVStore } from './kvStore';

const DATABASE_NAME = 'diffops-standalone';
const COMMENT_SESSIONS_STORE = 'commentSessions';
const NARRATIONS_STORE = 'narrations';
const FILE_EXPLANATIONS_STORE = 'fileExplanations';
const REGISTERED_REPOSITORIES_STORE = 'registeredRepositories';
// v3 added narrations; v4 added file explanations; v5 replaced the recent-diff
// and last-repository stores with registered repositories — raise again when
// the set of stores changes, since the upgrade drops the ones no longer listed.
const DATABASE_VERSION = 5;

/** A persisted comment session: threads plus the version the next writer must base on. */
export interface StoredCommentSession {
  threads: DiffCommentThread[];
  version: number;
  updatedAt: string;
}

/** A narration persisted per comment session, invalidated by its fingerprint. */
export interface StoredNarration {
  narration: Narration;
  fingerprint: string;
  updatedAt: string;
}

/**
 * A whole-file explanation persisted per comment session and file path,
 * invalidated by its fingerprint.
 */
export interface StoredFileExplanation {
  explanation: FileExplanation;
  /** Supporting files already included in the prompt; empty when only the first round ran. */
  includedSupportingFiles: string[];
  fingerprint: string;
  updatedAt: string;
}

/**
 * A repository the reviewer registered on the launcher. The folder name is the
 * identity: the launcher never mounts a repository, so it cannot know the
 * repositoryId comments are keyed by.
 */
export interface RegisteredRepository {
  folderName: string;
  handle: PickedDirectoryHandle;
  registeredAt: string;
}

/**
 * Builds the storage key mirroring the server's per-selection comment sessions:
 * the same repository plus the same revision selection share comments.
 */
export const buildCommentSessionKey = (
  repositoryId: string,
  base: string,
  target: string,
  baseMode: string = '',
): string => [repositoryId, base, target, baseMode].join('|');

export const buildFileExplanationKey = (sessionKey: string, path: string): string =>
  [sessionKey, path].join('|');

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

  async loadNarration(key: string): Promise<StoredNarration | undefined> {
    return this.kv.get<StoredNarration>(NARRATIONS_STORE, key);
  }

  async saveNarration(key: string, narration: Narration, fingerprint: string): Promise<void> {
    await this.kv.put<StoredNarration>(NARRATIONS_STORE, key, {
      narration,
      fingerprint,
      updatedAt: new Date().toISOString(),
    });
  }

  async loadFileExplanation(key: string): Promise<StoredFileExplanation | undefined> {
    return this.kv.get<StoredFileExplanation>(FILE_EXPLANATIONS_STORE, key);
  }

  async saveFileExplanation(
    key: string,
    explanation: FileExplanation,
    includedSupportingFiles: string[],
    fingerprint: string,
  ): Promise<void> {
    await this.kv.put<StoredFileExplanation>(FILE_EXPLANATIONS_STORE, key, {
      explanation,
      includedSupportingFiles,
      fingerprint,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Registers a folder, replacing any registration under the same name. */
  async registerRepository(folderName: string, handle: PickedDirectoryHandle): Promise<void> {
    await this.kv.put<RegisteredRepository>(REGISTERED_REPOSITORIES_STORE, folderName, {
      folderName,
      handle,
      registeredAt: new Date().toISOString(),
    });
  }

  async loadRegisteredRepository(folderName: string): Promise<RegisteredRepository | undefined> {
    return this.kv.get<RegisteredRepository>(REGISTERED_REPOSITORIES_STORE, folderName);
  }

  async forgetRegisteredRepository(folderName: string): Promise<void> {
    await this.kv.delete(REGISTERED_REPOSITORIES_STORE, folderName);
  }

  /** Every registered repository, ordered by folder name. */
  async listRegisteredRepositories(): Promise<RegisteredRepository[]> {
    const entries = await this.kv.getAll<RegisteredRepository>(REGISTERED_REPOSITORIES_STORE);
    return entries
      .map((entry) => entry.value)
      .sort((left, right) => left.folderName.localeCompare(right.folderName));
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
        [
          COMMENT_SESSIONS_STORE,
          NARRATIONS_STORE,
          FILE_EXPLANATIONS_STORE,
          REGISTERED_REPOSITORIES_STORE,
        ],
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
