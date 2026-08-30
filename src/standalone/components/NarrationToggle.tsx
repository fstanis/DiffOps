import { BookOpenText, Loader2, RotateCcw } from 'lucide-react';

import type { NarrationPhase } from '../hooks/useNarration';

interface NarrationToggleProps {
  isNarratedView: boolean;
  phase: NarrationPhase;
  errorMessage: string;
  disabledReason: string | undefined;
  narrateModel: string | undefined;
  onToggle: () => void;
  onRegenerate: () => void;
}

/** The sidebar's whole narration interface: the narrated-view switch. */
export function NarrationToggle({
  isNarratedView,
  phase,
  errorMessage,
  disabledReason,
  narrateModel,
  onToggle,
  onRegenerate,
}: NarrationToggleProps) {
  const isBusy = phase === 'loading';
  const isDisabled = disabledReason !== undefined;
  const modelSuffix = narrateModel ? ` — narrated by ${narrateModel}` : '';
  const title = isDisabled
    ? disabledReason
    : isBusy
      ? 'Generating narration…'
      : isNarratedView
        ? 'Switch back to git order'
        : `Switch to narrated review order${modelSuffix}`;

  return (
    <div className="border-b border-github-border px-4 py-3" data-narration-toggle="true">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-github-text-primary">
          {isBusy ? (
            <Loader2
              size={14}
              className="animate-spin text-github-text-secondary"
              aria-hidden="true"
            />
          ) : (
            <BookOpenText size={14} className="text-github-text-secondary" aria-hidden="true" />
          )}
          <span className="truncate" title={`Narrated review${modelSuffix}`}>
            Narrated review
          </span>
        </span>
        <div className="flex items-center gap-1">
          {isNarratedView && !isBusy && (
            <button
              type="button"
              onClick={onRegenerate}
              aria-label="Regenerate narration"
              title="Regenerate narration"
              className="rounded p-1 text-github-text-secondary transition-colors hover:bg-github-bg-tertiary hover:text-github-text-primary cursor-pointer"
            >
              <RotateCcw size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={isNarratedView}
            aria-label="Toggle narrated view"
            disabled={isDisabled}
            title={title}
            onClick={onToggle}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
              isNarratedView ? 'bg-github-accent' : 'bg-github-border'
            } ${isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-github-bg-primary transition-transform ${
                isNarratedView ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </button>
        </div>
      </div>

      {isBusy && (
        <div className="mt-2 text-xs text-github-text-secondary" role="status">
          Generating narration… the view stays in git order until it lands.
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-github-danger" title={errorMessage}>
            {errorMessage}
          </span>
          <button
            type="button"
            onClick={onRegenerate}
            aria-label="Retry narration"
            className="shrink-0 rounded border border-github-border px-2 py-1 text-xs text-github-text-primary transition-colors hover:bg-github-bg-tertiary cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
