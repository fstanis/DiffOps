import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DiffFile, type Narration } from '../../types/diff';
import {
  NARRATE_PROMPT_MAX_BYTES,
  buildNarratePrompt,
  measureNarratePromptBytes,
} from '../../utils/narratePrompt';
import { buildChangesetFingerprint } from '../utils/narrationFingerprint';
import type { StoredNarration } from '../persistence/standaloneStore';
import type { AiSettings } from './useAiSettings';

export type NarrationPhase = 'idle' | 'loading' | 'error';

interface UseNarrationOptions {
  files: DiffFile[];
  commitLabel: string;
  /** Comment-session query string; absent means narration stays in memory only. */
  sessionQueryString: string | null;
  aiSettings: AiSettings;
}

export interface UseNarrationReturn {
  narration: Narration | null;
  isNarratedView: boolean;
  phase: NarrationPhase;
  errorMessage: string;
  disabledReason: string | undefined;
  narrateModel: string;
  toggleNarratedView: () => void;
  regenerate: () => void;
}

export function useNarration({
  files,
  commitLabel,
  sessionQueryString,
  aiSettings,
}: UseNarrationOptions): UseNarrationReturn {
  const [narration, setNarration] = useState<Narration | null>(null);
  const [isNarratedView, setIsNarratedView] = useState(false);
  const [phase, setPhase] = useState<NarrationPhase>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const prompt = useMemo(() => buildNarratePrompt({ files, commitLabel }), [files, commitLabel]);
  const fingerprint = useMemo(
    () => buildChangesetFingerprint(commitLabel, files),
    [commitLabel, files],
  );
  const fingerprintRef = useRef(fingerprint);
  useEffect(() => {
    fingerprintRef.current = fingerprint;
  }, [fingerprint]);

  const disabledReason = useMemo(() => {
    if (files.length === 0) {
      return 'Nothing to narrate — this changeset has no files';
    }
    if (measureNarratePromptBytes(prompt) > NARRATE_PROMPT_MAX_BYTES) {
      return 'Changeset too large to narrate';
    }
    if (!aiSettings.apiKey) {
      return 'Add an AI Gateway API key in Settings to enable narration';
    }
    return undefined;
  }, [files.length, prompt, aiSettings.apiKey]);

  // Load the persisted narration; a fingerprint mismatch reads as absent,
  // leaving git order in place.
  useEffect(() => {
    let cancelled = false;
    setNarration(null);
    setIsNarratedView(false);
    setPhase('idle');
    setErrorMessage('');

    if (!sessionQueryString) {
      return;
    }

    void (async () => {
      try {
        const response = await fetch(`/api/narration?${sessionQueryString}`);
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { narration?: StoredNarration | null };
        if (cancelled || !data.narration || data.narration.fingerprint !== fingerprint) {
          return;
        }
        setNarration(data.narration.narration);
      } catch {
        // Persistence is best-effort; narrating without the cache still works.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionQueryString, fingerprint]);

  const persistNarration = useCallback(
    (generated: Narration) => {
      if (!sessionQueryString) {
        return;
      }
      void fetch(`/api/narration?${sessionQueryString}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ narration: generated, fingerprint }),
      }).catch(() => {
        // Caching is best-effort; the in-memory narration keeps working.
      });
    },
    [sessionQueryString, fingerprint],
  );

  const generate = useCallback(async () => {
    setPhase('loading');
    setErrorMessage('');
    const requestFingerprint = fingerprint;

    try {
      // The AI SDK loads only once a user actually asks for a narration.
      const { generateNarration } = await import('../services/aiGateway');
      const narrated = await generateNarration({
        prompt,
        paths: files.map((file) => file.path),
        model: aiSettings.narrateModel,
        apiKey: aiSettings.apiKey,
      });

      // The diff moved; the new fingerprint's reset already owns the state.
      if (requestFingerprint !== fingerprintRef.current) {
        return;
      }
      setNarration(narrated);
      setPhase('idle');
      setIsNarratedView(true);
      persistNarration(narrated);
    } catch (error) {
      if (requestFingerprint !== fingerprintRef.current) {
        return;
      }
      setPhase('error');
      setErrorMessage(error instanceof Error ? error.message : 'Narration request failed');
    }
  }, [files, prompt, fingerprint, persistNarration, aiSettings.narrateModel, aiSettings.apiKey]);

  const toggleNarratedView = useCallback(() => {
    if (phase === 'loading' || disabledReason) {
      return;
    }
    if (isNarratedView) {
      setIsNarratedView(false);
      return;
    }
    if (narration) {
      setIsNarratedView(true);
      return;
    }
    void generate();
  }, [phase, disabledReason, isNarratedView, narration, generate]);

  const regenerate = useCallback(() => {
    if (phase === 'loading' || disabledReason) {
      return;
    }
    void generate();
  }, [phase, disabledReason, generate]);

  return {
    narration,
    isNarratedView,
    phase,
    errorMessage,
    disabledReason,
    narrateModel: aiSettings.narrateModel,
    toggleNarratedView,
    regenerate,
  };
}
