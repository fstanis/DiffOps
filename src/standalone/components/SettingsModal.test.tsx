import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it, vi } from 'bun:test';

import { DEFAULT_AI_SETTINGS } from '../hooks/useAiSettings';
import { SettingsModal } from './SettingsModal';

vi.mock('react-hotkeys-hook', () => ({
  useHotkeysContext: vi.fn(() => ({
    enableScope: vi.fn(),
    disableScope: vi.fn(),
  })),
  HotkeysProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <HotkeysProvider initiallyActiveScopes={['navigation']}>{children}</HotkeysProvider>
);

const TOOLTIP_CLOSE_GRACE_MS = 250;

const baseSettings = {
  fontSize: 14,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
  theme: 'dark' as const,
  syntaxTheme: 'vsDark',
  colorVision: 'normal' as const,
  autoViewedPatterns: [],
};

const baseAiSettings = { ...DEFAULT_AI_SETTINGS };

describe('SettingsModal', () => {
  it('shows appearance settings by default and switches to the system section', () => {
    render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={baseSettings}
        onSettingsChange={vi.fn()}
        aiSettings={baseAiSettings}
        onAiSettingsChange={vi.fn()}
      />,
      { wrapper },
    );

    expect(screen.getByText('Font Size')).toBeInTheDocument();
    expect(screen.queryByText('Scroll Animation')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Theme, typography, and syntax highlighting.'),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText('Appearance')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Appearance/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: /^System/ }));

    expect(screen.getByText('Auto-Mark Viewed Patterns')).toBeInTheDocument();
    expect(screen.queryByText('Font Size')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^System/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the deuteranopia explanation only while the button is hovered', async () => {
    render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={baseSettings}
        onSettingsChange={vi.fn()}
        aiSettings={baseAiSettings}
        onAiSettingsChange={vi.fn()}
      />,
      { wrapper },
    );

    expect(
      screen.queryByText('Deuteranopia mode uses blue/orange instead of green/red for diffs.'),
    ).not.toBeInTheDocument();

    const deuteranopiaButton = screen.getByRole('button', { name: 'Deuteranopia' });
    fireEvent.mouseEnter(deuteranopiaButton);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(
      'Deuteranopia mode uses blue/orange instead of green/red for diffs.',
    );
    expect(deuteranopiaButton).toHaveAttribute('aria-describedby', tooltip.id);

    fireEvent.mouseLeave(deuteranopiaButton);

    // The tooltip unmounts after its 120 ms close transition; bun's waitFor
    // re-polling can outpace that transition, so hand it the time first.
    await new Promise((resolve) => {
      setTimeout(resolve, TOOLTIP_CLOSE_GRACE_MS);
    });

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      expect(deuteranopiaButton).not.toHaveAttribute('aria-describedby');
    });
  });

  it('edits auto-viewed patterns from the system section as newline-delimited values', () => {
    const onSettingsChange = vi.fn();

    render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={baseSettings}
        onSettingsChange={onSettingsChange}
        aiSettings={baseAiSettings}
        onAiSettingsChange={vi.fn()}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /^System/ }));

    const textarea = screen.getByLabelText('Auto-Mark Viewed Patterns');
    fireEvent.change(textarea, { target: { value: '*.test.ts\nsrc/generated/**' } });

    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      autoViewedPatterns: ['*.test.ts', 'src/generated/**'],
    });
  });
});
