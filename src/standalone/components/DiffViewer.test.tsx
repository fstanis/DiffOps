import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'bun:test';

import type { DiffFile } from '../../types/diff';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import type { MergedChunk } from '../hooks/useExpandedLines';

import { DiffViewer } from './DiffViewer';

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

const makeBinaryFile = (): DiffFile => ({
  path: 'assets/logo.png',
  status: 'modified',
  additions: 0,
  deletions: 0,
  chunks: [],
});

const makeOversizedFile = (): DiffFile => ({
  path: 'src/huge.ts',
  status: 'modified',
  additions: 1,
  deletions: 0,
  chunks: [
    {
      header: '@@ -1 +1 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        {
          type: 'add',
          // Comfortably over the 200 KB prompt threshold
          content: 'x'.repeat(210 * 1024),
          newLineNumber: 1,
        },
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

type DiffViewerProps = React.ComponentProps<typeof DiffViewer>;

const buildProps = (file: DiffFile, overrides: Partial<DiffViewerProps> = {}): DiffViewerProps => ({
  file,
  threads: [],
  diffMode: 'unified',
  reviewedFiles: new Set(),
  onToggleReviewed: noop,
  collapsedFiles: new Set(),
  onToggleCollapsed: noop,
  onToggleAllCollapsed: noop,
  allFiles: [file],
  commitLabel: 'abc1234...def5678',
  explainStatus: { enabled: true, model: 'anthropic/claude-sonnet-5' },
  onAddComment: asyncNoop,
  onGenerateThreadPrompt: () => '',
  onRemoveThread: noop,
  onReplyToThread: asyncNoop,
  onRemoveMessage: noop,
  onUpdateMessage: noop,
  mergedChunks: toMergedChunks(file),
  expandLines: asyncNoop,
  expandAllBetweenChunks: asyncNoop,
  prefetchFileContent: asyncNoop,
  isExpandLoading: false,
  ...overrides,
});

const renderViewer = (file: DiffFile, overrides: Partial<DiffViewerProps> = {}) =>
  render(
    <WordHighlightProvider>
      <DiffViewer {...buildProps(file, overrides)} />
    </WordHighlightProvider>,
  );

const jsonResponse = (data: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: async () => data }) as Promise<Response>;

const EXPLAIN_BUTTON_NAME = 'Explain this change with AI';

describe('DiffViewer explain feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(global.fetch).mockImplementation((_input: RequestInfo | URL) => jsonResponse({}));
  });

  const getExplainCalls = () =>
    vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url) === '/ai-gateway/explain');

  it('posts the assembled context for a modified file and renders the markdown explanation', async () => {
    vi.mocked(global.fetch).mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/ai-gateway/explain') {
        return jsonResponse({ explanation: '- Adds validation.\n- Keeps behavior.' });
      }
      return jsonResponse({});
    });

    renderViewer(makeModifiedFile());

    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    // Immediate feedback while the request is in flight
    expect(screen.getByRole('status')).toHaveTextContent('Generating explanation…');

    await waitFor(() => {
      expect(screen.getByText('AI explanation')).toBeInTheDocument();
    });
    // Markdown bullets are rendered as a list
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    const explainCalls = getExplainCalls();
    expect(explainCalls).toHaveLength(1);
    const [, init] = explainCalls[0] as [RequestInfo, RequestInit];
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as { prompt: string };
    expect(body.prompt).toContain('Revision range: abc1234...def5678');
    expect(body.prompt).toContain('- modified: src/example.ts');
    expect(body.prompt).toContain('## File: src/example.ts (modified)');
    expect(body.prompt).toContain(' context line');
    expect(body.prompt).toContain('-old line');
    expect(body.prompt).toContain('+new line');
  });

  it('posts the whole file content for an added file', async () => {
    vi.mocked(global.fetch).mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/ai-gateway/explain') {
        return jsonResponse({ explanation: 'A new module.' });
      }
      return jsonResponse({});
    });

    renderViewer(makeAddedFile());

    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    await waitFor(() => {
      expect(screen.getByText('A new module.')).toBeInTheDocument();
    });

    const [, init] = getExplainCalls()[0] as [RequestInfo, RequestInit];
    const body = JSON.parse(String(init.body)) as { prompt: string };
    expect(body.prompt).toContain('## File: src/fresh.ts (added)');
    expect(body.prompt).toContain('first added\nsecond added');
  });

  it('shows the error with a Retry button and recovers on retry', async () => {
    let shouldFail = true;
    vi.mocked(global.fetch).mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/ai-gateway/explain') {
        return shouldFail
          ? jsonResponse({ error: 'Failed to generate explanation' }, false, 502)
          : jsonResponse({ explanation: 'Works now.' });
      }
      return jsonResponse({});
    });

    renderViewer(makeModifiedFile());

    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(await screen.findByText('Failed to generate explanation')).toBeInTheDocument();

    shouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Works now.')).toBeInTheDocument();
    expect(getExplainCalls()).toHaveLength(2);
  });

  it('aborts an in-flight explanation when the panel is closed', async () => {
    let releaseRequest: (() => void) | undefined;
    vi.mocked(global.fetch).mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/ai-gateway/explain') {
        return new Promise<Response>((resolve) => {
          releaseRequest = () => resolve(jsonResponse({ explanation: 'late' }));
        });
      }
      return jsonResponse({});
    });

    renderViewer(makeModifiedFile());

    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));
    expect(screen.getByRole('status')).toBeInTheDocument();

    const [, init] = getExplainCalls()[0] as [RequestInfo, RequestInit];
    const signal = init.signal as AbortSignal;

    // Clicking Explain again collapses the panel and aborts the request
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(signal.aborted).toBe(true);

    releaseRequest?.();
  });

  it('disables the button with a tooltip naming the env var when no API key is configured', () => {
    renderViewer(makeModifiedFile(), {
      explainStatus: { enabled: false, model: 'anthropic/claude-sonnet-5' },
    });

    const button = screen.getByTitle(
      'Set the AI_GATEWAY_API_KEY environment variable to enable AI explanations',
    );
    expect(button).toBeDisabled();
  });

  it('disables the button with the offline reason when the gateway probe fails', () => {
    renderViewer(makeModifiedFile(), { explainStatus: null });

    const button = screen.getByTitle(
      'Explain needs the diffops server — it is offline or not serving this app',
    );
    expect(button).toBeDisabled();
  });

  it('disables the button for files without text content', () => {
    renderViewer(makeBinaryFile());

    const button = screen.getByTitle('Nothing to explain — this file has no text content');
    expect(button).toBeDisabled();
  });

  it('disables the button when the file exceeds the explain size limit', () => {
    // The file is collapsed so the huge line is never syntax-highlighted;
    // the header (and its Explain button) still renders.
    const file = makeOversizedFile();
    renderViewer(file, { collapsedFiles: new Set([file.path]) });

    const button = screen.getByTitle('File is too large to explain in a single request');
    expect(button).toBeDisabled();
  });

  it('disables the button while only a diff file is open', () => {
    const diffFileModeWindow = window as Window & { __DIFFOPS_DIFF_FILE_MODE__?: boolean };
    diffFileModeWindow.__DIFFOPS_DIFF_FILE_MODE__ = true;
    try {
      renderViewer(makeModifiedFile());

      const button = screen.getByTitle(
        'Explain needs a repository — open a repository to explain files',
      );
      expect(button).toBeDisabled();
    } finally {
      delete diffFileModeWindow.__DIFFOPS_DIFF_FILE_MODE__;
    }
  });

  it('keeps a loaded explanation across file collapse and re-expand without a second request', async () => {
    vi.mocked(global.fetch).mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/ai-gateway/explain') {
        return jsonResponse({ explanation: 'Cached explanation.' });
      }
      return jsonResponse({});
    });

    const file = makeModifiedFile();
    const { rerender } = renderViewer(file);

    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));
    expect(await screen.findByText('Cached explanation.')).toBeInTheDocument();

    rerender(
      <WordHighlightProvider>
        <DiffViewer {...buildProps(file, { collapsedFiles: new Set([file.path]) })} />
      </WordHighlightProvider>,
    );
    // File collapsed: the panel is hidden but the explanation is retained
    expect(screen.queryByText('Cached explanation.')).not.toBeInTheDocument();

    rerender(
      <WordHighlightProvider>
        <DiffViewer {...buildProps(file)} />
      </WordHighlightProvider>,
    );
    // Re-expanded: instantly visible again, without another API call
    expect(screen.getByText('Cached explanation.')).toBeInTheDocument();
    expect(getExplainCalls()).toHaveLength(1);
  });
});
