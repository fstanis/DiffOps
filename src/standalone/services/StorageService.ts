import {
  type BaseMode,
  type DiffCommentThread,
  type ViewedFileRecord,
  type DiffContextStorage,
  type LegacyDiffContextStorage,
  type LegacyDiffComment,
  type ViewedHashIndex,
  type ViewedHashIndexEntry,
} from '../../types/diff';
import { normalizeBaseMode } from '../../utils/diffSelection';

const STORAGE_KEY_PREFIX = 'diffops-storage-v1';
const VIEWED_INDEX_PREFIX = 'diffops-viewed-index-v1';
const DEFAULT_REPO_ID = '__default__';
const MAX_VIEWED_INDEX_ENTRIES = 5000;
export const VIEWED_HASH_VERSION = 1;

function compositeKey(filePath: string, diffContentHash: string): string {
  return `${filePath} ${diffContentHash}`;
}

function migrateLegacyComment(comment: LegacyDiffComment): DiffCommentThread {
  return {
    id: comment.id,
    filePath: comment.filePath,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    position: comment.position,
    codeSnapshot: comment.codeSnapshot,
    messages: [
      {
        id: comment.id,
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      },
    ],
  };
}

function normalizeRootComment(thread: DiffCommentThread): LegacyDiffComment | null {
  const rootMessage = thread.messages[0];
  if (!rootMessage) return null;

  return {
    id: thread.id,
    filePath: thread.filePath,
    body: rootMessage.body,
    author: rootMessage.author,
    createdAt: rootMessage.createdAt,
    updatedAt: rootMessage.updatedAt,
    position: thread.position,
    codeSnapshot: thread.codeSnapshot,
  };
}

export class StorageService {
  private generateStorageKey(
    baseCommitish: string,
    targetCommitish: string,
    baseMode?: BaseMode,
  ): string {
    const encode = (str: string) =>
      str.replace(/[^a-zA-Z0-9-_]/g, (char) => {
        return `_${char.charCodeAt(0).toString(16)}_`;
      });

    const baseKey = `${encode(baseCommitish)}-${encode(targetCommitish)}`;

    if (normalizeBaseMode(baseMode) === 'merge-base') {
      return `${baseKey}-merge-base`;
    }

    return baseKey;
  }

  private getFullStorageKey(repositoryId: string | undefined, key: string): string {
    if (repositoryId) {
      return `${STORAGE_KEY_PREFIX}/${repositoryId}/${key}`;
    }
    return `${STORAGE_KEY_PREFIX}/${key}`;
  }

  private normalizeCommitish(
    commitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
  ): string {
    if (commitish === '.' || commitish === 'working') {
      return 'WORKING';
    }
    if (commitish === 'staged') {
      return 'STAGED';
    }

    // @ is git shorthand for HEAD.
    if ((commitish === 'HEAD' || commitish === '@') && currentCommitHash) {
      return currentCommitHash;
    }

    if (branchToHash?.has(commitish)) {
      const hash = branchToHash.get(commitish);
      if (hash) {
        return hash;
      }
    }

    // Symbolic refs like @^ or @~1 can't be normalized without a commit hash and may collide across commits; warn when unresolved.
    if (
      commitish.startsWith('@') ||
      commitish.includes('^') ||
      commitish.includes('~') ||
      commitish.includes('HEAD')
    ) {
      console.warn(
        `[StorageService] Cannot normalize symbolic ref '${commitish}' - may cause key collision. ` +
          `currentCommitHash=${currentCommitHash}`,
      );
    }

    return commitish;
  }

  private getStorageKey(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): string {
    const normalizedBase = this.normalizeStorageBase(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
    );
    const normalizedTarget = this.normalizeStorageTarget(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
    );

    const key = this.generateStorageKey(normalizedBase, normalizedTarget, baseMode);
    return this.getFullStorageKey(repositoryId, key);
  }

  getDiffContextData(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): DiffContextStorage | null {
    try {
      const key = this.getStorageKey(
        baseCommitish,
        targetCommitish,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      const data = localStorage.getItem(key);

      if (!data) return null;

      const parsed = JSON.parse(data) as DiffContextStorage | LegacyDiffContextStorage;
      if (parsed.version === 2 && 'threads' in parsed) {
        return parsed;
      }

      if (parsed.version === 1 && 'comments' in parsed) {
        return {
          version: 2,
          baseCommitish: parsed.baseCommitish,
          targetCommitish: parsed.targetCommitish,
          createdAt: parsed.createdAt,
          lastModifiedAt: parsed.lastModifiedAt,
          threads: parsed.comments.map(migrateLegacyComment),
          viewedFiles: parsed.viewedFiles,
          appliedCommentImportIds: [],
        };
      }

      console.warn(`Unknown storage version: ${String((parsed as { version?: unknown }).version)}`);
      return null;
    } catch (error) {
      console.error('Error reading diff context data:', error);
      return null;
    }
  }

  private normalizeStorageBase(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
  ): string {
    if (targetCommitish === '.' || targetCommitish === 'working' || targetCommitish === 'staged') {
      return currentCommitHash || baseCommitish;
    }

    return this.normalizeCommitish(baseCommitish, currentCommitHash, branchToHash);
  }

  private normalizeStorageTarget(
    _baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
  ): string {
    if (targetCommitish === '.' || targetCommitish === 'working') {
      return 'WORKING';
    }

    if (targetCommitish === 'staged') {
      return 'STAGED';
    }

    return this.normalizeCommitish(targetCommitish, currentCommitHash, branchToHash);
  }

  saveDiffContextData(
    baseCommitish: string,
    targetCommitish: string,
    data: DiffContextStorage,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): void {
    try {
      const key = this.getStorageKey(
        baseCommitish,
        targetCommitish,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      const dataToSave: DiffContextStorage = {
        ...data,
        version: 2,
        baseCommitish,
        targetCommitish,
        baseMode,
        lastModifiedAt: new Date().toISOString(),
        appliedCommentImportIds: data.appliedCommentImportIds || [],
      };
      localStorage.setItem(key, JSON.stringify(dataToSave));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('localStorage quota exceeded');
      } else {
        console.error('Error saving diff context data:', error);
      }
    }
  }

  getCommentThreads(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): DiffCommentThread[] {
    const data = this.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
    return data?.threads || [];
  }

  /**
   * Legacy flat comment accessor retained for compatibility
   */
  getComments(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): LegacyDiffComment[] {
    return this.getCommentThreads(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    )
      .map((thread) => normalizeRootComment(thread))
      .filter((comment): comment is LegacyDiffComment => comment !== null);
  }

  saveCommentThreads(
    baseCommitish: string,
    targetCommitish: string,
    threads: DiffCommentThread[],
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): void {
    const existingData = this.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
    const data: DiffContextStorage = existingData || {
      version: 2,
      baseCommitish,
      targetCommitish,
      baseMode,
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
      threads: [],
      viewedFiles: [],
      appliedCommentImportIds: [],
    };

    data.threads = threads;
    this.saveDiffContextData(
      baseCommitish,
      targetCommitish,
      data,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
  }

  /**
   * Legacy flat comment writer retained for compatibility
   */
  saveComments(
    baseCommitish: string,
    targetCommitish: string,
    comments: LegacyDiffComment[],
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): void {
    this.saveCommentThreads(
      baseCommitish,
      targetCommitish,
      comments.map(migrateLegacyComment),
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
  }

  getViewedFiles(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): ViewedFileRecord[] {
    const data = this.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
    return data?.viewedFiles || [];
  }

  saveViewedFiles(
    baseCommitish: string,
    targetCommitish: string,
    files: ViewedFileRecord[],
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): void {
    const existingData = this.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
    const data: DiffContextStorage = existingData || {
      version: 2,
      baseCommitish,
      targetCommitish,
      baseMode,
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
      threads: [],
      viewedFiles: [],
      appliedCommentImportIds: [],
    };

    data.viewedFiles = files;
    this.saveDiffContextData(
      baseCommitish,
      targetCommitish,
      data,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
  }

  private getViewedHashIndexKey(repositoryId: string | undefined): string {
    return `${VIEWED_INDEX_PREFIX}/${repositoryId ?? DEFAULT_REPO_ID}`;
  }

  /**
   * Keyed by `(filePath, diffContentHash)`: multiple hashes may exist per filePath so the same
   * file can keep independent viewed state across different comparison ranges.
   */
  getViewedHashIndex(repositoryId?: string): ViewedHashIndex {
    const empty: ViewedHashIndex = {
      version: 1,
      lastModifiedAt: new Date(0).toISOString(),
      entries: [],
    };
    try {
      const raw = localStorage.getItem(this.getViewedHashIndexKey(repositoryId));
      if (!raw) return empty;
      const parsed = JSON.parse(raw) as ViewedHashIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return empty;
      return parsed;
    } catch (error) {
      console.error('Error reading viewed hash index:', error);
      return empty;
    }
  }

  private writeViewedHashIndex(repositoryId: string | undefined, index: ViewedHashIndex): void {
    try {
      localStorage.setItem(
        this.getViewedHashIndexKey(repositoryId),
        JSON.stringify({ ...index, lastModifiedAt: new Date().toISOString() }),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('localStorage quota exceeded while writing viewed hash index');
      } else {
        console.error('Error saving viewed hash index:', error);
      }
    }
  }

  /**
   * Upsert entries into the per-repository viewed-hash index, then trim the
   * oldest entries (by viewedAt) once the cap is exceeded.
   */
  recordViewedHashes(repositoryId: string | undefined, entries: ViewedHashIndexEntry[]): void {
    if (entries.length === 0) return;
    const index = this.getViewedHashIndex(repositoryId);
    const byKey = new Map(
      index.entries.map((entry) => [compositeKey(entry.filePath, entry.diffContentHash), entry]),
    );
    for (const entry of entries) {
      byKey.set(compositeKey(entry.filePath, entry.diffContentHash), entry);
    }

    let next = Array.from(byKey.values());
    if (next.length > MAX_VIEWED_INDEX_ENTRIES) {
      next.sort((a, b) => (a.viewedAt < b.viewedAt ? 1 : -1));
      next = next.slice(0, MAX_VIEWED_INDEX_ENTRIES);
    }

    this.writeViewedHashIndex(repositoryId, {
      version: 1,
      lastModifiedAt: index.lastModifiedAt,
      entries: next,
    });
  }

  /**
   * Remove specific `(filePath, diffContentHash)` entries from the per-repository
   * viewed-hash index. Only the matching entry is dropped, so a file viewed in
   * other comparison ranges retains its hash entries.
   */
  removeViewedHashes(
    repositoryId: string | undefined,
    entries: Array<{ filePath: string; diffContentHash: string }>,
  ): void {
    if (entries.length === 0) return;
    const index = this.getViewedHashIndex(repositoryId);
    const drop = new Set(
      entries.map((entry) => compositeKey(entry.filePath, entry.diffContentHash)),
    );
    const next = index.entries.filter(
      (entry) => !drop.has(compositeKey(entry.filePath, entry.diffContentHash)),
    );
    if (next.length === index.entries.length) return;

    this.writeViewedHashIndex(repositoryId, {
      version: 1,
      lastModifiedAt: index.lastModifiedAt,
      entries: next,
    });
  }

  clearViewedHashIndex(repositoryId?: string): void {
    try {
      localStorage.removeItem(this.getViewedHashIndexKey(repositoryId));
    } catch (error) {
      console.error('Error clearing viewed hash index:', error);
    }
  }

  cleanupOldData(daysToKeep: number): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTime = cutoffDate.getTime();

    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;

      const isContextKey = key.startsWith(STORAGE_KEY_PREFIX);
      const isIndexKey = key.startsWith(VIEWED_INDEX_PREFIX);
      if (!isContextKey && !isIndexKey) continue;

      try {
        const data = localStorage.getItem(key);
        if (!data) continue;

        const parsed = JSON.parse(data) as { lastModifiedAt?: string };
        const lastModifiedRaw = parsed.lastModifiedAt;
        if (!lastModifiedRaw) continue;

        const lastModified = new Date(lastModifiedRaw).getTime();
        if (Number.isFinite(lastModified) && lastModified < cutoffTime) {
          keysToRemove.push(key);
        }
      } catch {
        // Skip invalid entries
      }
    }

    keysToRemove.forEach((key) => localStorage.removeItem(key));
  }

  getStorageSize(): number {
    let totalSize = 0;

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!key.startsWith(STORAGE_KEY_PREFIX) && !key.startsWith(VIEWED_INDEX_PREFIX)) continue;

      const value = localStorage.getItem(key);
      if (value) {
        // Rough estimate: 2 bytes per character (UTF-16)
        totalSize += (key.length + value.length) * 2;
      }
    }

    return totalSize;
  }
}

export const storageService = new StorageService();
