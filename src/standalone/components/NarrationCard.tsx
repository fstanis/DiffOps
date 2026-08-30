import { BookOpenText } from 'lucide-react';
import type { MouseEvent } from 'react';

import { linkifyNarrationPaths, parseNarrationPathHref } from '../utils/narrationLinks';

import { CommentBodyRenderer } from './CommentBodyRenderer';

interface NarrationCardProps {
  title: string;
  body: string;
  changedPaths: string[];
  cardId: string;
  onNavigateToPath: (path: string) => void;
}

/** One narration card; exact changed-path mentions render as jump links. */
export function NarrationCard({
  title,
  body,
  changedPaths,
  cardId,
  onNavigateToPath,
}: NarrationCardProps) {
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) {
      return;
    }
    const path = parseNarrationPathHref(anchor.getAttribute('href') ?? '');
    if (!path) {
      return;
    }
    event.preventDefault();
    onNavigateToPath(path);
  };

  return (
    <section
      id={cardId}
      data-narration-card="true"
      className="mb-6 rounded-md border border-github-border bg-github-bg-secondary"
    >
      <header className="flex items-center gap-1.5 border-b border-github-border px-5 py-3 text-xs font-medium uppercase tracking-wide text-github-text-muted">
        <BookOpenText size={12} aria-hidden="true" />
        {title}
      </header>
      <div className="px-5 py-4" onClick={handleClick}>
        {body.trim() ? (
          <CommentBodyRenderer body={linkifyNarrationPaths(body, changedPaths)} />
        ) : (
          <p className="text-sm text-github-text-muted">No narrative for this file.</p>
        )}
      </div>
    </section>
  );
}
