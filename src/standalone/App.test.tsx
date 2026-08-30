import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import '@testing-library/jest-dom';

import { mockFetch } from '../testing/preload';
import type { DiffCommentThread, DiffFile, DiffResponse, Narration } from '../types/diff';

import App from './App';
import type { BridgeEvent } from './bridgeEvents';
import { useDiffComments } from './hooks/useDiffComments';
import { useViewedFiles } from './hooks/useViewedFiles';
import { useViewport } from './hooks/useViewport';
import { DEFAULT_AI_SETTINGS } from './hooks/useAiSettings';
import { buildChangesetFingerprint } from './utils/narrationFingerprint';

// The AI gateway is the app's only outbound network call; everything else the app fetches goes through the global fetch mock.
const generateNarration = vi.fn<() => Promise<Narration>>();
const generateFileExplanation = vi.fn();
vi.mock('./services/aiGateway', () => ({ generateNarration, generateFileExplanation }));

/** Seeds the API key the AI features gate on, as Settings would. */
const enableAiSettings = () => {
  window.localStorage.setItem(
    'diffops-ai-settings',
    JSON.stringify({ ...DEFAULT_AI_SETTINGS, apiKey: 'test-key' }),
  );
};

vi.mock('./hooks/useViewport', () => ({
  useViewport: vi.fn(() => ({ isMobile: false, isDesktop: true })),
}));

vi.mock('./hooks/useDiffComments', () => ({
  useDiffComments: vi.fn(() => ({
    hasLoadedComments: true,
    comments: [],
    threads: mockComments,
    replaceThreads: mockReplaceThreads,
    addComment: vi.fn(),
    addThread: vi.fn(),
    removeComment: vi.fn(),
    removeThread: vi.fn(),
    removeMessage: vi.fn(),
    replyToThread: vi.fn(),
    updateComment: vi.fn(),
    updateMessage: vi.fn(),
    clearAllComments: mockClearAllComments,
    generatePrompt: vi.fn(),
    generateThreadPrompt: vi.fn(),
    generateAllCommentsPrompt: mockGenerateAllCommentsPrompt,
  })),
}));

const mockClearViewedFiles = vi.fn();
const mockToggleFileViewed = vi.fn();
let mockViewedFiles = new Set<string>();
let mockHasLoadedInitialViewedFiles = true;
vi.mock('./hooks/useViewedFiles', () => ({
  useViewedFiles: vi.fn(() => ({
    viewedFiles: mockViewedFiles,
    changedSinceViewedFiles: new Set<string>(),
    hasLoadedInitialViewedFiles: mockHasLoadedInitialViewedFiles,
    toggleFileViewed: mockToggleFileViewed,
    isFileContentChanged: vi.fn(),
    getViewedFileRecord: vi.fn(),
    clearViewedFiles: mockClearViewedFiles,
  })),
}));

let bridgeEventListener: ((event: BridgeEvent) => void) | null = null;

vi.mock('./bridgeEvents', () => ({
  subscribeToBridgeEvents: vi.fn((listener: (event: BridgeEvent) => void) => {
    bridgeEventListener = listener;
    return () => {
      bridgeEventListener = null;
    };
  }),
}));

Object.defineProperty(navigator, 'sendBeacon', {
  writable: true,
  value: vi.fn(),
});

const mockConfirm = vi.fn();
Object.defineProperty(window, 'confirm', {
  writable: true,
  value: mockConfirm,
});

let mockComments: DiffCommentThread[] = [];
const mockReplaceThreads = vi.fn();
const mockClearAllComments = vi.fn();
const mockGenerateAllCommentsPrompt = vi.fn(() => 'formatted prompt');

// Per-file view modes are stored per repository; the mock diff carries no id, so they land under the default scope.
const FILE_VIEW_MODES_KEY = 'diffops.fileViewModes:default';

function createMockThread({
  id,
  filePath,
  line,
  body,
  author = 'User',
}: {
  id: string;
  filePath: string;
  line: number;
  body: string;
  author?: string;
}): DiffCommentThread {
  const timestamp = '2024-01-01T00:00:00.000Z';
  return {
    id,
    filePath,
    createdAt: timestamp,
    updatedAt: timestamp,
    position: { side: 'new', line },
    messages: [
      {
        id,
        body,
        author,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

const renderApp = () => {
  return render(
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <App />
    </HotkeysProvider>,
  );
};

beforeEach(() => {
  window.localStorage.clear();
  generateNarration.mockReset();
  generateFileExplanation.mockReset();
  vi.unstubAllEnvs();
  mockViewedFiles = new Set<string>();
  mockHasLoadedInitialViewedFiles = true;
  mockReplaceThreads.mockReset();
  mockGenerateAllCommentsPrompt.mockClear();
});

const mockDiffResponse: DiffResponse = {
  commit: 'abc123',
  baseCommitish: 'HEAD^',
  targetCommitish: 'HEAD',
  requestedBaseCommitish: 'HEAD^',
  requestedTargetCommitish: 'HEAD',
  files: [
    {
      path: 'test.ts',
      status: 'modified',
      additions: 5,
      deletions: 2,
      chunks: [],
    },
  ],
  ignoreWhitespace: false,
  isEmpty: false,
};

describe('App Component - Clear Comments Functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  it('enables the per-file Explain button once an API key is configured', async () => {
    enableAiSettings();
    // An added file carries its whole content in the hunks, so explain can gate on it without any blob fetch.
    const diffWithContent: DiffResponse = {
      ...mockDiffResponse,
      files: [
        {
          path: 'test.ts',
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
        },
      ],
    };
    const mockGlobalFetch = vi.mocked(global.fetch);
    mockGlobalFetch.mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ specialOptions: [], branches: [], commits: [] }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => diffWithContent } as Response);
    });

    renderApp();

    const explainButton = await screen.findByRole('button', {
      name: 'Explain this file with AI',
    });
    expect(explainButton).toBeEnabled();
  });

  describe('Copy All Prompt Button', () => {
    it('should generate Copy All Prompt with requested and resolved diff context', async () => {
      mockComments = [
        createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
      ];
      mockFetch({
        ...mockDiffResponse,
        baseCommitish: 'abcdef1',
        targetCommitish: '1234567',
        requestedBaseCommitish: 'main',
        requestedTargetCommitish: 'feature/docs-update',
        requestedBaseMode: 'merge-base',
      });

      renderApp();

      fireEvent.click(await screen.findByText(/Copy All Prompt/));

      await waitFor(() => {
        expect(mockGenerateAllCommentsPrompt).toHaveBeenCalledWith({
          requestedBaseCommitish: 'main',
          requestedTargetCommitish: 'feature/docs-update',
          baseMode: 'merge-base',
          resolvedBaseCommitish: 'abcdef1',
          resolvedTargetCommitish: '1234567',
        });
      });
    });
  });

  describe('Cleanup All Prompt Button', () => {
    it('should not show delete button when no comments exist', async () => {
      mockComments = [];

      renderApp();

      await waitFor(() => {
        expect(screen.queryByText('Copy All Prompt')).not.toBeInTheDocument();
        expect(screen.queryByText('Cleanup All Prompt')).not.toBeInTheDocument();
      });
    });

    it('should show delete button when comments exist', async () => {
      mockComments = [
        createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
      ];

      renderApp();

      await waitFor(() => {
        const dropdownToggle = screen.getByTitle('More options');
        fireEvent.click(dropdownToggle);
      });

      await waitFor(() => {
        expect(screen.getByText('Cleanup All Prompt')).toBeInTheDocument();
      });
    });

    it('should call clearAllComments immediately when delete button is clicked', async () => {
      mockComments = [
        createMockThread({ id: '1', filePath: 'test.ts', line: 10, body: 'Comment 1' }),
        createMockThread({ id: '2', filePath: 'test.ts', line: 20, body: 'Comment 2' }),
      ];

      renderApp();

      await waitFor(() => {
        const dropdownToggle = screen.getByTitle('More options');
        fireEvent.click(dropdownToggle);
      });

      await waitFor(() => {
        const deleteButton = screen.getByText('Cleanup All Prompt');
        fireEvent.click(deleteButton);
      });

      expect(mockClearAllComments).toHaveBeenCalled();
    });
  });

  describe('Clean flag on Startup', () => {
    it('should clear existing comments when clearComments flag is true in response', async () => {
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).toHaveBeenCalled();
      });
    });

    it('should clear viewed files when clearComments flag is true in response', async () => {
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearViewedFiles).toHaveBeenCalled();
      });
    });

    it('should not clear comments when clearComments flag is false', async () => {
      const responseWithoutClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: false,
      };

      mockFetch(responseWithoutClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).not.toHaveBeenCalled();
      });
    });

    it('should not clear comments when clearComments flag is undefined', async () => {
      const responseWithoutFlag: DiffResponse = {
        ...mockDiffResponse,
      };

      mockFetch(responseWithoutFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).not.toHaveBeenCalled();
      });
    });

    it('should log message when clearing comments via CLI flag', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith(
          '✅ All existing comments and viewed files cleared as requested via --clean flag',
        );
      });

      consoleLogSpy.mockRestore();
    });

    it('hydrates comments from the server comment session on startup', async () => {
      const serverThreads = [
        createMockThread({
          id: 'imported-thread',
          filePath: 'test.ts',
          line: 10,
          body: 'Imported comment',
        }),
      ];

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: serverThreads }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => mockDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        expect(mockReplaceThreads).toHaveBeenCalledWith(serverThreads);
      });

      expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
        '/api/comments-json?base=HEAD%5E&target=HEAD',
      );
    });

    it('preserves server-provided comments after clearing local comments on startup', async () => {
      mockComments = [
        createMockThread({
          id: 'stale-local-thread',
          filePath: 'test.ts',
          line: 5,
          body: 'Stale local comment',
        }),
      ];
      const serverThreads = [
        createMockThread({
          id: 'imported-thread',
          filePath: 'test.ts',
          line: 10,
          body: 'Imported comment',
        }),
      ];
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: serverThreads }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => responseWithClearFlag,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(mockReplaceThreads).toHaveBeenCalledWith(serverThreads);
      });

      expect(mockReplaceThreads).not.toHaveBeenCalledWith([...serverThreads, ...mockComments]);
    });
  });
});

describe('App Component - Initial file collapsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
    mockViewedFiles = new Set<string>();
    mockHasLoadedInitialViewedFiles = false;
  });

  it('collapses initially viewed files after viewed state finishes loading', async () => {
    const view = renderApp();

    await waitFor(() => {
      expect(screen.getByTitle('Collapse file (Alt+Click to collapse all)')).toBeInTheDocument();
    });

    expect(screen.getByTitle('Collapse file (Alt+Click to collapse all)')).toBeInTheDocument();

    act(() => {
      mockViewedFiles = new Set(['test.ts']);
      mockHasLoadedInitialViewedFiles = true;
      view.rerender(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTitle('Expand file (Alt+Click to expand all)')).toBeInTheDocument();
    });
  });
});

describe('App Component - Comment sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  it('syncs an empty comment list after the last comment is resolved', async () => {
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
    ];

    const mockGlobalFetch = vi.mocked(global.fetch);
    const { rerender } = renderApp();

    await waitFor(() => {
      const commentCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/comments?'),
      );
      expect(commentCalls).toHaveLength(1);

      const [url, request] = commentCalls[0] as [string, RequestInit];
      expect(url).toBe('/api/comments?base=HEAD%5E&target=HEAD');
      expect(request.method).toBe('POST');
      expect(JSON.parse(String(request.body))).toEqual({
        threads: [
          expect.objectContaining({
            id: 'test-1',
            filePath: 'test.ts',
            position: { side: 'new', line: 10 },
            messages: [
              expect.objectContaining({
                id: 'test-1',
                body: 'Test comment',
                author: 'User',
              }),
            ],
          }),
        ],
      });
    });

    mockComments = [];
    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );

    await waitFor(() => {
      const commentCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/comments?'),
      );
      expect(commentCalls).toHaveLength(2);

      const [url, request] = commentCalls[1] as [string, RequestInit];
      expect(url).toBe('/api/comments?base=HEAD%5E&target=HEAD');
      expect(request.method).toBe('POST');
      expect(JSON.parse(String(request.body))).toEqual({ threads: [] });
    });
  });

  it('sends an empty comment list on unload when no comments remain', async () => {
    mockComments = [];
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    renderApp();

    await waitFor(() => {
      expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    });

    const beforeUnloadHandler = addEventListenerSpy.mock.calls.find(
      ([eventName]) => eventName === 'beforeunload',
    )?.[1] as (() => void) | undefined;
    expect(beforeUnloadHandler).toBeDefined();
    beforeUnloadHandler?.();

    expect(navigator.sendBeacon).toHaveBeenCalledWith(
      '/api/comments?base=HEAD%5E&target=HEAD',
      JSON.stringify({ threads: [] }),
    );
    addEventListenerSpy.mockRestore();
  });

  it('shows author badges in the comments modal when the diff has multiple authors', async () => {
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'User comment' }),
      createMockThread({
        id: 'test-2',
        filePath: 'other.ts',
        line: 20,
        body: 'Reviewer comment',
        author: 'Reviewer',
      }),
    ];
    mockFetch({
      ...mockDiffResponse,
      files: [
        ...mockDiffResponse.files,
        {
          path: 'other.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          chunks: [],
        },
      ],
    });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('User')).toBeInTheDocument();
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });
});

describe('App Component - Per-File View Modes', () => {
  const firstFile: DiffFile = {
    path: 'test.ts',
    status: 'modified',
    additions: 5,
    deletions: 2,
    chunks: [],
  };

  const twoFileDiffResponse: DiffResponse = {
    ...mockDiffResponse,
    files: [
      firstFile,
      {
        path: 'docs/guide.md',
        status: 'modified',
        additions: 1,
        deletions: 1,
        chunks: [],
      },
    ],
  };

  const stubFetch = (diffResponse: DiffResponse = twoFileDiffResponse) => {
    const mockGlobalFetch = vi.mocked(global.fetch);
    mockGlobalFetch.mockImplementation(((url: RequestInfo | URL) => {
      const urlString = String(url);
      if (urlString.includes('/api/blob/')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('# Guide') });
      }
      if (urlString.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ specialOptions: [], branches: [], commits: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(diffResponse) });
    }) as unknown as typeof fetch);
  };

  const findFileSection = async (container: HTMLElement, filePath: string) => {
    return await waitFor(() => {
      const section = container.querySelector(`[data-file-path="${filePath}"]`);
      expect(section).not.toBeNull();
      return section as HTMLElement;
    });
  };

  const getTabLabels = (section: HTMLElement) => {
    const tabs = within(section).getByRole('group', { name: 'File view mode' });
    return within(tabs)
      .getAllByRole('button')
      .map((button) => button.textContent);
  };

  it('defaults every file to unified, listed first', async () => {
    stubFetch();
    const { container } = renderApp();

    const tsSection = await findFileSection(container, 'test.ts');

    expect(getTabLabels(tsSection)).toEqual(['Unified', 'Split', 'Full']);
    expect(within(tsSection).getByRole('button', { name: 'Unified' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('offers the preview modes only for markdown files', async () => {
    stubFetch();
    const { container } = renderApp();

    const tsSection = await findFileSection(container, 'test.ts');
    const mdSection = await findFileSection(container, 'docs/guide.md');

    expect(getTabLabels(tsSection)).toEqual(['Unified', 'Split', 'Full']);
    expect(getTabLabels(mdSection)).toEqual([
      'Unified',
      'Split',
      'Full',
      'Diff Preview',
      'Full Preview',
    ]);
  });

  it('switches one file without touching the others and persists the selection', async () => {
    stubFetch();
    const { container } = renderApp();

    const tsSection = await findFileSection(container, 'test.ts');
    fireEvent.click(within(tsSection).getByRole('button', { name: 'Split' }));

    const mdSection = await findFileSection(container, 'docs/guide.md');
    expect(within(tsSection).getByRole('button', { name: 'Split' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(mdSection).getByRole('button', { name: 'Unified' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    expect(JSON.parse(window.localStorage.getItem(FILE_VIEW_MODES_KEY) ?? '{}')).toEqual({
      'test.ts': 'split',
    });
  });

  it('initializes selections from localStorage', async () => {
    window.localStorage.setItem(FILE_VIEW_MODES_KEY, JSON.stringify({ 'test.ts': 'full' }));
    stubFetch();
    const { container } = renderApp();

    const tsSection = await findFileSection(container, 'test.ts');

    expect(within(tsSection).getByRole('button', { name: 'Full' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('resets every file to split via the Reset button', async () => {
    window.localStorage.setItem(
      FILE_VIEW_MODES_KEY,
      JSON.stringify({ 'test.ts': 'full', 'docs/guide.md': 'diff-preview' }),
    );
    stubFetch();
    const { container } = renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));

    const tsSection = await findFileSection(container, 'test.ts');
    const mdSection = await findFileSection(container, 'docs/guide.md');
    expect(within(tsSection).getByRole('button', { name: 'Split' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(mdSection).getByRole('button', { name: 'Split' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    expect(JSON.parse(window.localStorage.getItem(FILE_VIEW_MODES_KEY) ?? '{}')).toEqual({
      'test.ts': 'split',
      'docs/guide.md': 'split',
    });
  });

  it('keeps per-file selections after triggering refresh', async () => {
    const mockGlobalFetch = vi.mocked(global.fetch);
    mockGlobalFetch.mockClear();
    stubFetch();
    const { container } = renderApp();

    const tsSection = await findFileSection(container, 'test.ts');
    fireEvent.click(within(tsSection).getByRole('button', { name: 'Split' }));

    act(() => {
      bridgeEventListener?.({ type: 'reload' });
    });

    const refreshButton = await screen.findByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      const diffCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/diff?'),
      );
      expect(diffCalls).toHaveLength(2);
    });

    expect(JSON.parse(window.localStorage.getItem(FILE_VIEW_MODES_KEY) ?? '{}')).toEqual({
      'test.ts': 'split',
    });
  });
});

describe('App Component - Merge-base selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('clears the resolved base revision after switching to a merge-base quick diff', async () => {
    const initialDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '88aabb0',
      targetCommitish: '.',
      requestedBaseCommitish: 'HEAD',
      requestedTargetCommitish: '.',
    };
    const mergeBaseDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1122334',
      targetCommitish: '.',
      requestedBaseCommitish: 'origin/main',
      requestedTargetCommitish: '.',
      requestedBaseMode: 'merge-base',
    };
    const revisionsResponse = {
      specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
      branches: [],
      commits: [
        {
          hash: '88aabb0fffff1111222233334444555566667777',
          shortHash: '88aabb0',
          message: 'stale direct base',
        },
        {
          hash: '1122334fffff1111222233334444555566667777',
          shortHash: '1122334',
          message: 'merge base',
        },
      ],
      originDefaultBranch: 'origin/main',
    };

    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);

      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => revisionsResponse,
        } as Response);
      }

      if (url.includes('/api/diff')) {
        const response =
          url.includes('base=origin%2Fmain') && url.includes('baseMode=merge-base')
            ? mergeBaseDiffResponse
            : initialDiffResponse;

        return Promise.resolve({
          ok: true,
          json: async () => response,
          blob: async () => ({ size: 1024 }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'origin/main...Uncommitted (merge-base)' }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', {
        name: 'Revision menu: 88aabb0...Uncommitted Changes (merge-base)',
      }),
    ).not.toBeInTheDocument();
  });

  it('uses resolved revisions for persisted diff state identity', async () => {
    const response: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1234567',
      targetCommitish: '98664e1',
      requestedBaseCommitish: '98664e1^',
      requestedTargetCommitish: '98664e1',
    };

    mockFetch(response);

    renderApp();

    await waitFor(() => {
      expect(vi.mocked(useDiffComments)).toHaveBeenCalledWith(
        '1234567',
        '98664e1',
        'abc123',
        undefined,
        undefined,
        undefined,
      );
    });

    expect(vi.mocked(useViewedFiles)).toHaveBeenCalledWith(
      '1234567',
      '98664e1',
      'abc123',
      undefined,
      response.files,
      undefined,
      [],
      undefined,
    );
  });

  it('ignores stale resolvedBase from /api/revisions on initial merge-base load', async () => {
    const mergeBaseDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1122334',
      targetCommitish: '.',
      requestedBaseCommitish: 'origin/main',
      requestedTargetCommitish: '.',
      requestedBaseMode: 'merge-base',
    };
    const revisionsResponse = {
      specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
      branches: [],
      commits: [
        {
          hash: '88aabb0fffff1111222233334444555566667777',
          shortHash: '88aabb0',
          message: 'stale direct base',
        },
      ],
      originDefaultBranch: 'origin/main',
      resolvedBase: '88aabb0',
      resolvedTarget: '1122334',
    };

    let resolveRevisions: (() => void) | null = null;

    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);

      if (url.includes('/api/revisions')) {
        return new Promise<Response>((resolve) => {
          resolveRevisions = () =>
            resolve({
              ok: true,
              json: async () => revisionsResponse,
            } as Response);
        });
      }

      if (url.includes('/api/diff')) {
        return Promise.resolve({
          ok: true,
          json: async () => mergeBaseDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Reviewing:')).toBeInTheDocument();
    });

    await act(async () => {
      resolveRevisions?.();
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', {
        name: 'Revision menu: 88aabb0...Uncommitted Changes (merge-base)',
      }),
    ).not.toBeInTheDocument();
  });
});

describe('App Component - Revision-aware refetching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('keeps the selected revisions when refetching without explicit revision params', async () => {
    const diffResponse: DiffResponse = {
      ...mockDiffResponse,
      requestedBaseCommitish: 'HEAD^',
      requestedTargetCommitish: 'HEAD',
    };

    vi.mocked(global.fetch).mockImplementation((input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            specialOptions: [],
            branches: [],
            commits: [
              {
                hash: 'abc1234',
                shortHash: 'abc1234',
                message: 'Test commit',
              },
            ],
          }),
        } as Response);
      }

      if (url.startsWith('/api/comments?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => diffResponse,
        blob: async () => ({ size: 1024 }),
      } as Response);
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Previous commit' }));

    await waitFor(() => {
      const diffCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => typeof url === 'string' && url.startsWith('/api/diff'));
      expect(diffCalls).toHaveLength(2);
      expect(String(diffCalls[1]?.[0])).toContain('base=HEAD%5E%5E');
      expect(String(diffCalls[1]?.[0])).toContain('target=HEAD%5E');
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ignore Whitespace' }));

    await waitFor(() => {
      const diffCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => typeof url === 'string' && url.startsWith('/api/diff'));
      expect(diffCalls).toHaveLength(3);
      expect(String(diffCalls[2]?.[0])).toContain('base=HEAD%5E%5E');
      expect(String(diffCalls[2]?.[0])).toContain('target=HEAD%5E');
    });
  });
});

describe('App Component - Sidebar persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
    mockFetch(mockDiffResponse);
  });

  it('restores file tree open state from localStorage', async () => {
    window.localStorage.setItem('diffops.sidebarOpen', 'false');

    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('persists file tree open state when toggled', async () => {
    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(window.localStorage.getItem('diffops.sidebarOpen')).toBe('false');
    });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(window.localStorage.getItem('diffops.sidebarOpen')).toBe('true');
    });
  });
});

describe('App Component - Diff fetch failures', () => {
  const diffErrorResponse = (status: number, body: string) =>
    ({
      ok: false,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    }) as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/diff?')) {
        return Promise.resolve(
          diffErrorResponse(
            500,
            JSON.stringify({
              error: 'Failed to compute diff for d76d6b9 vs HEAD^: revspec not found',
            }),
          ),
        );
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });
  });

  it('shows the endpoint error detail instead of a generic fetch failure', async () => {
    renderApp();

    await screen.findByText('Error');
    expect(
      screen.getByText('Failed to compute diff for d76d6b9 vs HEAD^: revspec not found'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch diff data')).not.toBeInTheDocument();
  });

  it('logs the failed request with its status and body for diagnosis', async () => {
    renderApp();

    await screen.findByText('Error');
    const logged = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .find((line) => line.includes('/api/diff failed'));
    expect(logged).toContain('status 500');
    expect(logged).toContain('Failed to compute diff for d76d6b9 vs HEAD^');
  });

  it('falls back to the HTTP status when the body has no error field', async () => {
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/diff?')) {
        return Promise.resolve(diffErrorResponse(503, JSON.stringify({ unexpected: true })));
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    await screen.findByText('Error');
    expect(
      screen.getByText('Failed to fetch diff data (HTTP 503): {"unexpected":true}'),
    ).toBeInTheDocument();
  });
});

describe('App Component - Mobile sidebar auto-close', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });
  });

  afterEach(() => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
  });

  it('closes the sidebar when a file is selected on mobile', async () => {
    mockFetch(mockDiffResponse);
    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');

    const fileRow = await screen.findByTitle('test.ts');
    fireEvent.click(fileRow.closest('[data-file-row]')!);

    await waitFor(() => {
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    });
  });
});

describe('App Component - Narrated review', () => {
  const createChunk = (
    oldText: string,
    newText: string,
  ): DiffResponse['files'][number]['chunks'][number] => ({
    header: '@@ -1 +1 @@',
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [
      { type: 'delete', content: oldText, oldLineNumber: 1 },
      { type: 'add', content: newText, newLineNumber: 1 },
    ],
  });

  const createNarrationFiles = (): DiffResponse['files'] =>
    ['a.ts', 'b.ts', 'c.ts'].map((path) => ({
      path,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      chunks: [createChunk(`old ${path}`, `new ${path}`)],
    }));

  const createNarrationDiff = (): DiffResponse => ({
    ...mockDiffResponse,
    commit: 'abc123',
    baseCommitish: 'HEAD^',
    targetCommitish: 'HEAD',
    requestedBaseCommitish: 'HEAD^',
    requestedTargetCommitish: 'HEAD',
    files: createNarrationFiles(),
  });

  const narrationPayload = {
    intro: 'Renames the version constant and updates the docs.',
    cards: [
      { path: 'c.ts', narrative: 'Config first. Then read a.ts.' },
      { path: 'a.ts', narrative: 'The consumer of c.ts.' },
      { path: 'b.ts', narrative: 'Docs polish, keep it last.' },
    ],
    epilogue: 'Check the version bump stays consistent.',
  };

  interface NarrationSessionOptions {
    hasApiKey?: boolean;
    diff?: DiffResponse;
    narration?: typeof narrationPayload;
    storedNarration?: { narration: typeof narrationPayload; fingerprint: string } | null;
    narrateHandler?: () => Promise<Narration>;
  }

  const programNarrationFetch = (options: NarrationSessionOptions = {}) => {
    if (options.hasApiKey ?? true) {
      enableAiSettings();
    }
    generateNarration.mockImplementation(
      options.narrateHandler ??
        (() => Promise.resolve((options.narration ?? narrationPayload) as Narration)),
    );
    vi.mocked(global.fetch).mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ specialOptions: [], branches: [], commits: [] }),
        } as Response);
      }
      if (url.includes('/api/narration') && (init?.method === 'PUT' || init?.method === 'POST')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) } as Response);
      }
      if (url.includes('/api/narration')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ narration: options.storedNarration ?? null }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => options.diff ?? createNarrationDiff(),
      } as Response);
    }) as unknown as typeof fetch);
  };

  const getToggle = () => screen.getByRole('switch', { name: 'Toggle narrated view' });

  const getDocumentFilePaths = () =>
    Array.from(document.querySelectorAll('main [data-file-path]')).map(
      (element) => (element as HTMLElement).dataset.filePath,
    );

  const getSidebarFilePaths = () =>
    Array.from(document.querySelectorAll('#file-tree-panel [data-file-row="true"]')).map((row) => {
      const titledSpans = row.querySelectorAll('span[title]');
      return titledSpans[titledSpans.length - 1]?.getAttribute('title');
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('generates on toggle, reorders the document, and interleaves the cards', async () => {
    programNarrationFetch();
    renderApp();

    await screen.findByText('Files changed (3)');
    fireEvent.click(getToggle());

    await waitFor(() => {
      expect(screen.getAllByText('Narration — what this changeset does')).toHaveLength(1);
    });
    expect(getDocumentFilePaths()).toEqual(['c.ts', 'a.ts', 'b.ts']);
    expect(getSidebarFilePaths()).toEqual(['c.ts', 'a.ts', 'b.ts']);

    const cards = document.querySelectorAll('main [data-narration-card="true"]');
    expect(cards).toHaveLength(5);

    const intro = screen.getByText('Narration — what this changeset does').closest('section');
    const firstFile = document.querySelector('main [data-file-path]');
    expect(
      intro && firstFile
        ? intro.compareDocumentPosition(firstFile) & Node.DOCUMENT_POSITION_FOLLOWING
        : false,
    ).toBeTruthy();

    expect(screen.getByText('Check the version bump stays consistent.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate narration' })).toBeInTheDocument();
  });

  it('renders the narrated sections above the target when jumping files with the keyboard', async () => {
    // Git order f0..f9; the narrated order swaps the last two so f9 precedes f8 in the document while sitting beyond the initial render window.
    const files = Array.from({ length: 10 }, (_, index) => ({
      path: `f${index}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      chunks: [createChunk(`old ${index}`, `new ${index}`)],
    }));
    const cards = [
      ...Array.from({ length: 8 }, (_, index) => ({
        path: `f${index}.ts`,
        narrative: `File ${index} narrative.`,
      })),
      { path: 'f9.ts', narrative: 'Rendered before the last file.' },
      { path: 'f8.ts', narrative: 'The last narrated file.' },
    ];
    programNarrationFetch({
      diff: { ...createNarrationDiff(), files },
      narration: { intro: 'Intro.', cards, epilogue: 'Epilogue.' },
    });
    renderApp();

    await screen.findByText('Files changed (10)');
    fireEvent.click(getToggle());

    await waitFor(() => {
      expect(getDocumentFilePaths()).toEqual([
        'f0.ts',
        'f1.ts',
        'f2.ts',
        'f3.ts',
        'f4.ts',
        'f5.ts',
        'f6.ts',
        'f7.ts',
        'f9.ts',
        'f8.ts',
      ]);
    });
    expect(screen.getAllByText('Deferred Rendering')).toHaveLength(2);

    // happy-dom reports Shift+BracketRight as key "]", so the browser-accurate "}" key is dispatched directly.
    fireEvent.keyDown(document, { key: '}', code: 'BracketRight', shiftKey: true });

    await waitFor(() => {
      expect(screen.queryAllByText('Deferred Rendering')).toHaveLength(0);
    });
  });

  it('keeps git order and shows a spinner while generating', async () => {
    let resolveNarrate: ((value: unknown) => void) | null = null;
    const deferred = new Promise((resolve) => {
      resolveNarrate = resolve;
    });
    programNarrationFetch({
      narrateHandler: () => deferred.then(() => narrationPayload as Narration),
    });
    renderApp();

    await screen.findByText('Files changed (3)');
    fireEvent.click(getToggle());

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(getDocumentFilePaths()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(screen.queryByText('Narration — what this changeset does')).not.toBeInTheDocument();

    await act(async () => {
      resolveNarrate?.(undefined);
    });

    await waitFor(() => {
      expect(getDocumentFilePaths()).toEqual(['c.ts', 'a.ts', 'b.ts']);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('caches the narration and toggles back to git order without regenerating', async () => {
    programNarrationFetch();
    renderApp();

    await screen.findByText('Files changed (3)');
    fireEvent.click(getToggle());
    await waitFor(() => {
      expect(getDocumentFilePaths()).toEqual(['c.ts', 'a.ts', 'b.ts']);
    });

    const narrateCalls = () => generateNarration.mock.calls.length;
    expect(narrateCalls()).toBe(1);

    fireEvent.click(getToggle());
    await waitFor(() => {
      expect(getDocumentFilePaths()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });
    expect(screen.queryByText('Narration — what this changeset does')).not.toBeInTheDocument();

    fireEvent.click(getToggle());
    await waitFor(() => {
      expect(getDocumentFilePaths()).toEqual(['c.ts', 'a.ts', 'b.ts']);
    });
    expect(narrateCalls()).toBe(1);
  });

  it('applies a matching cached narration instantly and rejects a stale one', async () => {
    const diff = createNarrationDiff();
    const fingerprint = buildChangesetFingerprint(diff.commit, diff.files);
    programNarrationFetch({
      diff,
      storedNarration: { narration: narrationPayload, fingerprint },
    });
    renderApp();

    await screen.findByText('Files changed (3)');
    fireEvent.click(getToggle());

    await waitFor(() => {
      expect(getDocumentFilePaths()).toEqual(['c.ts', 'a.ts', 'b.ts']);
    });
    expect(generateNarration.mock.calls).toHaveLength(0);
  });

  it('regenerates a stale cached narration instead of applying it', async () => {
    programNarrationFetch({
      storedNarration: { narration: narrationPayload, fingerprint: 'outdated-fingerprint' },
    });
    renderApp();

    await screen.findByText('Files changed (3)');
    fireEvent.click(getToggle());

    await waitFor(() => {
      expect(getDocumentFilePaths()).toEqual(['c.ts', 'a.ts', 'b.ts']);
    });
    expect(generateNarration.mock.calls).toHaveLength(1);
  });

  it('navigates cross-reference links to the referenced file card', async () => {
    programNarrationFetch();
    renderApp();

    await screen.findByText('Files changed (3)');
    fireEvent.click(getToggle());
    const link = await screen.findByRole('link', { name: 'a.ts' });
    expect(link).toHaveAttribute('href', '#narrate:a.ts');

    const main = document.querySelector('main') as HTMLElement;
    const scrollToSpy = vi.spyOn(main, 'scrollTo');

    fireEvent.click(link);

    await waitFor(() => {
      const selectedRow = document.querySelector(
        '#file-tree-panel [data-file-row].bg-github-bg-tertiary',
      );
      expect(selectedRow?.querySelector('span[title]')?.getAttribute('title')).toBe('a.ts');
    });
    await waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalled();
    });
  });

  it('surfaces the generation error with a retry on the toggle', async () => {
    let shouldFail = true;
    programNarrationFetch({
      narrateHandler: () =>
        shouldFail
          ? Promise.reject(new Error('Narration request failed (502)'))
          : Promise.resolve(narrationPayload as Narration),
    });
    renderApp();

    await screen.findByText('Files changed (3)');
    fireEvent.click(getToggle());

    expect(await screen.findByText('Narration request failed (502)')).toBeInTheDocument();
    expect(getDocumentFilePaths()).toEqual(['a.ts', 'b.ts', 'c.ts']);

    shouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry narration' }));

    await waitFor(() => {
      expect(getDocumentFilePaths()).toEqual(['c.ts', 'a.ts', 'b.ts']);
    });
  });

  it('disables the toggle pointing at Settings when no API key is configured', async () => {
    programNarrationFetch({ hasApiKey: false });
    renderApp();

    const toggle = await screen.findByRole('switch', { name: 'Toggle narrated view' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute(
      'title',
      'Add an AI Gateway API key in Settings to enable narration',
    );
  });

  it('disables the toggle with a size refusal when the changeset exceeds the narrate cap', async () => {
    // The large file sits past the initial render window so the test never renders its lines; only its prompt size matters.
    const smallFiles = Array.from({ length: 8 }, (_, index) => ({
      path: `f${index}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      chunks: [createChunk(`old ${index}`, `new ${index}`)],
    }));
    const largeFile: DiffResponse['files'][number] = {
      path: 'big.ts',
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      chunks: [
        {
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { type: 'delete', content: 'x'.repeat(600 * 1024), oldLineNumber: 1 },
            { type: 'add', content: 'y'.repeat(600 * 1024), newLineNumber: 1 },
          ],
        },
      ],
    };
    programNarrationFetch({
      diff: { ...createNarrationDiff(), files: [...smallFiles, largeFile] },
    });
    renderApp();

    const toggle = await screen.findByRole('switch', { name: 'Toggle narrated view' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('title', 'Changeset too large to narrate');
  });
});
