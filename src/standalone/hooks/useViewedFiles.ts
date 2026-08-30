import { useState, useEffect, useCallback, useMemo } from 'react';

import {
  type BaseMode,
  type ViewedFileRecord,
  type DiffFile,
  type ViewedHashIndexEntry,
} from '../../types/diff';
import { getDiffSelectionKey } from '../../utils/diffSelection';
import { storageService, VIEWED_HASH_VERSION } from '../services/StorageService';
import { matchesAutoViewedPatterns } from '../utils/autoViewedPatterns';
import { generateDiffHash, getDiffContentForHashing } from '../utils/diffUtils';

interface UseViewedFilesReturn {
  viewedFiles: Set<string>;
  /** Files viewed in a prior comparison range whose current diff hash no longer matches. */
  changedSinceViewedFiles: Set<string>;
  hasLoadedInitialViewedFiles: boolean;
  toggleFileViewed: (filePath: string, diffFile: DiffFile) => Promise<void>;
  setFilesViewed: (diffFiles: DiffFile[], viewed: boolean) => Promise<void>;
  isFileContentChanged: (filePath: string, diffFile: DiffFile) => Promise<boolean>;
  getViewedFileRecord: (filePath: string) => ViewedFileRecord | undefined;
  clearViewedFiles: () => void;
}

export function useViewedFiles(
  baseCommitish?: string,
  targetCommitish?: string,
  currentCommitHash?: string,
  branchToHash?: Map<string, string>,
  initialFiles?: DiffFile[],
  repositoryId?: string,
  autoViewedPatterns: string[] = [],
  baseMode?: BaseMode,
): UseViewedFilesReturn {
  const [viewedFileRecords, setViewedFileRecords] = useState<ViewedFileRecord[]>([]);
  const [loadedViewedFilesKey, setLoadedViewedFilesKey] = useState<string | null>(null);
  const [fileHashes, setFileHashes] = useState<Map<string, string>>(new Map());
  const [changedSinceViewedFiles, setChangedSinceViewedFiles] = useState<Set<string>>(new Set());
  const viewedFilesKey =
    baseCommitish && targetCommitish
      ? `${repositoryId ?? 'default'}:${getDiffSelectionKey({
          baseCommitish,
          targetCommitish,
          baseMode,
        })}:${currentCommitHash ?? 'no-commit'}`
      : null;
  const hasLoadedInitialViewedFiles =
    viewedFilesKey !== null && loadedViewedFilesKey === viewedFilesKey;

  useEffect(() => {
    if (!baseCommitish || !targetCommitish || !viewedFilesKey) return;

    let cancelled = false;

    const loadedFiles = storageService.getViewedFiles(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );

    // Pattern changes are intentionally not reactive here, so editing the
    // auto-viewed textarea does not immediately re-mark the current diff.
    const processAutoCollapsedFiles = async () => {
      const additions: ViewedFileRecord[] = [];

      if (initialFiles && initialFiles.length > 0) {
        const knownPaths = new Set(loadedFiles.map((f) => f.filePath));

        // Hash every displayed file once to reuse for both auto-mark and hydrate-from-index.
        const hashByPath = new Map<string, string>();
        await Promise.all(
          initialFiles.map(async (file) => {
            try {
              const hash = await generateDiffHash(getDiffContentForHashing(file));
              hashByPath.set(file.path, hash);
            } catch (err) {
              console.error('Failed to generate hash for file:', file.path, err);
            }
          }),
        );

        for (const file of initialFiles) {
          if (knownPaths.has(file.path)) continue;
          const shouldAutoMarkViewed =
            file.isGenerated ||
            file.status === 'deleted' ||
            matchesAutoViewedPatterns(file.path, autoViewedPatterns);
          if (!shouldAutoMarkViewed) continue;

          const hash = hashByPath.get(file.path);
          if (!hash) continue;

          additions.push({
            filePath: file.path,
            viewedAt: new Date().toISOString(),
            diffContentHash: hash,
          });
          knownPaths.add(file.path);
        }

        // Keyed by (filePath, diffContentHash) so the same file can hold independent
        // viewed state across multiple comparison ranges.
        const index = storageService.getViewedHashIndex(repositoryId);
        const indexedByKey = new Map<string, (typeof index.entries)[number]>();
        const indexedPaths = new Set<string>();
        for (const entry of index.entries) {
          if (entry.hashVersion !== VIEWED_HASH_VERSION) continue;
          indexedByKey.set(`${entry.filePath} ${entry.diffContentHash}`, entry);
          indexedPaths.add(entry.filePath);
        }

        for (const file of initialFiles) {
          if (knownPaths.has(file.path)) continue;
          const currentHash = hashByPath.get(file.path);
          if (!currentHash) continue;
          const entry = indexedByKey.get(`${file.path} ${currentHash}`);
          if (!entry) continue;

          additions.push({
            filePath: file.path,
            viewedAt: entry.viewedAt, // preserve original timestamp
            diffContentHash: currentHash,
          });
          knownPaths.add(file.path);
        }

        // Files viewed in a prior comparison whose current diff matches none of the recorded hashes.
        const changed = new Set<string>();
        for (const file of initialFiles) {
          if (!indexedPaths.has(file.path)) continue;
          if (knownPaths.has(file.path)) continue; // already viewed (loaded or just hydrated)
          const currentHash = hashByPath.get(file.path);
          if (!currentHash) continue;
          if (indexedByKey.has(`${file.path} ${currentHash}`)) continue;
          changed.add(file.path);
        }
        if (!cancelled) setChangedSinceViewedFiles(changed);
      } else {
        if (!cancelled) setChangedSinceViewedFiles(new Set());
      }

      if (additions.length > 0) {
        const updatedRecords = [...loadedFiles, ...additions];
        storageService.saveViewedFiles(
          baseCommitish,
          targetCommitish,
          updatedRecords,
          currentCommitHash,
          branchToHash,
          repositoryId,
          baseMode,
        );
        if (!cancelled) {
          setViewedFileRecords(updatedRecords);
          setLoadedViewedFilesKey(viewedFilesKey);
        }
        return;
      }

      if (!cancelled) {
        setViewedFileRecords(loadedFiles);
        setLoadedViewedFilesKey(viewedFilesKey);
      }
    };

    void processAutoCollapsedFiles();
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, [
    baseCommitish,
    targetCommitish,
    currentCommitHash,
    branchToHash,
    repositoryId,
    viewedFilesKey,
    baseMode,
  ]); // initialFiles and autoViewedPatterns intentionally omitted to run only on diff init

  const saveViewedFiles = useCallback(
    (newRecords: ViewedFileRecord[]) => {
      if (!baseCommitish || !targetCommitish) return;

      storageService.saveViewedFiles(
        baseCommitish,
        targetCommitish,
        newRecords,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      setViewedFileRecords(newRecords);
    },
    [baseCommitish, targetCommitish, currentCommitHash, branchToHash, repositoryId, baseMode],
  );

  const viewedFiles = useMemo(() => {
    return new Set(viewedFileRecords.map((record) => record.filePath));
  }, [viewedFileRecords]);

  const getViewedFileRecord = useCallback(
    (filePath: string): ViewedFileRecord | undefined => {
      return viewedFileRecords.find((record) => record.filePath === filePath);
    },
    [viewedFileRecords],
  );

  const getFileHash = useCallback(
    async (diffFile: DiffFile): Promise<string> => {
      const cached = fileHashes.get(diffFile.path);
      if (cached) return cached;

      const content = getDiffContentForHashing(diffFile);
      const hash = await generateDiffHash(content);

      setFileHashes((prev) => new Map(prev).set(diffFile.path, hash));
      return hash;
    },
    [fileHashes],
  );

  const isFileContentChanged = useCallback(
    async (filePath: string, diffFile: DiffFile): Promise<boolean> => {
      const record = getViewedFileRecord(filePath);
      if (!record) return false;

      const currentHash = await getFileHash(diffFile);
      return record.diffContentHash !== currentHash;
    },
    [getViewedFileRecord, getFileHash],
  );

  const toggleFileViewed = useCallback(
    async (filePath: string, diffFile: DiffFile): Promise<void> => {
      const existingRecord = getViewedFileRecord(filePath);

      if (existingRecord) {
        const newRecords = viewedFileRecords.filter((r) => r.filePath !== filePath);
        saveViewedFiles(newRecords);
        // Drop only the matching (path, hash) entry, so the same file viewed in
        // other comparisons keeps its state.
        storageService.removeViewedHashes(repositoryId, [
          { filePath, diffContentHash: existingRecord.diffContentHash },
        ]);
      } else {
        const hash = await getFileHash(diffFile);
        const viewedAt = new Date().toISOString();
        const newRecord: ViewedFileRecord = {
          filePath,
          viewedAt,
          diffContentHash: hash,
        };

        const newRecords = [...viewedFileRecords, newRecord];
        saveViewedFiles(newRecords);

        const indexEntry: ViewedHashIndexEntry = {
          filePath,
          diffContentHash: hash,
          hashVersion: VIEWED_HASH_VERSION,
          viewedAt,
        };
        storageService.recordViewedHashes(repositoryId, [indexEntry]);
      }
    },
    [viewedFileRecords, getViewedFileRecord, getFileHash, saveViewedFiles, repositoryId],
  );

  const setFilesViewed = useCallback(
    async (diffFiles: DiffFile[], viewed: boolean): Promise<void> => {
      if (viewed) {
        const filesToAdd = diffFiles.filter((file) => !getViewedFileRecord(file.path));
        if (filesToAdd.length === 0) return;

        const viewedAt = new Date().toISOString();
        const addedRecords: ViewedFileRecord[] = await Promise.all(
          filesToAdd.map(async (file) => ({
            filePath: file.path,
            viewedAt,
            diffContentHash: await getFileHash(file),
          })),
        );

        saveViewedFiles([...viewedFileRecords, ...addedRecords]);
        storageService.recordViewedHashes(
          repositoryId,
          addedRecords.map((record) => ({
            filePath: record.filePath,
            diffContentHash: record.diffContentHash,
            hashVersion: VIEWED_HASH_VERSION,
            viewedAt: record.viewedAt,
          })),
        );
      } else {
        const pathsToRemove = new Set(diffFiles.map((file) => file.path));
        const removedRecords = viewedFileRecords.filter((record) =>
          pathsToRemove.has(record.filePath),
        );
        if (removedRecords.length === 0) return;

        saveViewedFiles(viewedFileRecords.filter((record) => !pathsToRemove.has(record.filePath)));
        storageService.removeViewedHashes(
          repositoryId,
          removedRecords.map((record) => ({
            filePath: record.filePath,
            diffContentHash: record.diffContentHash,
          })),
        );
      }
    },
    [viewedFileRecords, getViewedFileRecord, getFileHash, saveViewedFiles, repositoryId],
  );

  const clearViewedFiles = useCallback(() => {
    saveViewedFiles([]);
    setFileHashes(new Map());
    setChangedSinceViewedFiles(new Set());
    storageService.clearViewedHashIndex(repositoryId);
  }, [saveViewedFiles, repositoryId]);

  return {
    viewedFiles,
    changedSinceViewedFiles,
    hasLoadedInitialViewedFiles,
    toggleFileViewed,
    setFilesViewed,
    isFileContentChanged,
    getViewedFileRecord,
    clearViewedFiles,
  };
}
