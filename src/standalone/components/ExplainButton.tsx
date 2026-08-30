import { Loader2, Sparkles } from 'lucide-react';

interface ExplainButtonProps {
  disabledReason?: string;
  isBusy: boolean;
  isActive: boolean;
  onClick: () => void;
}

// Small icon action for the file header toolbar; disabled states surface
// their reason through the title tooltip.
export const ExplainButton = ({
  disabledReason,
  isBusy,
  isActive,
  onClick,
}: ExplainButtonProps) => {
  const isDisabled = Boolean(disabledReason);
  const label = disabledReason ?? 'Explain this file with AI';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-label={label}
      title={label}
      className={`bg-transparent border-none px-1.5 py-1 rounded text-sm transition-all ${
        isDisabled
          ? 'cursor-not-allowed text-github-text-muted opacity-50'
          : isActive
            ? 'cursor-pointer text-github-accent hover:bg-github-bg-tertiary'
            : 'cursor-pointer text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary'
      }`}
    >
      {isBusy ? (
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      ) : (
        <Sparkles size={14} aria-hidden="true" />
      )}
    </button>
  );
};
