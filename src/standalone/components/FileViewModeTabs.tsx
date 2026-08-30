import { AlignLeft, Columns, Eye, FileText } from 'lucide-react';

import type { FileViewMode } from '../../types/diff';

type FileViewModeTabsProps = {
  viewMode: FileViewMode;
  options: readonly FileViewMode[];
  onModeChange: (mode: FileViewMode) => void;
};

const TABS_BY_MODE: Record<FileViewMode, { label: string; title: string; icon: typeof AlignLeft }> =
  {
    unified: { label: 'Unified', title: 'Inline diff', icon: AlignLeft },
    split: { label: 'Split', title: 'Side-by-side diff', icon: Columns },
    full: {
      label: 'Full',
      title: 'Show the whole new file with changed lines marked',
      icon: FileText,
    },
    'diff-preview': {
      label: 'Diff Preview',
      title: 'Rendered preview of the changed sections',
      icon: Eye,
    },
    'full-preview': {
      label: 'Full Preview',
      title: 'Rendered preview of the whole file',
      icon: Eye,
    },
  };

export const FileViewModeTabs = ({ viewMode, options, onModeChange }: FileViewModeTabsProps) => (
  <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="File view mode">
    {options.map((option) => {
      const tab = TABS_BY_MODE[option];
      const Icon = tab.icon;
      return (
        <button
          key={option}
          type="button"
          onClick={() => onModeChange(option)}
          aria-pressed={viewMode === option}
          title={tab.title}
          className={`px-2 py-1 text-xs font-medium rounded transition-colors duration-200 flex items-center gap-1 cursor-pointer ${
            viewMode === option
              ? 'text-github-text-primary border-b-2 border-github-accent'
              : 'text-github-text-secondary hover:text-github-text-primary'
          }`}
        >
          <Icon size={14} />
          {tab.label}
        </button>
      );
    })}
  </div>
);
