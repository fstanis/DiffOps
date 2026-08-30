import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DiffFile, type ExplainStatusResponse } from '../../types/diff';
import {
  buildExplainPrompt,
  EXPLAIN_PROMPT_MAX_BYTES,
  hasExplainableDiffContent,
  measureExplainPromptBytes,
} from '../../utils/explainPrompt';

export type FileExplainPhase = 'idle' | 'loading' | 'loaded' | 'error';

interface FileExplainState {
  phase: FileExplainPhase;
  explanation: string;
  errorMessage: string;
}

const INITIAL_EXPLAIN_STATE: FileExplainState = {
  phase: 'idle',
  explanation: '',
  errorMessage: '',
};

interface DiffFileModeWindow {
  __DIFFOPS_DIFF_FILE_MODE__?: boolean;
}

const isDiffFileMode = () =>
  typeof window !== 'undefined' &&
  (window as Window & DiffFileModeWindow).__DIFFOPS_DIFF_FILE_MODE__ === true;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

interface UseFileExplainOptions {
  file: DiffFile;
  allFiles: DiffFile[];
  commitLabel?: string;
  explainStatus?: ExplainStatusResponse | null;
}

export function useFileExplain({
  file,
  allFiles,
  commitLabel,
  explainStatus,
}: UseFileExplainOptions) {
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [state, setState] = useState<FileExplainState>(INITIAL_EXPLAIN_STATE);
  const abortControllerRef = useRef<AbortController | null>(null);

  const prompt = useMemo(
    () => buildExplainPrompt({ file, allFiles, commitLabel }),
    [file, allFiles, commitLabel],
  );

  const disabledReason = useMemo(() => {
    if (!hasExplainableDiffContent(file)) {
      return 'Nothing to explain — this file has no text content';
    }
    if (measureExplainPromptBytes(prompt) > EXPLAIN_PROMPT_MAX_BYTES) {
      return 'File is too large to explain in a single request';
    }
    if (isDiffFileMode()) {
      return 'Explain needs a repository — open a repository to explain files';
    }
    if (!explainStatus) {
      return 'Explain needs the diffops server — it is offline or not serving this app';
    }
    if (!explainStatus.enabled) {
      return 'Set the AI_GATEWAY_API_KEY environment variable to enable AI explanations';
    }
    return undefined;
  }, [file, prompt, explainStatus]);

  const requestExplain = useCallback(async () => {
    setState({ phase: 'loading', explanation: '', errorMessage: '' });
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('/ai-gateway/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });
      const data = (await response.json()) as { explanation?: unknown; error?: unknown };
      if (!response.ok || typeof data.explanation !== 'string') {
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : `Explain request failed (${response.status})`,
        );
      }
      setState({ phase: 'loaded', explanation: data.explanation, errorMessage: '' });
    } catch (error) {
      // An abort means the panel was closed, which already reset the state.
      if (!isAbortError(error)) {
        setState({
          phase: 'error',
          explanation: '',
          errorMessage: error instanceof Error ? error.message : 'Explain request failed',
        });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [prompt]);

  const toggleExplain = useCallback(() => {
    if (disabledReason) {
      return;
    }
    if (isPanelOpen) {
      setIsPanelOpen(false);
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      if (state.phase === 'loading') {
        setState(INITIAL_EXPLAIN_STATE);
      }
      return;
    }

    setIsPanelOpen(true);
    if (state.phase === 'idle' || state.phase === 'error') {
      void requestExplain();
    }
  }, [disabledReason, isPanelOpen, state.phase, requestExplain]);

  const retryExplain = useCallback(() => {
    void requestExplain();
  }, [requestExplain]);

  // Cancel any in-flight explanation when the file's viewer unmounts.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  return {
    isPanelOpen,
    phase: state.phase,
    explanation: state.explanation,
    errorMessage: state.errorMessage,
    disabledReason,
    isBusy: state.phase === 'loading',
    toggleExplain,
    retryExplain,
  };
}
