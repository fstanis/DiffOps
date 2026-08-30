import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'bun:test';

import type { CommentThread, DiffFile } from '../../types/diff';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';

import { CurrentFileView } from './CurrentFileView';

const modifiedFile: DiffFile = {
  path: 'src/example.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  chunks: [
    {
      header: '@@ -1,4 +1,4 @@',
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 4,
      lines: [
        { type: 'normal', content: 'line one', oldLineNumber: 1, newLineNumber: 1 },
        { type: 'delete', content: 'line two old', oldLineNumber: 2 },
        { type: 'add', content: 'line two new', newLineNumber: 2 },
        { type: 'normal', content: 'line three', oldLineNumber: 3, newLineNumber: 3 },
      ],
    },
  ],
};

// The whole new file, including lines outside any hunk
const wholeFileLines = ['line one', 'line two new', 'line three', 'line four'];

const addedFile: DiffFile = {
  path: 'src/new-file.ts',
  status: 'added',
  additions: 2,
  deletions: 0,
  chunks: [
    {
      header: '@@ -0,0 +1,2 @@',
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      lines: [
        { type: 'add', content: 'brand new', newLineNumber: 1 },
        { type: 'add', content: 'second line', newLineNumber: 2 },
      ],
    },
  ],
};

const noop = () => {};
const asyncNoop = async () => {};

const createThread = (overrides: Partial<CommentThread> = {}): CommentThread => {
  const timestamp = '2024-01-01T00:00:00.000Z';
  return {
    id: 'thread-1',
    file: modifiedFile.path,
    line: 2,
    side: 'new',
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [
      { id: 'message-1', body: 'Thread body', createdAt: timestamp, updatedAt: timestamp },
    ],
    ...overrides,
  };
};

const renderView = (
  overrides: Partial<React.ComponentProps<typeof CurrentFileView>> = {},
  file = modifiedFile,
) =>
  render(
    <WordHighlightProvider>
      <CurrentFileView
        file={file}
        fileIndex={0}
        lines={file.status === 'added' ? ['brand new', 'second line'] : wholeFileLines}
        threads={[]}
        onAddComment={vi.fn().mockResolvedValue(undefined)}
        onGenerateThreadPrompt={() => ''}
        onRemoveThread={noop}
        onReplyToThread={asyncNoop}
        onRemoveMessage={noop}
        onUpdateMessage={noop}
        {...overrides}
      />
    </WordHighlightProvider>,
  );

const getRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-diff-line-row="true"]'));

describe('CurrentFileView', () => {
  it('renders the whole new file, including lines outside the hunks', () => {
    const { container } = renderView();

    const rows = getRows(container);
    expect(rows).toHaveLength(4);
    // Syntax highlighting splits words into spans, so assert on row content
    expect(rows[3]?.textContent).toContain('line four');
    expect(rows[2]?.textContent).toContain('line three');
  });

  it('renders a single line-number column with new-file numbers', () => {
    const { container } = renderView();

    const rows = getRows(container);
    rows.forEach((row, index) => {
      expect(row.children).toHaveLength(2);
      expect(row.children[0]?.textContent).toBe(String(index + 1));
    });
  });

  it('marks only changed lines with the accent bar class', () => {
    const { container } = renderView();

    const changedRows = getRows(container).filter((row) =>
      row.classList.contains('current-changed-row'),
    );
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]?.textContent).toContain('line two new');
  });

  it('marks no lines for a brand-new file', () => {
    const { container } = renderView({}, addedFile);

    expect(
      getRows(container).filter((row) => row.classList.contains('current-changed-row')),
    ).toHaveLength(0);
  });

  it('exposes anchor IDs derived from the diff chunks for keyboard navigation', () => {
    renderView();

    // Chunk line 0 is the normal line with newLineNumber 1
    expect(document.getElementById('file-0-chunk-0-line-0')).not.toBeNull();
    // Chunk line 2 is the added line with newLineNumber 2
    expect(document.getElementById('file-0-chunk-0-line-2')).not.toBeNull();
    // Chunk line 1 is the deleted line, which has no anchor in the new file
    expect(document.getElementById('file-0-chunk-0-line-1')).toBeNull();
  });

  it('submits a range comment anchored to new-file line numbers', async () => {
    const onAddComment = vi.fn().mockResolvedValue(undefined);
    const { container } = renderView({ onAddComment });

    const rows = getRows(container);
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[2]!, { shiftKey: true });

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Please revisit this range' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(onAddComment).toHaveBeenCalledWith(
        [1, 3],
        'Please revisit this range',
        ['line one', 'line two new', 'line three'].join('\n'),
        'new',
      );
    });
  });

  it('renders threads anchored to the new side and hides old-side threads', () => {
    renderView({
      threads: [
        createThread(),
        createThread({
          id: 'thread-2',
          line: 1,
          side: 'old',
          messages: [
            {
              id: 'message-2',
              body: 'Old side body',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        }),
      ],
    });

    expect(screen.getByText('Thread body')).toBeInTheDocument();
    expect(screen.queryByText('Old side body')).not.toBeInTheDocument();
  });

  it('opens the comment form at the triggered line', async () => {
    renderView({
      commentTrigger: { fileIndex: 0, chunkIndex: 0, lineIndex: 2 },
      onCommentTriggerHandled: noop,
    });

    const textarea = await screen.findByRole('textbox');
    expect(textarea).toBeInTheDocument();
  });
});
