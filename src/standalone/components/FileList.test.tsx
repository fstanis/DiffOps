import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'bun:test';
import '@testing-library/jest-dom';

import type { DiffFile } from '../../types/diff';

import { FileList } from './FileList';

const createFile = (
  path: string,
  totals: { additions?: number; deletions?: number } = {},
): DiffFile => ({
  path,
  status: 'modified',
  additions: totals.additions ?? 1,
  deletions: totals.deletions ?? 1,
  chunks: [],
});

function getTreeRow(title: string): HTMLElement {
  const row = screen.getByTitle(title).closest<HTMLElement>('[data-tree-row="true"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function getLabel(title: string): HTMLElement {
  return screen.getByTitle(title);
}

describe('FileList', () => {
  it('renders total additions and deletions beside the file count', () => {
    render(
      <FileList
        files={[
          createFile('README.md', { additions: 3, deletions: 1 }),
          createFile('src/client/App.tsx', { additions: 2, deletions: 4 }),
        ]}
        onScrollToFile={vi.fn()}
        comments={[]}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        hiddenFiles={new Set()}
        onToggleHidden={vi.fn()}
        selectedFileIndex={null}
      />,
    );

    expect(screen.getByText('Files changed (2)')).toBeInTheDocument();
    expect(screen.getByLabelText('5 additions and 5 deletions')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('-5')).toBeInTheDocument();
  });

  it('strikes through directories when all descendant files are reviewed', () => {
    const files = [
      createFile('src/cli/index.ts'),
      createFile('src/client/App.tsx'),
      createFile('README.md'),
    ];
    const props = {
      files,
      onScrollToFile: vi.fn(),
      comments: [],
      onToggleReviewed: vi.fn(),
      onToggleFolderReviewed: vi.fn(),
      hiddenFiles: new Set<string>(),
      onToggleHidden: vi.fn(),
      selectedFileIndex: null,
    };
    const { rerender } = render(
      <FileList {...props} reviewedFiles={new Set(['README.md', 'src/cli/index.ts'])} />,
    );

    expect(getLabel('src')).not.toHaveClass('line-through');
    expect(getTreeRow('src')).not.toHaveClass('opacity-70');
    expect(getLabel('cli')).toHaveClass('line-through');
    expect(getTreeRow('cli')).toHaveClass('opacity-70');
    expect(getLabel('client')).not.toHaveClass('line-through');
    expect(getTreeRow('client')).not.toHaveClass('opacity-70');

    rerender(
      <FileList
        {...props}
        reviewedFiles={new Set(['README.md', 'src/cli/index.ts', 'src/client/App.tsx'])}
      />,
    );

    expect(getLabel('src')).toHaveClass('line-through');
    expect(getTreeRow('src')).toHaveClass('opacity-70');
    expect(getLabel('cli')).toHaveClass('line-through');
    expect(getTreeRow('cli')).toHaveClass('opacity-70');
    expect(getLabel('client')).toHaveClass('line-through');
    expect(getTreeRow('client')).toHaveClass('opacity-70');
  });

  it('marks all files in a folder as reviewed via the directory checkbox', () => {
    const onToggleFolderReviewed = vi.fn();
    render(
      <FileList
        files={[
          createFile('src/cli/index.ts'),
          createFile('src/client/App.tsx'),
          createFile('README.md'),
        ]}
        onScrollToFile={vi.fn()}
        comments={[]}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={onToggleFolderReviewed}
        hiddenFiles={new Set()}
        onToggleHidden={vi.fn()}
        selectedFileIndex={null}
      />,
    );

    const checkbox = within(getTreeRow('src')).getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(checkbox);
    expect(onToggleFolderReviewed).toHaveBeenCalledWith('src', true);
  });

  it('renders both a file row and directory children when a path is both a file and a directory prefix', () => {
    const onScrollToFile = vi.fn();
    render(
      <FileList
        files={[
          { ...createFile('vendor'), status: 'deleted' },
          createFile('vendor/lib.ts'),
          createFile('vendor/utils.ts'),
        ]}
        onScrollToFile={onScrollToFile}
        comments={[]}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        hiddenFiles={new Set()}
        onToggleHidden={vi.fn()}
        selectedFileIndex={null}
      />,
    );

    expect(screen.getByTitle('vendor/lib.ts')).toBeInTheDocument();
    expect(screen.getByTitle('vendor/utils.ts')).toBeInTheDocument();

    const vendorElements = screen.getAllByTitle('vendor');
    const vendorFileRow = vendorElements
      .map((el) => el.closest('[data-file-row="true"]'))
      .find(Boolean);
    expect(vendorFileRow).toBeDefined();
    fireEvent.click(vendorFileRow!);
    expect(onScrollToFile).toHaveBeenCalledWith('vendor');
  });

  it('unmarks all files in a fully reviewed folder via the directory checkbox', () => {
    const onToggleFolderReviewed = vi.fn();
    render(
      <FileList
        files={[createFile('src/cli/index.ts'), createFile('src/client/App.tsx')]}
        onScrollToFile={vi.fn()}
        comments={[]}
        reviewedFiles={new Set(['src/cli/index.ts', 'src/client/App.tsx'])}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={onToggleFolderReviewed}
        hiddenFiles={new Set()}
        onToggleHidden={vi.fn()}
        selectedFileIndex={null}
      />,
    );

    const checkbox = within(getTreeRow('src')).getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(checkbox);
    expect(onToggleFolderReviewed).toHaveBeenCalledWith('src', false);
  });

  it('renders a numbered flat list in narrated view', () => {
    render(
      <FileList
        files={[
          createFile('src/cli/index.ts'),
          createFile('src/client/App.tsx'),
          createFile('README.md'),
        ]}
        onScrollToFile={vi.fn()}
        comments={[]}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        hiddenFiles={new Set()}
        onToggleHidden={vi.fn()}
        selectedFileIndex={null}
        isNarratedView
      />,
    );

    expect(screen.getByText('Files changed (3)')).toBeInTheDocument();
    expect(screen.queryByTitle('src')).not.toBeInTheDocument();

    const rows = screen.getAllByTitle(/^(src\/|README)/);
    expect(rows.map((row) => row.getAttribute('title'))).toEqual([
      'src/cli/index.ts',
      'src/client/App.tsx',
      'README.md',
    ]);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('dims the directory portion of narrated rows and keeps review affordances', () => {
    const onScrollToFile = vi.fn();
    const onToggleReviewed = vi.fn();
    render(
      <FileList
        files={[createFile('src/cli/index.ts'), createFile('README.md')]}
        onScrollToFile={onScrollToFile}
        comments={[
          {
            id: 'thread-1',
            file: 'README.md',
            line: 1,
            side: 'new',
            createdAt: '2026-08-28T00:00:00.000Z',
            updatedAt: '2026-08-28T00:00:00.000Z',
            messages: [],
          },
        ]}
        reviewedFiles={new Set(['README.md'])}
        onToggleReviewed={onToggleReviewed}
        onToggleFolderReviewed={vi.fn()}
        hiddenFiles={new Set()}
        onToggleHidden={vi.fn()}
        selectedFileIndex={1}
        isNarratedView
      />,
    );

    const directorySpan = screen.getByTitle('src/cli/index.ts').children[0];
    expect(directorySpan).toHaveClass('text-github-text-muted');

    fireEvent.click(screen.getByTitle('README.md'));
    expect(onScrollToFile).toHaveBeenCalledWith('README.md');

    fireEvent.click(within(getTreeRow('README.md')).getByRole('checkbox'));
    expect(onToggleReviewed).toHaveBeenCalledWith('README.md');

    expect(getTreeRow('README.md')).toHaveClass('opacity-70');
    expect(getTreeRow('README.md')).toHaveClass('bg-github-bg-tertiary');
  });

  it('filters narrated rows by path while keeping their sequence numbers', () => {
    render(
      <FileList
        files={[
          createFile('src/cli/index.ts'),
          createFile('src/client/App.tsx'),
          createFile('README.md'),
        ]}
        onScrollToFile={vi.fn()}
        comments={[]}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        hiddenFiles={new Set()}
        onToggleHidden={vi.fn()}
        selectedFileIndex={null}
        isNarratedView
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Filter files...'), {
      target: { value: 'client' },
    });

    expect(screen.queryByTitle('src/cli/index.ts')).not.toBeInTheDocument();
    expect(screen.getByTitle('src/client/App.tsx')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });
  it('keeps hidden files listed but out of the count, the totals and the numbering', () => {
    render(
      <FileList
        files={[
          createFile('a.ts', { additions: 3, deletions: 1 }),
          createFile('b.ts', { additions: 2, deletions: 4 }),
        ]}
        onScrollToFile={vi.fn()}
        comments={[]}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        hiddenFiles={new Set(['b.ts'])}
        onToggleHidden={vi.fn()}
        selectedFileIndex={null}
        isNarratedView
      />,
    );

    expect(screen.getByText('Files changed (1)')).toBeInTheDocument();
    expect(screen.getByText('1 hidden')).toBeInTheDocument();
    expect(screen.getByLabelText('3 additions and 1 deletions')).toBeInTheDocument();
    expect(getTreeRow('b.ts')).toHaveAttribute('data-file-hidden', 'true');
    expect(getLabel('b.ts')).toHaveClass('italic');
    // The hidden row holds no place in the reviewed order, so it carries no number.
    expect(within(getTreeRow('a.ts')).getByText('1')).toBeInTheDocument();
    expect(within(getTreeRow('b.ts')).getByText('–')).toBeInTheDocument();
  });

  it('toggles a file out of and back into the review from its eye', () => {
    const onToggleHidden = vi.fn();
    const onScrollToFile = vi.fn();
    const props = {
      files: [createFile('a.ts'), createFile('b.ts')],
      onScrollToFile,
      comments: [],
      reviewedFiles: new Set<string>(),
      onToggleReviewed: vi.fn(),
      onToggleFolderReviewed: vi.fn(),
      onToggleHidden,
      selectedFileIndex: null,
    };
    const { rerender } = render(<FileList {...props} hiddenFiles={new Set()} />);

    fireEvent.click(
      within(getTreeRow('b.ts')).getByRole('button', {
        name: 'Hide this file from the review and the AI',
      }),
    );
    expect(onToggleHidden).toHaveBeenCalledWith('b.ts');

    rerender(<FileList {...props} hiddenFiles={new Set(['b.ts'])} />);

    // A hidden file has no diff section left to scroll to.
    fireEvent.click(getTreeRow('b.ts'));
    expect(onScrollToFile).not.toHaveBeenCalled();

    fireEvent.click(
      within(getTreeRow('b.ts')).getByRole('button', { name: 'Show this file again' }),
    );
    expect(onToggleHidden).toHaveBeenCalledTimes(2);
  });
  it('leaves a folder unstruck while it holds nothing but hidden files', () => {
    const props = {
      files: [createFile('src/cli/index.ts'), createFile('src/client/App.tsx')],
      onScrollToFile: vi.fn(),
      comments: [],
      reviewedFiles: new Set(['src/client/App.tsx']),
      onToggleReviewed: vi.fn(),
      onToggleFolderReviewed: vi.fn(),
      onToggleHidden: vi.fn(),
      selectedFileIndex: null,
    };
    render(<FileList {...props} hiddenFiles={new Set(['src/cli/index.ts'])} />);

    // Nothing in cli is up for review, so it reads as neither done nor pending.
    expect(getLabel('cli')).not.toHaveClass('line-through');
    expect(getLabel('client')).toHaveClass('line-through');
    // src has one reviewable file left and it is reviewed.
    expect(getLabel('src')).toHaveClass('line-through');
  });
});
