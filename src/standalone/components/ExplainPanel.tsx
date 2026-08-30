import { Loader2, RotateCcw, Sparkles } from 'lucide-react';

import type { FileExplanation } from '../../types/diff';
import { formatFileExplanation } from '../../utils/explanationMarkdown';
import { type FileExplainPhase } from '../hooks/useFileExplain';

import { CommentBodyRenderer } from './CommentBodyRenderer';

interface ExplainPanelProps {
  phase: FileExplainPhase;
  explanation: FileExplanation | null;
  errorMessage: string;
  /** Files the model asked for; non-empty renders the one-round re-ask offer. */
  requestedFiles: string[];
  reaskDisabledReason?: string;
  onReask: () => void;
  onRetry: () => void;
}

export const ExplainPanel = ({
  phase,
  explanation,
  errorMessage,
  requestedFiles,
  reaskDisabledReason,
  onReask,
  onRetry,
}: ExplainPanelProps) => (
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

    {phase === 'loaded' && explanation && (
      <CommentBodyRenderer body={formatFileExplanation(explanation)} />
    )}

    {phase === 'loaded' && requestedFiles.length > 0 && (
      <div className="mt-3 pt-3 border-t border-github-border">
        <p className="m-0 mb-2 text-xs text-github-text-secondary">
          The model would explain this file better with:
        </p>
        <ul className="mt-0 mb-3 pl-5 list-disc">
          {requestedFiles.map((path) => (
            <li key={path} className="text-xs font-mono text-github-text-primary">
              {path}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onReask}
            disabled={Boolean(reaskDisabledReason)}
            title={reaskDisabledReason ?? 'Explain again with these files included'}
            className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-all duration-200 ${
              reaskDisabledReason
                ? 'cursor-not-allowed text-github-text-muted border-github-border opacity-60'
                : 'cursor-pointer bg-github-bg-secondary text-github-text-primary border-github-border hover:bg-github-bg-tertiary hover:border-github-text-muted'
            }`}
          >
            Re-ask with these files
          </button>
          {reaskDisabledReason && (
            <span className="text-xs text-github-text-muted">{reaskDisabledReason}</span>
          )}
        </div>
      </div>
    )}

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
