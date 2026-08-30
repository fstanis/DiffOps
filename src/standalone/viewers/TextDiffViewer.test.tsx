import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'bun:test';

import type { DiffFile } from '../../types/diff';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import type { MergedChunk } from '../hooks/useExpandedLines';

import { TextDiffViewer } from './TextDiffViewer';
import type { DiffViewerBodyProps } from './types';

// Factories return fresh objects per test so the WeakMap content cache in
// useCurrentFileContent does not leak content between tests
const makeModifiedFile = (): DiffFile => ({
  path: 'src/example.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  chunks: [
    {
      header: '@@ -1,3 +1,3 @@',
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        { type: 'normal', content: 'context line', oldLineNumber: 1, newLineNumber: 1 },
        { type: 'delete', content: 'old line', oldLineNumber: 2 },
        { type: 'add', content: 'new line', newLineNumber: 2 },
      ],
    },
  ],
});
const makeDeletedFile = (): DiffFile => ({
  path: 'src/gone.ts',
  oldPath: 'src/gone.ts',
  status: 'deleted',
  additions: 0,
  deletions: 1,
  chunks: [
    {
      header: '@@ -1 +0,0 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
      lines: [{ type: 'delete', content: 'removed line', oldLineNumber: 1 }],
    },
  ],
});

const makeAddedFile = (): DiffFile => ({
  path: 'src/fresh.ts',
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
        { type: 'add', content: 'first added', newLineNumber: 1 },
        { type: 'add', content: 'second added', newLineNumber: 2 },
      ],
    },
  ],
});

const toMergedChunks = (file: DiffFile): MergedChunk[] =>
  file.chunks.map((chunk, index) => ({
    ...chunk,
    originalIndices: [index],
    hiddenLinesBefore: 0,
    hiddenLinesAfter: 0,
  }));

const noop = () => {};
const asyncNoop = async () => {};

const baseProps: Omit<DiffViewerBodyProps, 'file'> = {
  threads: [],
  diffMode: 'current',
  targetCommitish: 'HEAD',
  mergedChunks: [],
  isExpandLoading: false,
  expandHiddenLines: asyncNoop,
  expandAllBetweenChunks: asyncNoop,
  onAddComment: vi.fn().mockResolvedValue(undefined),
  onGenerateThreadPrompt: () => '',
  onRemoveThread: noop,
  onReplyToThread: asyncNoop,
  onRemoveMessage: noop,
  onUpdateMessage: noop,
};

const renderViewer = (file: DiffFile, overrides: Partial<DiffViewerBodyProps> = {}) =>
  render(
    <WordHighlightProvider>
      <TextDiffViewer
        {...baseProps}
        file={file}
        mergedChunks={toMergedChunks(file)}
        {...overrides}
      />
    </WordHighlightProvider>,
  );

const mockBlobFetch = (handler: (url: string) => Promise<Response>) => {
  (global.fetch as any).mockImplementation((url: string) => handler(url));
};

describe('TextDiffViewer current mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the whole new file with changed lines marked', async () => {
    mockBlobFetch(
      async () =>
        ({
          ok: true,
          text: async () => 'first line\nnew line\nthird line\nfourth line',
        }) as unknown as Response,
    );

    const { container } = renderViewer(makeModifiedFile());

    await waitFor(() => {
      expect(container.textContent).toContain('fourth line');
    });
    expect(container.textContent).toContain('first line');

    const changedRows = Array.from(
      container.querySelectorAll('[data-diff-line-row="true"].current-changed-row'),
    );
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]?.textContent).toContain('new line');
  });

  it('shows a loading placeholder while the blob is being fetched', () => {
    mockBlobFetch(() => new Promise(() => {}) as unknown as Promise<Response>);

    const { container } = renderViewer(makeModifiedFile());

    expect(container.textContent).toContain('Loading file…');
    expect(container.textContent).not.toContain('new line');
  });

  it('derives content from chunks for added files without fetching a blob', async () => {
    mockBlobFetch(async () => {
      throw new Error('should not be called');
    });

    const { container } = renderViewer(makeAddedFile());

    await waitFor(() => {
      expect(container.textContent).toContain('second added');
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls back to the unified diff for deleted files', () => {
    const { container } = renderViewer(makeDeletedFile());

    expect(container.textContent).toContain('removed line');
    expect(container.textContent).not.toContain('Loading file…');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls back to the unified diff when the blob cannot be fetched', async () => {
    mockBlobFetch(async () => ({ ok: false, statusText: 'Not Found' }) as unknown as Response);

    const { container } = renderViewer(makeModifiedFile());

    await waitFor(() => {
      expect(container.textContent).toContain('old line');
    });
    expect(container.textContent).toContain('new line');
    expect(container.textContent).not.toContain('Loading file…');
  });
});
