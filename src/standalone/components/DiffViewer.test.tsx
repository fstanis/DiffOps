import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'bun:test';

import { type DiffFile, type FileExplanation } from '../../types/diff';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import type { MergedChunk } from '../hooks/useExpandedLines';
import { DEFAULT_AI_SETTINGS } from '../hooks/useAiSettings';
import type { FileExplanationRequest } from '../services/aiGateway';
import { buildFileExplanationFingerprint } from '../utils/explanationFingerprint';

import { DiffViewer } from './DiffViewer';

// The gateway is the network boundary here; the hook's own fetches (blob content, persistence) stay on the global fetch mock.
const generateFileExplanation =
  vi.fn<(request: FileExplanationRequest) => Promise<FileExplanation>>();
vi.mock('../services/aiGateway', () => ({ generateFileExplanation }));

// Each fixture gets its own path: the whole-file content cache is keyed by path, so distinct paths keep tests from sharing fetched content.
const makeModifiedFile = (path = 'src/example.ts'): DiffFile => ({
  path,
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
  status: 'deleted',
  additions: 0,
  deletions: 2,
  chunks: [
    {
      header: '@@ -1,2 +0,0 @@',
      oldStart: 1,
      oldLines: 2,
      newStart: 0,
      newLines: 0,
      lines: [
        { type: 'delete', content: 'first removed', oldLineNumber: 1 },
        { type: 'delete', content: 'second removed', oldLineNumber: 2 },
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

const makeAddedFile = (path = 'src/fresh.ts'): DiffFile => ({
  path,
  status: 'added',
  additions: 25,
  deletions: 0,
  chunks: [
    {
      header: '@@ -0,0 +1,25 @@',
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 25,
      lines: Array.from({ length: 25 }, (_, index) => ({
        type: 'add' as const,
        content: `added line ${index}`,
        newLineNumber: index + 1,
      })),
    },
  ],
});

const makeFileContent = (lineCount: number, firstLines: string[] = []): string =>
  [
    ...firstLines,
    ...Array.from(
      { length: Math.max(lineCount - firstLines.length, 0) },
      (_, i) => `line ${i} = ${i};`,
    ),
  ].join('\n');

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
  viewMode: 'unified',
  onFileViewModeChange: noop,
  reviewedFiles: new Set(),
  onToggleReviewed: noop,
  collapsedFiles: new Set(),
  onToggleCollapsed: noop,
  onToggleAllCollapsed: noop,
  commitLabel: 'abc1234...def5678',
  aiSettings: { ...DEFAULT_AI_SETTINGS, apiKey: 'test-key' },
  onAddComment: asyncNoop,
  onGenerateThreadPrompt: () => '',
  onRemoveThread: noop,
  onReplyToThread: asyncNoop,
  onRemoveMessage: noop,
  onUpdateMessage: noop,
  targetCommitish: 'HEAD',
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

const textResponse = (content: string) =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: async () => content,
    json: async () => ({}),
  }) as Promise<Response>;

const EXPLAIN_BUTTON_NAME = 'Explain this file with AI';
const REASK_BUTTON_NAME = 'Re-ask with these files';

const structuredExplanation = (overrides: Partial<FileExplanation> = {}): FileExplanation => ({
  fileSummary: 'Runs the app.',
  symbols: [
    {
      name: 'parseStream',
      type: 'function',
      summary: 'Turns samples into beats.',
      isPublic: true,
      contract: { input: 'samples', output: 'beats' },
    },
    {
      name: 'MAX_GAP_MS',
      type: 'constant',
      summary: 'Longest gap still one beat.',
      isPublic: true,
    },
  ],
  additionalFilesNeeded: [],
  ...overrides,
});

interface BlobRouting {
  [path: string]: string;
}

const mockExplainFetches = (options: {
  blobs?: BlobRouting;
  /** A value or a late-binding getter, so tests can swap answers between rounds. */
  explanation?: FileExplanation | (() => FileExplanation);
  stored?: unknown;
}) => {
  vi.mocked(global.fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/blob/')) {
      const path = decodeURIComponent(url.replace('/api/blob/', '').split('?')[0] ?? '');
      const content = options.blobs?.[path];
      return content === undefined
        ? jsonResponse({ error: 'not found' }, false, 404)
        : textResponse(content);
    }
    if (url.startsWith('/api/explanation')) {
      return jsonResponse({ explanation: options.stored ?? null });
    }
    return jsonResponse({});
  });
  generateFileExplanation.mockImplementation(() =>
    Promise.resolve(
      typeof options.explanation === 'function'
        ? options.explanation()
        : (options.explanation as FileExplanation),
    ),
  );
};

const getCalls = (urlPrefix: string) =>
  vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).startsWith(urlPrefix));

const explainRequests = (): FileExplanationRequest[] =>
  generateFileExplanation.mock.calls.map(([request]) => request);

describe('DiffViewer explain feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateFileExplanation.mockReset();
    vi.mocked(global.fetch).mockImplementation((_input: RequestInfo | URL) => jsonResponse({}));
  });

  it('posts the whole current file with its verified import candidates for a modified file', async () => {
    const wholeFile = makeFileContent(25, ["import { helper } from './helper';"]);
    mockExplainFetches({
      blobs: {
        'src/example.ts': wholeFile,
        'src/helper.ts': 'export const helper = 1;',
      },
      explanation: structuredExplanation(),
    });

    renderViewer(makeModifiedFile());
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(await screen.findByText('Runs the app.')).toBeInTheDocument();

    const requests = explainRequests();
    expect(requests).toHaveLength(1);
    const request = requests[0] as FileExplanationRequest;
    expect(request.model).toBe(DEFAULT_AI_SETTINGS.explainModel);
    expect(request.apiKey).toBe('test-key');
    expect(request.prompt).toContain('## File: src/example.ts');
    expect(request.prompt).toContain(wholeFile);
    expect(request.prompt).toContain('## Files you may request');
    expect(request.prompt).not.toContain('Unified diff');
    expect(request.candidateFiles).toEqual(['src/helper.ts']);
  });

  it('posts the whole file content for an added file without fetching its blob', async () => {
    mockExplainFetches({ explanation: structuredExplanation({ fileSummary: 'A new module.' }) });

    renderViewer(makeAddedFile());
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(await screen.findByText('A new module.')).toBeInTheDocument();

    const request = explainRequests()[0] as FileExplanationRequest;
    expect(request.prompt).toContain('## File: src/fresh.ts');
    expect(request.prompt).toContain('added line 0\nadded line 1');
    expect(request.candidateFiles).toEqual([]);
    expect(getCalls('/api/blob/')).toHaveLength(0);
  });

  it('renders the structured explanation as a markdown outline with contracts', async () => {
    mockExplainFetches({
      blobs: { 'src/outline.ts': makeFileContent(25) },
      explanation: structuredExplanation(),
    });

    renderViewer(makeModifiedFile('src/outline.ts'));
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(await screen.findByText('Runs the app.')).toBeInTheDocument();
    expect(screen.getByText('parseStream')).toBeInTheDocument();
    expect(screen.getByText(/Turns samples into beats/)).toBeInTheDocument();
    expect(screen.getByText('In: samples')).toBeInTheDocument();
    expect(screen.getByText('Out: beats')).toBeInTheDocument();
    expect(screen.getByText('MAX_GAP_MS')).toBeInTheDocument();
  });

  it('offers one re-ask round and replaces the answer with the grounded one', async () => {
    const firstExplanation = structuredExplanation({ additionalFilesNeeded: ['src/helper.ts'] });
    const finalExplanation = structuredExplanation({ fileSummary: 'Grounded now.' });
    let requestedRound = 0;
    mockExplainFetches({
      blobs: {
        'src/reask.ts': makeFileContent(25, ["import { helper } from './helper';"]),
        'src/helper.ts': 'export const helper = 1;',
      },
      explanation: () => {
        requestedRound += 1;
        return requestedRound === 1 ? firstExplanation : finalExplanation;
      },
    });

    renderViewer(makeModifiedFile('src/reask.ts'), {
      explainSessionQueryString: 'base=main&target=feature',
    });
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(await screen.findByText('Runs the app.')).toBeInTheDocument();
    expect(screen.getByText('The model would explain this file better with:')).toBeInTheDocument();
    expect(screen.getByText('src/helper.ts')).toBeInTheDocument();

    const reaskButton = screen.getByRole('button', { name: REASK_BUTTON_NAME });
    await waitFor(() => {
      expect(reaskButton).toBeEnabled();
    });
    fireEvent.click(reaskButton);

    expect(await screen.findByText('Grounded now.')).toBeInTheDocument();

    const requests = explainRequests();
    expect(requests).toHaveLength(2);
    const reaskRequest = requests[1] as FileExplanationRequest;
    expect(reaskRequest.candidateFiles).toEqual([]);
    expect(reaskRequest.prompt).toContain('final round');
    expect(reaskRequest.prompt).toContain('## Supporting files');
    expect(reaskRequest.prompt).toContain('### src/helper.ts');
    expect(reaskRequest.prompt).toContain('export const helper = 1;');

    expect(screen.queryByRole('button', { name: REASK_BUTTON_NAME })).not.toBeInTheDocument();

    const putCalls = getCalls('/api/explanation').filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(2);
    const [, lastPutInit] = putCalls[1] as [RequestInfo, RequestInit];
    const putBody = JSON.parse(String(lastPutInit.body)) as {
      includedSupportingFiles: string[];
      explanation: FileExplanation;
    };
    expect(putBody.includedSupportingFiles).toEqual(['src/helper.ts']);
    expect(putBody.explanation.fileSummary).toBe('Grounded now.');
  });

  it('disables the re-ask button with a reason when the combined prompt would exceed the cap', async () => {
    mockExplainFetches({
      blobs: {
        'src/reask-cap.ts': makeFileContent(25, ["import { big } from './big';"]),
        'src/big.ts': `${'x'.repeat(205 * 1024)}`,
      },
      explanation: structuredExplanation({ additionalFilesNeeded: ['src/big.ts'] }),
    });

    renderViewer(makeModifiedFile('src/reask-cap.ts'));
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    const reaskButton = await screen.findByRole('button', { name: REASK_BUTTON_NAME });
    await waitFor(() => {
      expect(reaskButton).toBeDisabled();
    });
    expect(reaskButton.title).toContain('KB explain limit');
    expect(screen.getByText(/KB explain limit/)).toBeInTheDocument();
  });

  it('shows the error with a Retry button and recovers on retry', async () => {
    let shouldFail = true;
    mockExplainFetches({ blobs: { 'src/retry.ts': makeFileContent(25) } });
    generateFileExplanation.mockImplementation(() =>
      shouldFail
        ? Promise.reject(new Error('Failed to generate explanation'))
        : Promise.resolve(structuredExplanation({ fileSummary: 'Works now.' })),
    );

    renderViewer(makeModifiedFile('src/retry.ts'));
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(await screen.findByText('Failed to generate explanation')).toBeInTheDocument();

    shouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Works now.')).toBeInTheDocument();
    expect(explainRequests()).toHaveLength(2);
  });

  it('aborts an in-flight explanation when the panel is closed', async () => {
    let releaseRequest: (() => void) | undefined;
    mockExplainFetches({ blobs: { 'src/abort.ts': makeFileContent(25) } });
    generateFileExplanation.mockImplementation(
      () =>
        new Promise<FileExplanation>((resolve) => {
          releaseRequest = () => resolve(structuredExplanation({ fileSummary: 'late' }));
        }),
    );

    renderViewer(makeModifiedFile('src/abort.ts'));
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));
    expect(screen.getByRole('status')).toBeInTheDocument();

    await waitFor(() => {
      expect(explainRequests()).toHaveLength(1);
    });
    const signal = (explainRequests()[0] as FileExplanationRequest).signal as AbortSignal;

    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(signal.aborted).toBe(true);

    releaseRequest?.();
  });

  it('disables the button pointing at Settings when no API key is configured', () => {
    renderViewer(makeModifiedFile('src/gated.ts'), { aiSettings: DEFAULT_AI_SETTINGS });

    const button = screen.getByTitle(
      'Add an AI Gateway API key in Settings to enable AI explanations',
    );
    expect(button).toBeDisabled();
  });

  it('disables the button for deleted files', () => {
    renderViewer(makeDeletedFile());

    const button = screen.getByTitle('Nothing to explain — this file was deleted');
    expect(button).toBeDisabled();
  });

  it('disables the button for files without text content', () => {
    renderViewer(makeBinaryFile());

    const button = screen.getByTitle('Nothing to explain — this file has no text content');
    expect(button).toBeDisabled();
  });

  it('disables the button for files with fewer than 20 non-empty lines', async () => {
    mockExplainFetches({ blobs: { 'src/short.ts': makeFileContent(5) } });

    renderViewer(makeModifiedFile('src/short.ts'));

    const button = await screen.findByTitle(
      'File is too short to explain — fewer than 20 non-empty lines',
    );
    expect(button).toBeDisabled();
  });

  it('disables the button when the whole file exceeds the explain size limit', async () => {
    // 25 lines of ~8.5 KB each — over the cap, but still enough non-empty lines to pass the length gate.
    const hugeContent = Array.from({ length: 25 }, () => 'x'.repeat(8500)).join('\n');
    mockExplainFetches({ blobs: { 'src/huge.ts': hugeContent } });

    renderViewer(makeModifiedFile('src/huge.ts'));

    const button = await screen.findByTitle('File is too large to explain in a single request');
    expect(button).toBeDisabled();
  });

  it('disables the button while only a diff file is open', () => {
    const diffFileModeWindow = window as Window & { __DIFFOPS_DIFF_FILE_MODE__?: boolean };
    diffFileModeWindow.__DIFFOPS_DIFF_FILE_MODE__ = true;
    try {
      renderViewer(makeModifiedFile('src/stdin.ts'));

      const button = screen.getByTitle(
        'Explain needs a repository — open a repository to explain files',
      );
      expect(button).toBeDisabled();
    } finally {
      delete diffFileModeWindow.__DIFFOPS_DIFF_FILE_MODE__;
    }
  });

  it('restores a persisted explanation for the matching fingerprint without a model call', async () => {
    const file = makeModifiedFile('src/restored.ts');
    const storedExplanation = structuredExplanation({ fileSummary: 'Restored summary.' });
    const fingerprint = buildFileExplanationFingerprint('abc1234...def5678', file);
    mockExplainFetches({
      blobs: { 'src/restored.ts': makeFileContent(25) },
      stored: {
        explanation: storedExplanation,
        includedSupportingFiles: [],
        fingerprint,
        updatedAt: '2026-08-29T00:00:00.000Z',
      },
    });

    renderViewer(file, { explainSessionQueryString: 'base=main&target=feature' });
    // Let the persisted explanation land before opening the panel, so the click observes the restored state instead of racing it.
    await waitFor(() => {
      expect(getCalls('/api/explanation')).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(await screen.findByText('Restored summary.')).toBeInTheDocument();
    expect(explainRequests()).toHaveLength(0);
  });

  it('treats a stale persisted fingerprint as absent', async () => {
    mockExplainFetches({
      blobs: { 'src/stale.ts': makeFileContent(25) },
      explanation: structuredExplanation({ fileSummary: 'Fresh answer.' }),
      stored: {
        explanation: structuredExplanation({ fileSummary: 'Outdated answer.' }),
        includedSupportingFiles: [],
        fingerprint: 'an-old-fingerprint',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    });

    renderViewer(makeModifiedFile('src/stale.ts'), {
      explainSessionQueryString: 'base=main&target=feature',
    });
    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));

    expect(await screen.findByText('Fresh answer.')).toBeInTheDocument();
    expect(screen.queryByText('Outdated answer.')).not.toBeInTheDocument();
  });

  it('keeps a loaded explanation across file collapse and re-expand without a second request', async () => {
    mockExplainFetches({
      blobs: { 'src/kept.ts': makeFileContent(25) },
      explanation: structuredExplanation({ fileSummary: 'Cached explanation.' }),
    });

    const file = makeModifiedFile('src/kept.ts');
    const { rerender } = renderViewer(file);

    fireEvent.click(screen.getByRole('button', { name: EXPLAIN_BUTTON_NAME }));
    expect(await screen.findByText('Cached explanation.')).toBeInTheDocument();

    rerender(
      <WordHighlightProvider>
        <DiffViewer {...buildProps(file, { collapsedFiles: new Set([file.path]) })} />
      </WordHighlightProvider>,
    );
    expect(screen.queryByText('Cached explanation.')).not.toBeInTheDocument();

    rerender(
      <WordHighlightProvider>
        <DiffViewer {...buildProps(file)} />
      </WordHighlightProvider>,
    );
    expect(screen.getByText('Cached explanation.')).toBeInTheDocument();
    expect(explainRequests()).toHaveLength(1);
  });
});
