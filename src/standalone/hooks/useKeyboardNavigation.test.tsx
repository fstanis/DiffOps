import { renderHook, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';

import type { DiffFile } from '../../types/diff';

import { useKeyboardNavigation } from './useKeyboardNavigation';

Element.prototype.scrollIntoView = vi.fn();
const mockGetElementById = vi.spyOn(document, 'getElementById');
const mockQuerySelector = vi.spyOn(document, 'querySelector');

Object.defineProperty(window, 'innerHeight', {
  writable: true,
  configurable: true,
  value: 768,
});

Object.defineProperty(window, 'pageYOffset', {
  writable: true,
  configurable: true,
  value: 0,
});

window.scrollTo = vi.fn();

const createMockElement = () => ({
  scrollIntoView: vi.fn(),
  getBoundingClientRect: vi.fn(() => ({
    top: 100,
    bottom: 200,
    left: 0,
    right: 100,
    width: 100,
    height: 100,
  })),
  offsetTop: 150,
});

const createMockScrollContainer = () => ({
  getBoundingClientRect: vi.fn(() => ({
    top: 0,
    bottom: 768,
    left: 0,
    right: 1024,
    width: 1024,
    height: 768,
  })),
  scrollTop: 0,
  scrollHeight: 2000,
  clientHeight: 768,
});

const mockFiles: DiffFile[] = [
  {
    path: 'file1.js',
    status: 'modified',
    additions: 1,
    deletions: 1,
    chunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [
          { type: 'delete', oldLineNumber: 1, content: '- old line' },
          { type: 'add', newLineNumber: 1, content: '+ new line' },
          {
            type: 'normal',
            oldLineNumber: 2,
            newLineNumber: 2,
            content: '  unchanged',
          },
          {
            type: 'normal',
            oldLineNumber: 3,
            newLineNumber: 3,
            content: '  another unchanged',
          },
        ],
        header: '@@ -1,3 +1,4 @@',
      },
    ],
  },
  {
    path: 'file2.js',
    status: 'modified',
    additions: 1,
    deletions: 0,
    chunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          {
            type: 'normal',
            oldLineNumber: 1,
            newLineNumber: 1,
            content: '  first line',
          },
          { type: 'add', newLineNumber: 2, content: '+ added line' },
        ],
        header: '@@ -1,2 +1,2 @@',
      },
    ],
  },
];

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <HotkeysProvider initiallyActiveScopes={['navigation']}>{children}</HotkeysProvider>
);

describe('useKeyboardNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetElementById.mockImplementation(() => createMockElement() as any);
    mockQuerySelector.mockImplementation(() => createMockScrollContainer() as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Line Navigation (j/k)', () => {
    it('should navigate to next line with j key', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('j');

      expect(result.current.cursor).toEqual({
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 0,
        side: 'left',
      });
    });

    it('should navigate to next line with down arrow', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('{ArrowDown}');

      expect(result.current.cursor).toEqual({
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 0,
        side: 'left',
      });
    });

    it('should navigate to previous line with k key', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 2,
          side: 'right',
        });
      });

      await user.keyboard('k');

      expect(result.current.cursor).toEqual({
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 1,
        side: 'right',
      });
    });
  });

  describe('File Navigation (]/[)', () => {
    it('should navigate to next file with ] key', async () => {
      const user = userEvent.setup();
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('{\\]}');

      expect(result.current.cursor).not.toBeNull();
      // From a null cursor, ] may land on fileIndex 0 or 1 depending on the filter.
      expect(result.current.cursor?.fileIndex).toBeGreaterThanOrEqual(0);
      expect(result.current.cursor?.fileIndex).toBeLessThan(mockFiles.length);
    });

    it('should navigate to previous file with [ key', async () => {
      const user = userEvent.setup();
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 1,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'right',
        });
      });

      await user.keyboard('{\\[}');

      expect(result.current.cursor?.fileIndex).toBe(0);
    });

    it('should jump to first file with Shift+[ key', async () => {
      const user = userEvent.setup();
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 1,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'right',
        });
      });

      await user.keyboard('[ShiftLeft>][BracketLeft][/ShiftLeft]');

      expect(result.current.cursor?.fileIndex).toBe(0);
      expect(result.current.cursor?.chunkIndex).toBe(0);
      expect(result.current.cursor?.lineIndex).toBe(0);
    });

    it('should jump to last file with Shift+] key', async () => {
      const user = userEvent.setup();
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'right',
        });
      });

      await user.keyboard('[ShiftLeft>][BracketRight][/ShiftLeft]');

      expect(result.current.cursor?.fileIndex).toBe(mockFiles.length - 1);
      expect(result.current.cursor?.chunkIndex).toBe(0);
      expect(result.current.cursor?.lineIndex).toBe(0);
    });
  });

  describe('Narrated order', () => {
    // Narrated view reorders the files array; the cursor follows that array, not git order.
    const narratedFiles = [mockFiles[1]!, mockFiles[0]!];

    it('steps next/prev file through the narrated order', async () => {
      const user = userEvent.setup();
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: narratedFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'right',
        });
      });

      await user.keyboard('{\\]}');
      expect(result.current.cursor?.fileIndex).toBe(1);

      await user.keyboard('{\\[}');
      expect(result.current.cursor?.fileIndex).toBe(0);
    });

    it('advances reviewed-file auto-advance through the narrated order', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: narratedFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set([narratedFiles[0]!.path]),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'right',
        });
      });

      await user.keyboard('[ShiftLeft>]v[/ShiftLeft]');

      expect(onToggleReviewed).not.toHaveBeenCalled();
      expect(result.current.cursor?.fileIndex).toBe(1);
    });
  });

  describe('File scroll anchoring', () => {
    const renderNavigation = (
      onScrollToFile: (filePath: string) => void,
      reviewedFiles = new Set<string>(),
    ) =>
      renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles,
            onScrollToFile,
          }),
        { wrapper },
      );

    it('anchors file steps through onScrollToFile', async () => {
      const user = userEvent.setup();
      const onScrollToFile = vi.fn();
      const { result } = renderNavigation(onScrollToFile);

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'right',
        });
      });

      await user.keyboard('{\\]}');
      expect(result.current.cursor?.fileIndex).toBe(1);
      expect(onScrollToFile).toHaveBeenCalledWith(mockFiles[1]!.path);

      await user.keyboard('{\\[}');
      expect(result.current.cursor?.fileIndex).toBe(0);
      expect(onScrollToFile).toHaveBeenCalledWith(mockFiles[0]!.path);
    });

    it('anchors jump-to-first/last through onScrollToFile', () => {
      const onScrollToFile = vi.fn();
      renderNavigation(onScrollToFile);

      // userEvent on happy-dom reports Shift+BracketLeft as key "[", so the
      // browser-accurate key is dispatched directly for the brace hotkeys.
      fireEvent.keyDown(document, { key: '{', code: 'BracketLeft', shiftKey: true });
      expect(onScrollToFile).toHaveBeenCalledWith(mockFiles[0]!.path);

      fireEvent.keyDown(document, { key: '}', code: 'BracketRight', shiftKey: true });
      expect(onScrollToFile).toHaveBeenCalledWith(mockFiles[mockFiles.length - 1]!.path);
    });

    it('anchors shift+v auto-advance through onScrollToFile', async () => {
      const user = userEvent.setup();
      const onScrollToFile = vi.fn();
      const { result } = renderNavigation(onScrollToFile, new Set([mockFiles[0]!.path]));

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'right',
        });
      });

      await user.keyboard('[ShiftLeft>]v[/ShiftLeft]');

      expect(result.current.cursor?.fileIndex).toBe(1);
      expect(onScrollToFile).toHaveBeenCalledWith(mockFiles[1]!.path);
    });
  });

  describe('Chunk Navigation (n/p)', () => {
    it('should navigate to next chunk with n key', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('n');

      expect(result.current.cursor).not.toBeNull();
    });

    it('should navigate to previous chunk with p key', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('n');
      await user.keyboard('n');
      await user.keyboard('p');

      expect(result.current.cursor).not.toBeNull();
    });
  });

  describe('Current View Mode', () => {
    it('should skip deleted lines when navigating with j', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'full',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('j');

      // file1's first line is a deletion, which has no row in current mode, so this lands on the added line.
      expect(result.current.cursor).toEqual({
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 1,
        side: 'right',
      });
    });

    it('should jump changed regions with n and land on visible lines', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'full',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('n');

      // The add line following the deleted line is the first visible change.
      expect(result.current.cursor).toEqual({
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 1,
        side: 'right',
      });

      await user.keyboard('n');

      // Next changed region is the added line in file2.
      expect(result.current.cursor).toEqual({
        fileIndex: 1,
        chunkIndex: 0,
        lineIndex: 1,
        side: 'right',
      });
    });
  });

  describe('Comment Navigation (N/P)', () => {
    it('should navigate to next comment with Shift+N', async () => {
      const user = userEvent.setup();
      const comments = [
        {
          id: '1',
          file: 'file1.js',
          line: 2,
          body: 'Comment 1',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: '2',
          file: 'file2.js',
          line: 1,
          body: 'Comment 2',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ];

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments,
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('{Shift>}n{/Shift}');

      expect(result.current.cursor).not.toBeNull();
    });

    it('should navigate to old-side and new-side comments on the same line separately', async () => {
      const user = userEvent.setup();
      const comments = [
        { file: 'file1.js', line: 1, side: 'old' as const },
        { file: 'file1.js', line: 1, side: 'new' as const },
      ];

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments,
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('{Shift>}n{/Shift}');
      expect(result.current.cursor).toEqual({
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 0,
        side: 'left',
      });

      await user.keyboard('{Shift>}n{/Shift}');
      expect(result.current.cursor).toEqual({
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 1,
        side: 'right',
      });
    });

    it('should navigate to previous comment with Shift+P', async () => {
      const user = userEvent.setup();
      const comments = [
        {
          id: '1',
          file: 'file1.js',
          line: 2,
          body: 'Comment 1',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: '2',
          file: 'file2.js',
          line: 1,
          body: 'Comment 2',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ];

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments,
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('{Shift>}n{/Shift}');
      await user.keyboard('{Shift>}n{/Shift}');
      await user.keyboard('{Shift>}p{/Shift}');

      expect(result.current.cursor).not.toBeNull();
    });

    it('should navigate back to the old-side comment with Shift+P', async () => {
      const user = userEvent.setup();
      const comments = [
        { file: 'file1.js', line: 1, side: 'old' as const },
        { file: 'file1.js', line: 1, side: 'new' as const },
      ];

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments,
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('{Shift>}n{/Shift}');
      await user.keyboard('{Shift>}n{/Shift}');
      await user.keyboard('{Shift>}p{/Shift}');

      expect(result.current.cursor).toEqual({
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 0,
        side: 'left',
      });
    });
  });

  describe('Help Modal (?)', () => {
    it('should toggle help modal with ? key', async () => {
      const user = userEvent.setup();
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      expect(result.current.isHelpOpen).toBe(false);

      // ? is Shift + / on a US keyboard layout.
      await user.keyboard('{Shift>}?{/Shift}');

      expect(result.current.isHelpOpen).toBe(true);
    });

    it('should allow closing help modal with setIsHelpOpen', () => {
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setIsHelpOpen(true);
      });

      expect(result.current.isHelpOpen).toBe(true);

      act(() => {
        result.current.setIsHelpOpen(false);
      });

      expect(result.current.isHelpOpen).toBe(false);
    });
  });

  describe('Review Toggle (v)', () => {
    it('should toggle reviewed state with v key', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'left',
        });
      });

      await user.keyboard('v');

      expect(onToggleReviewed).toHaveBeenCalledWith('file1.js');
    });

    it('should toggle reviewed state of hovered file when there is no cursor', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(),
            getHoveredFileIndex: () => 1,
          }),
        { wrapper },
      );

      await user.keyboard('v');

      expect(onToggleReviewed).toHaveBeenCalledWith('file2.js');
    });

    it('should prefer cursor file over hovered file', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(),
            getHoveredFileIndex: () => 1,
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'left',
        });
      });

      await user.keyboard('v');

      expect(onToggleReviewed).toHaveBeenCalledWith('file1.js');
    });

    it('should not toggle reviewed state when no file is selected', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('v');

      expect(onToggleReviewed).not.toHaveBeenCalled();
    });
  });

  describe('Mark Viewed and Advance (Shift+V)', () => {
    it('should mark current file as viewed and move cursor to next unviewed file', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'left',
        });
      });

      await user.keyboard('{Shift>}v{/Shift}');

      expect(onToggleReviewed).toHaveBeenCalledWith('file1.js');
      expect(result.current.cursor?.fileIndex).toBe(1);
    });

    it('should not mark again when the current file is already viewed', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(['file1.js']),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'left',
        });
      });

      await user.keyboard('{Shift>}v{/Shift}');

      expect(onToggleReviewed).not.toHaveBeenCalled();
      expect(result.current.cursor?.fileIndex).toBe(1);
    });

    it('should keep cursor when all other files are already viewed', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(['file2.js']),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'left',
        });
      });

      await user.keyboard('{Shift>}v{/Shift}');

      expect(onToggleReviewed).toHaveBeenCalledWith('file1.js');
      expect(result.current.cursor?.fileIndex).toBe(0);
    });
  });

  describe('Cursor Memory', () => {
    it('should resume file navigation from the last cursor after it is cleared', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      // setCursorPosition(null) mimics what a mouse click does to the cursor.
      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 2,
          side: 'right',
        });
      });
      act(() => {
        result.current.setCursorPosition(null);
      });

      expect(result.current.cursor).toBeNull();

      await user.keyboard('{\\]}');

      // Moves to the file after the remembered position rather than wrapping to the end.
      expect(result.current.cursor?.fileIndex).toBe(1);
    });

    it('should remember a file position without showing the cursor', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.rememberFilePosition(0);
      });

      expect(result.current.cursor).toBeNull();

      await user.keyboard('{\\]}');
      expect(result.current.cursor?.fileIndex).toBe(1);
    });
  });

  describe('Refresh (shift+r)', () => {
    it('should trigger refresh with shift+r key', async () => {
      const user = userEvent.setup();
      const onRefresh = vi.fn();

      renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
            onRefresh,
          }),
        { wrapper },
      );

      await user.keyboard('{Shift>}r{/Shift}');

      expect(onRefresh).toHaveBeenCalled();
    });

    it('should not trigger refresh when onRefresh is not provided', async () => {
      const user = userEvent.setup();

      renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('r');
    });
  });

  describe('Add Comment (c)', () => {
    it('should trigger comment creation on add/normal lines with c key', async () => {
      const user = userEvent.setup();
      const onCreateComment = vi.fn();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
            onCreateComment,
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 2,
          side: 'right',
        });
      });

      await user.keyboard('c');

      expect(onCreateComment).toHaveBeenCalled();
    });

    it('should not trigger comment creation on deleted lines', async () => {
      const user = userEvent.setup();
      const onCreateComment = vi.fn();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
            onCreateComment,
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'left',
        });
      });

      await user.keyboard('c');

      expect(onCreateComment).not.toHaveBeenCalled();
    });
  });

  describe('Side Switching (h/l)', () => {
    it('should switch to left side with h key', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'split',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 2,
          side: 'right',
        });
      });

      await user.keyboard('h');

      expect(result.current.cursor?.side).toBe('left');
    });

    it('should switch to right side with l key', async () => {
      const user = userEvent.setup();

      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'split',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      act(() => {
        result.current.setCursorPosition({
          fileIndex: 0,
          chunkIndex: 0,
          lineIndex: 0,
          side: 'left',
        });
      });

      await user.keyboard('l');

      expect(result.current.cursor?.side).toBe('right');
    });
  });

  describe('Move to Center (.)', () => {
    it('should move cursor to the center of viewport with . key', async () => {
      const user = userEvent.setup();
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      const elements = [
        { id: 'file-0-chunk-0-line-0', top: 100, bottom: 150 },
        { id: 'file-0-chunk-0-line-1', top: 300, bottom: 350 },
        { id: 'file-0-chunk-0-line-2', top: 380, bottom: 430 }, // Closest to center (384)
        { id: 'file-0-chunk-0-line-3', top: 500, bottom: 550 },
      ];

      mockGetElementById.mockImplementation((id) => {
        const element = elements.find((e) => e.id === id);
        if (element) {
          return {
            getBoundingClientRect: () => ({
              top: element.top,
              bottom: element.bottom,
              height: element.bottom - element.top,
            }),
          } as any;
        }
        return null;
      });

      await user.keyboard('{.}');

      expect(result.current.cursor).not.toBeNull();
    });
  });

  describe('Scope handling', () => {
    it('should use navigation scope for hotkeys', () => {
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      expect(result.current.cursor).toBeNull();
    });
  });

  describe('Input Field Handling', () => {
    it('should not handle shortcuts when typing in input fields', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('j');
      await user.keyboard('r');

      expect(onToggleReviewed).not.toHaveBeenCalled();

      document.body.removeChild(input);
    });

    it('should not handle shortcuts when typing in textarea', async () => {
      const user = userEvent.setup();
      const onToggleReviewed = vi.fn();

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed,
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      await user.keyboard('j');
      await user.keyboard('r');

      expect(onToggleReviewed).not.toHaveBeenCalled();

      document.body.removeChild(textarea);
    });
  });

  describe('Set Cursor Position', () => {
    it('should set cursor position when setCursorPosition is called', () => {
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'unified',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      const position = {
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 1,
        side: 'right' as const,
      };

      act(() => {
        result.current.setCursorPosition(position);
      });

      expect(result.current.cursor).toEqual(position);
    });

    it('should fix side when setting cursor position in split mode', () => {
      const { result } = renderHook(
        () =>
          useKeyboardNavigation({
            files: mockFiles,
            comments: [],
            getViewMode: () => 'split',
            onToggleReviewed: vi.fn(),
            reviewedFiles: new Set<string>(),
          }),
        { wrapper },
      );

      const position = {
        fileIndex: 0,
        chunkIndex: 0,
        lineIndex: 0, // Delete line
        side: 'right' as const,
      };

      act(() => {
        result.current.setCursorPosition(position);
      });

      // Fixed to left side since delete lines only have content on the left.
      expect(result.current.cursor).toEqual({
        ...position,
        side: 'left',
      });
    });
  });
});
