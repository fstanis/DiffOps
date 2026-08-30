import { AlertCircle, AlertTriangle, X } from 'lucide-react';

type MessageBannerProps = {
  tone: 'error' | 'warning';
  messages: string[];
  /** Pins the banner over a mounted review instead of placing it in the page flow. */
  isFloating: boolean;
  onDismiss: () => void;
};

const TONES = {
  error: {
    role: 'alert',
    testId: 'error-banner',
    borderClass: 'border-github-danger',
    iconClass: 'text-github-danger',
    icon: AlertCircle,
    dismissLabel: 'Dismiss error',
  },
  warning: {
    role: 'status',
    testId: 'warning-banner',
    borderClass: 'border-github-warning',
    iconClass: 'text-github-warning',
    icon: AlertTriangle,
    dismissLabel: 'Dismiss warning',
  },
} as const;

export const MessageBanner = ({ tone, messages, isFloating, onDismiss }: MessageBannerProps) => {
  if (messages.length === 0) {
    return null;
  }

  const { role, testId, borderClass, iconClass, icon: Icon, dismissLabel } = TONES[tone];
  const placementClass = isFloating
    ? 'fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-xl shadow-lg'
    : 'text-left';

  return (
    <div
      role={role}
      data-testid={testId}
      className={`flex items-start gap-3 bg-github-bg-secondary border ${borderClass} rounded-md px-4 py-3 ${placementClass}`}
    >
      <Icon size={18} className={`${iconClass} shrink-0 mt-0.5`} />
      <div className="text-sm text-github-text-primary">
        {messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="p-1 text-github-text-secondary hover:text-github-text-primary rounded"
        aria-label={dismissLabel}
      >
        <X size={14} />
      </button>
    </div>
  );
};
