import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'bun:test';

import type { DiffFile } from '../../types/diff';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import type { MergedChunk } from '../hooks/useExpandedLines';

import { NotebookDiffViewer } from './NotebookDiffViewer';
import type { DiffViewerBodyProps } from './types';

const notebookContent = JSON.stringify({
  cells: [
    {
      cell_type: 'markdown',
      source: ['# Notebook title\n'],
      metadata: {},
    },
    {
      cell_type: 'code',
      source: ['print("hi")\n'],
      execution_count: 1,
      metadata: {},
    },
  ],
  metadata: {
    language_info: {
      name: 'python',
    },
  },
  nbformat: 4,
  nbformat_minor: 5,
});

const createFile = (overrides: Partial<DiffFile> = {}): DiffFile => ({
  path: 'docs/notebook.ipynb',
  status: 'modified',
  additions: 1,
  deletions: 1,
  chunks: [],
  ...overrides,
});

const mergedChunks: MergedChunk[] = [
  {
    header: '@@ -1 +1 @@',
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [
      {
        type: 'context',
        content: notebookContent,
        oldLineNumber: 1,
        newLineNumber: 1,
      },
    ],
    originalIndices: [0],
    hiddenLinesBefore: 0,
    hiddenLinesAfter: 0,
  },
];

const createProps = (overrides: Partial<DiffViewerBodyProps> = {}): DiffViewerBodyProps => ({
  file: createFile(),
  threads: [],
  viewMode: 'unified',
  onViewModeChange: vi.fn(),
  mergedChunks,
  isExpandLoading: false,
  expandHiddenLines: vi.fn().mockResolvedValue(undefined),
  expandAllBetweenChunks: vi.fn().mockResolvedValue(undefined),
  onAddComment: vi.fn().mockResolvedValue(undefined),
  onGenerateThreadPrompt: vi.fn(),
  onRemoveThread: vi.fn(),
  onReplyToThread: vi.fn().mockResolvedValue(undefined),
  onRemoveMessage: vi.fn(),
  onUpdateMessage: vi.fn(),
  baseCommitish: 'HEAD~1',
  targetCommitish: 'HEAD',
  ...overrides,
});

const renderViewer = (overrides: Partial<DiffViewerBodyProps> = {}) =>
  render(
    <WordHighlightProvider>
      <NotebookDiffViewer {...createProps(overrides)} />
    </WordHighlightProvider>,
  );

describe('NotebookDiffViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and renders the full preview of the notebook', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => notebookContent,
    });

    renderViewer({ viewMode: 'full-preview' });

    expect(await screen.findByText('Notebook title')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/blob/docs%2Fnotebook.ipynb?ref=HEAD~1');
    expect(global.fetch).toHaveBeenCalledWith('/api/blob/docs%2Fnotebook.ipynb?ref=HEAD');
  });

  it('falls back to diff-preview when notebook content cannot be fetched', async () => {
    const onViewModeChange = vi.fn();
    (global.fetch as any).mockResolvedValue({
      ok: false,
      text: async () => '',
    });

    renderViewer({ viewMode: 'full-preview', onViewModeChange });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(onViewModeChange).toHaveBeenCalledWith('diff-preview');
    });
  });
});
