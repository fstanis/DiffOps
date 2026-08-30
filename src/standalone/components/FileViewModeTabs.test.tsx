import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'bun:test';
import '@testing-library/jest-dom';

import { FileViewModeTabs } from './FileViewModeTabs';

describe('FileViewModeTabs', () => {
  const textFileOptions = ['unified', 'split', 'full'] as const;
  const markdownOptions = [...textFileOptions, 'diff-preview', 'full-preview'] as const;

  it('renders the text-mode options with unified first', () => {
    render(
      <FileViewModeTabs viewMode="unified" options={textFileOptions} onModeChange={vi.fn()} />,
    );

    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Unified', 'Split', 'Full']);
  });

  it('appends the preview options for markdown files', () => {
    render(
      <FileViewModeTabs viewMode="unified" options={markdownOptions} onModeChange={vi.fn()} />,
    );

    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Unified', 'Split', 'Full', 'Diff Preview', 'Full Preview']);
  });

  it('marks only the active mode as pressed', () => {
    render(<FileViewModeTabs viewMode="split" options={textFileOptions} onModeChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Unified' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('reports the selected mode', () => {
    const onModeChange = vi.fn();
    render(
      <FileViewModeTabs viewMode="unified" options={textFileOptions} onModeChange={onModeChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Full' }));

    expect(onModeChange).toHaveBeenCalledWith('full');
  });

  it('disables unavailable modes', () => {
    render(
      <FileViewModeTabs
        viewMode="unified"
        options={textFileOptions}
        disabledOptions={new Set(['full'])}
        onModeChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Full' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Split' })).toBeEnabled();
  });
});
