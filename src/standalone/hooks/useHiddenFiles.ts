import { useCallback, useEffect, useState } from 'react';

const EMPTY_HIDDEN_FILES: Set<string> = new Set();

interface UseHiddenFilesReturn {
  /** Paths the reviewer hid: kept out of the diff pane and out of every AI prompt. */
  hiddenFiles: Set<string>;
  toggleFileHidden: (filePath: string) => void;
}

/**
 * Hidden files for the open repository, persisted through /api/hidden-files.
 * The scope is the repository rather than the revision selection, so a file the
 * reviewer hid stays hidden as they move between diffs.
 */
export function useHiddenFiles(repositoryScope: string | null): UseHiddenFilesReturn {
  const [hiddenFiles, setHiddenFiles] = useState<Set<string>>(EMPTY_HIDDEN_FILES);

  useEffect(() => {
    setHiddenFiles(EMPTY_HIDDEN_FILES);

    if (!repositoryScope) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/hidden-files');
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { paths?: unknown };
        if (cancelled || !Array.isArray(data.paths)) {
          return;
        }
        setHiddenFiles(
          new Set(data.paths.filter((path): path is string => typeof path === 'string')),
        );
      } catch {
        // Persistence is best-effort; reviewing with nothing hidden still works.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repositoryScope]);

  const toggleFileHidden = useCallback(
    (filePath: string) => {
      const nextHiddenFiles = new Set(hiddenFiles);
      if (!nextHiddenFiles.delete(filePath)) {
        nextHiddenFiles.add(filePath);
      }
      setHiddenFiles(nextHiddenFiles);

      void fetch('/api/hidden-files', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: Array.from(nextHiddenFiles) }),
      }).catch(() => {
        // The in-memory set keeps the current review working.
      });
    },
    [hiddenFiles],
  );

  return { hiddenFiles, toggleFileHidden };
}
