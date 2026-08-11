import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const ctx = {
  showPrompt: true,
  requestLocation: vi.fn(),
  dismissPrompt: vi.fn(),
};

vi.mock('../../contexts/LocationContext', () => ({
  useLocationContext: () => ctx,
}));

import LocationPrompt from './LocationPrompt';

/**
 * The banner `LocationContext` was written for and never got.
 *
 * `showPrompt` and `dismissPrompt` have been exported since the context
 * shipped, with no consumer, while the feature documentation described this
 * banner as if it existed.
 */
describe('LocationPrompt', () => {
  beforeEach(() => {
    ctx.showPrompt = true;
    ctx.requestLocation.mockReset();
    ctx.dismissPrompt.mockReset();
  });

  it('offers to use the location, without asking for it yet', () => {
    render(<LocationPrompt />);

    /**
     * The critical property: rendering must not call `requestLocation`.
     * Browsers only show the permission dialog in response to a gesture, and a
     * site that fires it on load trains people to refuse.
     */
    expect(ctx.requestLocation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /use my location/i })).toBeInTheDocument();
  });

  it('asks only when the button is pressed', () => {
    render(<LocationPrompt />);
    fireEvent.click(screen.getByRole('button', { name: /use my location/i }));
    expect(ctx.requestLocation).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed', () => {
    render(<LocationPrompt />);
    fireEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(ctx.dismissPrompt).toHaveBeenCalledTimes(1);
  });

  it('renders nothing once the question has been answered', () => {
    ctx.showPrompt = false;
    const { container } = render(<LocationPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says what happens to the position, since that is what it is asking for', () => {
    render(<LocationPrompt />);
    expect(screen.getByText(/stays on your device/i)).toBeInTheDocument();
  });

  it('gives the dismiss control a name, not just an X', () => {
    render(<LocationPrompt />);
    const dismiss = screen.getByRole('button', { name: /not now/i });
    expect(dismiss.getAttribute('aria-label')).toBeTruthy();
  });
});
