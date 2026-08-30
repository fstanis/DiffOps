import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DiffFile, type FileExplanation } from '../../types/diff';
import { resolveExplainCandidates } from '../../utils/explainCandidates';
import {
  type ExplainSupportingFile,
  EXPLAIN_PROMPT_MAX_BYTES,
  MIN_EXPLAINABLE_NON_EMPTY_LINES,
  buildExplainReaskPrompt,
  buildWholeFileExplainPrompt,
  countNonEmptyLines,
  hasExplainableDiffContent,
  measureExplainPromptBytes,
} from '../../utils/explainPrompt';
import { buildFileExplanationFingerprint } from '../utils/explanationFingerprint';
import {
  fetchCurrentFileLines,
  fetchRepositoryFileText,
  linesFromAddedFile,
} from '../utils/currentFileContent';
import type { StoredFileExplanation } from '../persistence/standaloneStore';
import type { AiSettings } from './useAiSettings';

export type FileExplainPhase = 'idle' | 'loading' | 'loaded' | 'error';

interface FileExplainState {
  phase: FileExplainPhase;
  explanation: FileExplanation | null;
  errorMessage: string;
}

interface ReaskState {
  /** The requested files' whole content, ready for the re-ask prompt. */
  supportingFiles: ExplainSupportingFile[];
  /** Set while the supporting files load or when the re-ask is impossible. */
  disabledReason: string | undefined;
}

const INITIAL_EXPLAIN_STATE: FileExplainState = {
  phase: 'idle',
  explanation: null,
  errorMessage: '',
};

const INITIAL_REASK_STATE: ReaskState = { supportingFiles: [], disabledReason: undefined };

interface DiffFileModeWindow {
  __DIFFOPS_DIFF_FILE_MODE__?: boolean;
}

const isDiffFileMode = () =>
  typeof window !== 'undefined' &&
  (window as Window & DiffFileModeWindow).__DIFFOPS_DIFF_FILE_MODE__ === true;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const isFileExplanation = (value: unknown): value is FileExplanation => {
  const candidate = value as {
    fileSummary?: unknown;
    symbols?: unknown;
    additionalFilesNeeded?: unknown;
  } | null;
  return (
    candidate !== null &&
    typeof candidate.fileSummary === 'string' &&
    Array.isArray(candidate.symbols) &&
    Array.isArray(candidate.additionalFilesNeeded) &&
    candidate.additionalFilesNeeded.every((path) => typeof path === 'string')
  );
};

interface UseFileExplainOptions {
  file: DiffFile;
  commitLabel?: string;
  targetCommitish?: string;
  aiSettings: AiSettings;
  /** Comment-session query string; absent means explanations stay in memory only. */
  sessionQueryString?: string | null;
}

export function useFileExplain({
  file,
  commitLabel,
  targetCommitish,
  aiSettings,
  sessionQueryString,
}: UseFileExplainOptions) {
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [state, setState] = useState<FileExplainState>(INITIAL_EXPLAIN_STATE);
  const [reaskState, setReaskState] = useState<ReaskState>(INITIAL_REASK_STATE);
  const [fileLines, setFileLines] = useState<string[] | null>(() =>
    file.status === 'added' && hasExplainableDiffContent(file) ? linesFromAddedFile(file) : null,
  );
  const [isContentUnavailable, setIsContentUnavailable] = useState(false);
  const linesPromiseRef = useRef<Promise<string[]> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fingerprint = useMemo(
    () => buildFileExplanationFingerprint(commitLabel ?? '', file),
    [commitLabel, file],
  );

  const hasBlobRef = Boolean(targetCommitish) && targetCommitish !== 'stdin';

  // Load the file's whole current content eagerly but only when an explanation
  // could actually run — the same cached fetch the prompt itself needs.
  useEffect(() => {
    linesPromiseRef.current = null;
    setIsContentUnavailable(false);

    if (file.status === 'added' || file.status === 'deleted' || !hasExplainableDiffContent(file)) {
      setFileLines(file.status === 'added' ? linesFromAddedFile(file) : null);
      return;
    }
    if (!hasBlobRef || !aiSettings.apiKey) {
      setFileLines(null);
      return;
    }

    let cancelled = false;
    setFileLines(null);
    const pending = fetchCurrentFileLines(file, targetCommitish as string);
    linesPromiseRef.current = pending;
    pending.then(
      (lines) => {
        if (!cancelled) {
          setFileLines(lines);
        }
      },
      () => {
        if (!cancelled) {
          setIsContentUnavailable(true);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [file, targetCommitish, hasBlobRef, aiSettings.apiKey]);

  const ensureFileLines = useCallback(async (): Promise<string[]> => {
    if (fileLines !== null) {
      return fileLines;
    }
    if (linesPromiseRef.current !== null) {
      return linesPromiseRef.current;
    }
    throw new Error('File content is unavailable');
  }, [fileLines]);

  const disabledReason = useMemo(() => {
    if (file.status === 'deleted') {
      return 'Nothing to explain — this file was deleted';
    }
    if (!hasExplainableDiffContent(file)) {
      return 'Nothing to explain — this file has no text content';
    }
    if (!hasBlobRef || isDiffFileMode()) {
      return 'Explain needs a repository — open a repository to explain files';
    }
    if (isContentUnavailable) {
      return "Could not load this file's current content";
    }
    if (!aiSettings.apiKey) {
      return 'Add an AI Gateway API key in Settings to enable AI explanations';
    }
    if (fileLines === null) {
      // Content is still loading; the request itself waits for it.
      return undefined;
    }
    if (countNonEmptyLines(fileLines) < MIN_EXPLAINABLE_NON_EMPTY_LINES) {
      return 'File is too short to explain — fewer than 20 non-empty lines';
    }
    const prompt = buildWholeFileExplainPrompt({
      path: file.path,
      content: fileLines.join('\n'),
      candidateFiles: [],
    });
    if (measureExplainPromptBytes(prompt) > EXPLAIN_PROMPT_MAX_BYTES) {
      return 'File is too large to explain in a single request';
    }
    return undefined;
  }, [file, hasBlobRef, isContentUnavailable, aiSettings.apiKey, fileLines]);

  const explanationQuery = useMemo(() => {
    if (!sessionQueryString) {
      return null;
    }
    return `${sessionQueryString}&path=${encodeURIComponent(file.path)}`;
  }, [sessionQueryString, file.path]);

  // Load the persisted explanation; a fingerprint mismatch reads as absent.
  useEffect(() => {
    let cancelled = false;
    setState(INITIAL_EXPLAIN_STATE);
    setReaskState(INITIAL_REASK_STATE);

    if (!explanationQuery) {
      return;
    }
    void (async () => {
      try {
        const response = await fetch(`/api/explanation?${explanationQuery}`);
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { explanation?: StoredFileExplanation | null };
        const stored = data.explanation;
        if (
          cancelled ||
          !stored ||
          stored.fingerprint !== fingerprint ||
          !isFileExplanation(stored.explanation)
        ) {
          return;
        }
        // A record whose supporting files were already included is a
        // final-round answer and structurally carries no file requests.
        setState({ phase: 'loaded', explanation: stored.explanation, errorMessage: '' });
      } catch {
        // Persistence is best-effort; explaining without the cache still works.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [explanationQuery, fingerprint]);

  const persistExplanation = useCallback(
    (explanation: FileExplanation, includedSupportingFiles: string[]) => {
      if (!explanationQuery) {
        return;
      }
      void fetch(`/api/explanation?${explanationQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ explanation, includedSupportingFiles, fingerprint }),
      }).catch(() => {
        // Caching is best-effort; the in-memory explanation keeps working.
      });
    },
    [explanationQuery, fingerprint],
  );

  // The AI SDK loads only once a user actually asks for an explanation.
  const requestFileExplanation = useCallback(
    async (
      prompt: string,
      candidateFiles: string[],
      signal: AbortSignal,
    ): Promise<FileExplanation> => {
      const { generateFileExplanation } = await import('../services/aiGateway');
      return generateFileExplanation({
        prompt,
        candidateFiles,
        model: aiSettings.explainModel,
        apiKey: aiSettings.apiKey,
        signal,
      });
    },
    [aiSettings.explainModel, aiSettings.apiKey],
  );

  const requestExplain = useCallback(async () => {
    setState({ phase: 'loading', explanation: null, errorMessage: '' });
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const lines = await ensureFileLines();
      const content = lines.join('\n');
      const ref = targetCommitish as string;
      // Every candidate is verified by a successful blob probe, so the model
      // can only ever ask for files the repository actually has.
      const candidateFiles = await resolveExplainCandidates({
        sourcePath: file.path,
        source: content,
        fileExists: (path) =>
          fetchRepositoryFileText(path, ref).then(
            () => true,
            () => false,
          ),
      });
      const prompt = buildWholeFileExplainPrompt({ path: file.path, content, candidateFiles });
      if (measureExplainPromptBytes(prompt) > EXPLAIN_PROMPT_MAX_BYTES) {
        throw new Error('File is too large to explain in a single request');
      }

      const explanation = await requestFileExplanation(prompt, candidateFiles, controller.signal);
      setState({ phase: 'loaded', explanation, errorMessage: '' });
      persistExplanation(explanation, []);
    } catch (error) {
      // An abort means the panel was closed, which already reset the state.
      if (!isAbortError(error)) {
        setState({
          phase: 'error',
          explanation: null,
          errorMessage: error instanceof Error ? error.message : 'Explain request failed',
        });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [file.path, targetCommitish, ensureFileLines, requestFileExplanation, persistExplanation]);

  const requestedFiles = useMemo(
    () => (state.phase === 'loaded' ? (state.explanation?.additionalFilesNeeded ?? []) : []),
    [state.phase, state.explanation],
  );

  // Prepare the single re-ask round: load the requested files whole, then the
  // offer is ready (or disabled with a reason when the cap would be exceeded).
  useEffect(() => {
    if (state.phase !== 'loaded' || requestedFiles.length === 0) {
      return;
    }

    let cancelled = false;
    setReaskState({ supportingFiles: [], disabledReason: 'Loading the requested files…' });

    void (async () => {
      try {
        const supportingFiles = await Promise.all(
          requestedFiles.map(async (path) => ({
            path,
            content: await fetchRepositoryFileText(path, targetCommitish as string),
          })),
        );
        if (cancelled) {
          return;
        }
        const prompt = buildExplainReaskPrompt({
          path: file.path,
          content: (fileLines ?? []).join('\n'),
          supportingFiles,
        });
        setReaskState({
          supportingFiles,
          disabledReason:
            measureExplainPromptBytes(prompt) > EXPLAIN_PROMPT_MAX_BYTES
              ? `Including the requested files would exceed the ${Math.round(EXPLAIN_PROMPT_MAX_BYTES / 1024)} KB explain limit`
              : undefined,
        });
      } catch {
        if (!cancelled) {
          setReaskState({
            supportingFiles: [],
            disabledReason: 'Could not load the requested files',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state.phase, requestedFiles, file.path, fileLines, targetCommitish]);

  const reaskExplain = useCallback(async () => {
    const { supportingFiles, disabledReason } = reaskState;
    if (supportingFiles.length === 0 || disabledReason || fileLines === null) {
      return;
    }

    setState({ phase: 'loading', explanation: null, errorMessage: '' });
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const prompt = buildExplainReaskPrompt({
        path: file.path,
        content: fileLines.join('\n'),
        supportingFiles,
      });
      // The final round sends no candidates, so the answer cannot request more files.
      const explanation = await requestFileExplanation(prompt, [], controller.signal);
      setState({ phase: 'loaded', explanation, errorMessage: '' });
      persistExplanation(
        explanation,
        supportingFiles.map((supportingFile) => supportingFile.path),
      );
    } catch (error) {
      if (!isAbortError(error)) {
        setState({
          phase: 'error',
          explanation: null,
          errorMessage: error instanceof Error ? error.message : 'Explain request failed',
        });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [reaskState, fileLines, file.path, requestFileExplanation, persistExplanation]);

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
    requestedFiles,
    reaskDisabledReason: reaskState.disabledReason,
    disabledReason,
    isBusy: state.phase === 'loading',
    toggleExplain,
    retryExplain,
    reaskExplain,
  };
}
