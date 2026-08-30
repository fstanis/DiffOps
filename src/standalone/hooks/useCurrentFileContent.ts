import { useEffect, useState } from 'react';

import type { DiffFile } from '../../types/diff';

export interface CurrentFileContentState {
  lines: string[] | null;
  isLoading: boolean;
  error: string | null;
}

// Cache per DiffFile object identity: a re-fetched diff produces new file
// objects, so watch reloads invalidate the cache naturally, while plain
// re-renders keep serving cached content without a flash of loading state.
const contentCache = new WeakMap<DiffFile, string[]>();
const pendingFetches = new WeakMap<DiffFile, Promise<string[]>>();

// An added file's hunks already contain the whole new file, so no blob
// fetch is needed for it.
function linesFromAddedFile(file: DiffFile): string[] {
  const lines: string[] = [];
  for (const chunk of file.chunks) {
    for (const line of chunk.lines) {
      if (line.type === 'add') {
        lines.push(line.content);
      }
    }
  }
  return lines;
}

async function fetchBlobLines(path: string, ref: string): Promise<string[]> {
  const encodedPath = encodeURIComponent(path);
  const response = await fetch(`/api/blob/${encodedPath}?ref=${encodeURIComponent(ref)}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch file content: ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.split('\n');
  // Remove last empty line if file doesn't end with newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function useCurrentFileContent(
  file: DiffFile,
  targetCommitish?: string,
): CurrentFileContentState {
  // Compute the initial state synchronously so the first paint already shows
  // the loading placeholder instead of a frame of the unified diff fallback
  const resolveInitialState = (): CurrentFileContentState => {
    if (file.status === 'added') {
      return { lines: linesFromAddedFile(file), isLoading: false, error: null };
    }
    if (!targetCommitish || targetCommitish === 'stdin') {
      return { lines: null, isLoading: false, error: 'Blob content is unavailable' };
    }
    const cached = contentCache.get(file);
    if (cached) {
      return { lines: cached, isLoading: false, error: null };
    }
    return { lines: null, isLoading: true, error: null };
  };

  const [state, setState] = useState<CurrentFileContentState>(resolveInitialState);

  useEffect(() => {
    if (file.status === 'added') {
      setState({ lines: linesFromAddedFile(file), isLoading: false, error: null });
      return;
    }

    if (!targetCommitish || targetCommitish === 'stdin') {
      setState({ lines: null, isLoading: false, error: 'Blob content is unavailable' });
      return;
    }

    const cached = contentCache.get(file);
    if (cached) {
      setState({ lines: cached, isLoading: false, error: null });
      return;
    }

    let pending = pendingFetches.get(file);
    if (!pending) {
      pending = fetchBlobLines(file.path, targetCommitish).then(
        (lines) => {
          contentCache.set(file, lines);
          return lines;
        },
        (error: unknown) => {
          pendingFetches.delete(file);
          throw error;
        },
      );
      pendingFetches.set(file, pending);
    }

    let cancelled = false;
    setState({ lines: null, isLoading: true, error: null });

    pending.then(
      (lines) => {
        if (!cancelled) {
          setState({ lines, isLoading: false, error: null });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            lines: null,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to load file content',
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [file, targetCommitish]);

  return state;
}
