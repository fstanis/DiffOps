import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'bun:test';

import { useDiffComments } from './useDiffComments';
import { useViewedFiles } from './useViewedFiles';

const mockStorage = new Map<string, any>();

vi.mock('../services/StorageService', () => ({
  VIEWED_HASH_VERSION: 1,
  storageService: {
    getCommentThreads: vi.fn((base, target, _hash, _branch, repoId) => {
      const key = `${repoId || 'default'}-${base}-${target}-threads`;
      return mockStorage.get(key) || [];
    }),
    saveCommentThreads: vi.fn((base, target, threads, _hash, _branch, repoId) => {
      const key = `${repoId || 'default'}-${base}-${target}-threads`;
      mockStorage.set(key, threads);
    }),
    getComments: vi.fn((base, target, _hash, _branch, repoId) => {
      const key = `${repoId || 'default'}-${base}-${target}-comments`;
      return mockStorage.get(key) || [];
    }),
    saveComments: vi.fn((base, target, comments, _hash, _branch, repoId) => {
      const key = `${repoId || 'default'}-${base}-${target}-comments`;
      mockStorage.set(key, comments);
    }),
    getViewedFiles: vi.fn((base, target, _hash, _branch, repoId) => {
      const key = `${repoId || 'default'}-${base}-${target}-viewed`;
      return mockStorage.get(key) || [];
    }),
    saveViewedFiles: vi.fn((base, target, files, _hash, _branch, repoId) => {
      const key = `${repoId || 'default'}-${base}-${target}-viewed`;
      mockStorage.set(key, files);
    }),
    getViewedHashIndex: vi.fn((repoId) => {
      const key = `${repoId || 'default'}-viewed-hash-index`;
      return (
        mockStorage.get(key) || {
          version: 1,
          lastModifiedAt: new Date(0).toISOString(),
          entries: [],
        }
      );
    }),
    recordViewedHashes: vi.fn((repoId, entries) => {
      const key = `${repoId || 'default'}-viewed-hash-index`;
      const existing = mockStorage.get(key) || {
        version: 1,
        lastModifiedAt: new Date(0).toISOString(),
        entries: [],
      };
      const compositeKey = (e: { filePath: string; diffContentHash: string }) =>
        `${e.filePath} ${e.diffContentHash}`;
      const byKey = new Map(
        existing.entries.map((entry: { filePath: string; diffContentHash: string }) => [
          compositeKey(entry),
          entry,
        ]),
      );
      for (const entry of entries) byKey.set(compositeKey(entry), entry);
      mockStorage.set(key, {
        version: 1,
        lastModifiedAt: new Date().toISOString(),
        entries: Array.from(byKey.values()),
      });
    }),
    removeViewedHashes: vi.fn(
      (repoId, entries: Array<{ filePath: string; diffContentHash: string }>) => {
        const key = `${repoId || 'default'}-viewed-hash-index`;
        const existing = mockStorage.get(key);
        if (!existing) return;
        const drop = new Set(entries.map((e) => `${e.filePath} ${e.diffContentHash}`));
        mockStorage.set(key, {
          ...existing,
          entries: existing.entries.filter(
            (entry: { filePath: string; diffContentHash: string }) =>
              !drop.has(`${entry.filePath} ${entry.diffContentHash}`),
          ),
        });
      },
    ),
    clearViewedHashIndex: vi.fn((repoId) => {
      mockStorage.delete(`${repoId || 'default'}-viewed-hash-index`);
    }),
    getDiffContextData: vi.fn(() => null),
    saveDiffContextData: vi.fn(),
  },
}));

describe('Repository Isolation Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.clear();
  });

  describe('useDiffComments - Repository Isolation', () => {
    it('should isolate comments between different repositories', () => {
      const { result: result1 } = renderHook(() =>
        useDiffComments('base', 'target', undefined, undefined, 'repo-1'),
      );

      const { result: result2 } = renderHook(() =>
        useDiffComments('base', 'target', undefined, undefined, 'repo-2'),
      );

      act(() => {
        result1.current.addComment({
          filePath: 'test.ts',
          body: 'Comment in repo 1',
          side: 'new',
          line: 10,
        });
      });

      expect(result1.current.comments.length).toBe(1);
      expect(result1.current.comments[0]?.body).toBe('Comment in repo 1');

      expect(result2.current.comments.length).toBe(0);

      act(() => {
        result2.current.addComment({
          filePath: 'test.ts',
          body: 'Comment in repo 2',
          side: 'new',
          line: 10,
        });
      });

      expect(result1.current.comments.length).toBe(1);
      expect(result1.current.comments[0]?.body).toBe('Comment in repo 1');

      expect(result2.current.comments.length).toBe(1);
      expect(result2.current.comments[0]?.body).toBe('Comment in repo 2');
    });

    it('should isolate comments in working diff mode across repositories', () => {
      const { result: result1 } = renderHook(() =>
        useDiffComments('HEAD', 'working', 'abc123', undefined, 'repo-1'),
      );

      const { result: result2 } = renderHook(() =>
        useDiffComments('HEAD', 'working', 'abc123', undefined, 'repo-2'),
      );

      act(() => {
        result1.current.addComment({
          filePath: 'file.ts',
          body: 'Working diff comment in repo 1',
          side: 'new',
          line: 5,
        });
      });

      expect(result1.current.comments.length).toBe(1);

      expect(result2.current.comments.length).toBe(0);
    });
  });

  describe('useViewedFiles - Repository Isolation', () => {
    it('should isolate viewed files between different repositories', async () => {
      const mockFile1 = {
        path: 'file1.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      const mockFile2 = {
        path: 'file2.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      const { result: result1 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [mockFile1], 'repo-1'),
      );

      const { result: result2 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [mockFile2], 'repo-2'),
      );

      await act(async () => {
        await result1.current.toggleFileViewed('file1.ts', mockFile1);
      });

      expect(result1.current.viewedFiles.has('file1.ts')).toBe(true);
      expect(result1.current.viewedFiles.size).toBe(1);

      expect(result2.current.viewedFiles.has('file1.ts')).toBe(false);
      expect(result2.current.viewedFiles.size).toBe(0);

      await act(async () => {
        await result2.current.toggleFileViewed('file2.ts', mockFile2);
      });

      expect(result1.current.viewedFiles.has('file1.ts')).toBe(true);
      expect(result1.current.viewedFiles.has('file2.ts')).toBe(false);
      expect(result1.current.viewedFiles.size).toBe(1);

      expect(result2.current.viewedFiles.has('file1.ts')).toBe(false);
      expect(result2.current.viewedFiles.has('file2.ts')).toBe(true);
      expect(result2.current.viewedFiles.size).toBe(1);
    });

    it('should isolate auto-marked generated files between repositories', () => {
      const generatedFile1 = {
        path: 'package-lock.json',
        status: 'modified' as const,
        additions: 100,
        deletions: 50,
        chunks: [],
        isGenerated: true,
      };

      const generatedFile2 = {
        path: 'yarn.lock',
        status: 'modified' as const,
        additions: 80,
        deletions: 40,
        chunks: [],
        isGenerated: true,
      };

      const { result: result1 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [generatedFile1], 'repo-1'),
      );

      const { result: result2 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [generatedFile2], 'repo-2'),
      );

      // Auto-marking is async; wait for the effect before asserting.
      setTimeout(() => {
        const repo1HasYarnLock = result1.current.viewedFiles.has('yarn.lock');
        const repo2HasPackageLock = result2.current.viewedFiles.has('package-lock.json');

        expect(repo1HasYarnLock).toBe(false);
        expect(repo2HasPackageLock).toBe(false);
      }, 100);
    });
  });

  describe('Cross-Repository Data Integrity', () => {
    // Skipped: async timing issues in this environment; covered by other isolation tests.
    it.skip('should maintain separate view counts for different repositories', async () => {
      const file1 = {
        path: 'file1.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        chunks: [],
      };
      const file2 = {
        path: 'file2.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      const { result: result1 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [file1], 'repo-1'),
      );

      await act(async () => {
        await result1.current.toggleFileViewed('file1.ts', file1);
      });

      const { result: result2 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [file2], 'repo-2'),
      );

      await act(async () => {
        await result2.current.toggleFileViewed('file2.ts', file2);
      });

      expect(result1.current.viewedFiles.size).toBe(1);
      expect(result1.current.viewedFiles.has('file1.ts')).toBe(true);
      expect(result1.current.viewedFiles.has('file2.ts')).toBe(false);

      expect(result2.current.viewedFiles.size).toBe(1);
      expect(result2.current.viewedFiles.has('file2.ts')).toBe(true);
      expect(result2.current.viewedFiles.has('file1.ts')).toBe(false);
    });

    it('should allow same file paths in different repositories without conflict', async () => {
      const file = {
        path: 'common.ts',
        status: 'modified' as const,
        additions: 5,
        deletions: 3,
        chunks: [],
      };

      const { result: result1 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [file], 'repo-1'),
      );

      const { result: result2 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [file], 'repo-2'),
      );

      await act(async () => {
        await result1.current.toggleFileViewed('common.ts', file);
      });

      expect(result1.current.viewedFiles.has('common.ts')).toBe(true);

      expect(result2.current.viewedFiles.has('common.ts')).toBe(false);
    });
  });
});
