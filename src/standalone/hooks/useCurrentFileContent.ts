import { useEffect, useState } from 'react';

import type { DiffFile } from '../../types/diff';
import {
  fetchCurrentFileLines,
  getCachedCurrentFileLines,
  linesFromAddedFile,
} from '../utils/currentFileContent';

export interface CurrentFileContentState {
  lines: string[] | null;
  isLoading: boolean;
  error: string | null;
}

export function useCurrentFileContent(
  file: DiffFile,
  targetCommitish?: string,
): CurrentFileContentState {
  // Computed synchronously so the first paint shows the loading placeholder instead of a frame of the unified diff fallback.
  const resolveInitialState = (): CurrentFileContentState => {
    if (file.status === 'added') {
      return { lines: linesFromAddedFile(file), isLoading: false, error: null };
    }
    if (!targetCommitish || targetCommitish === 'stdin') {
      return { lines: null, isLoading: false, error: 'Blob content is unavailable' };
    }
    const cached = getCachedCurrentFileLines(file);
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

    const cached = getCachedCurrentFileLines(file);
    if (cached) {
      setState({ lines: cached, isLoading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ lines: null, isLoading: true, error: null });

    fetchCurrentFileLines(file, targetCommitish).then(
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
