import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'bun:test';

import { Tooltip } from './Tooltip';

const TOOLTIP_CLOSE_GRACE_MS = 250;

describe('Tooltip', () => {
  it('shows content while the trigger is hovered', async () => {
    render(
      <Tooltip content="Tooltip content">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole('button', { name: 'Trigger' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Tooltip content');
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);

    fireEvent.mouseLeave(trigger);

    // bun's waitFor can outpace the tooltip's 120ms close transition; wait it out first.
    await new Promise((resolve) => {
      setTimeout(resolve, TOOLTIP_CLOSE_GRACE_MS);
    });

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      expect(trigger).not.toHaveAttribute('aria-describedby');
    });
  });
});
