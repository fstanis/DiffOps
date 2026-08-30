import { Loader2, RotateCcw, Sparkles } from 'lucide-react';

import type { FileExplainPhase } from '../hooks/useFileExplain';

import { CommentBodyRenderer } from './CommentBodyRenderer';

interface ExplainPanelProps {
  phase: FileExplainPhase;
  explanation: string;
  errorMessage: string;
  onRetry: () => void;
}

// Inline explanation area directly below the file header; markdown in the
// explanation is rendered with the same renderer used for comments.
export const ExplainPanel = ({ phase, explanation, errorMessage, onRetry }: ExplainPanelProps) => (
  <div className="bg-github-bg-secondary border-b border-github-border px-5 py-4">
    <div className="flex items-center gap-1.5 mb-2 text-xs font-medium uppercase tracking-wide text-github-text-muted">
      <Sparkles size={12} aria-hidden="true" />
      AI explanation
    </div>

    {phase === 'loading' && (
      <div className="flex items-center gap-2 text-github-text-secondary" role="status">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Generating explanation…
      </div>
    )}

    {phase === 'loaded' && <CommentBodyRenderer body={explanation} />}

    {phase === 'error' && (
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-sm text-github-danger">{errorMessage}</span>
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-github-bg-secondary text-github-text-primary border border-github-border hover:bg-github-bg-tertiary hover:border-github-text-muted transition-all duration-200 cursor-pointer"
        >
          <RotateCcw size={14} aria-hidden="true" />
          Retry
        </button>
      </div>
    )}
  </div>
);
