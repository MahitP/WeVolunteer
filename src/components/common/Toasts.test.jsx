/**
 * How a toast is ANNOUNCED, which is the half nobody can see.
 *
 * Every toast in the application — 123 call sites, 57 of them failures — used to
 * announce through one `aria-live="polite"` region on the container. Polite
 * means the screen reader waits for a natural pause, so somebody was told an
 * action had FAILED after they had already moved on believing it worked.
 *
 * These assertions exist because that defect is invisible in every other kind of
 * test and in every screenshot: the toast looked right the whole time.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Toasts from './Toasts';

const at = (toasts) => render(<Toasts toasts={toasts} onRemove={() => {}} />);

describe('Toasts: urgency matches the message', () => {
  it('a failure interrupts', () => {
    at([{ id: 1, type: 'error', message: 'Could not save your changes' }]);
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('Could not save your changes');
    expect(toast.getAttribute('aria-live')).toBe('assertive');
  });

  /**
   * Success and info stay polite on purpose: they confirm something the person
   * just did, so interrupting them talks over the thing they are already doing.
   */
  it('a confirmation waits its turn', () => {
    for (const type of ['success', 'info']) {
      const { unmount } = at([{ id: 1, type, message: `a ${type} message` }]);
      const toast = screen.getByRole('status');
      expect(toast.getAttribute('aria-live'), `${type} should stay polite`).toBe('polite');
      unmount();
    }
  });

  it('announces each toast individually, not through one shared region', () => {
    at([
      { id: 1, type: 'success', message: 'Saved' },
      { id: 2, type: 'error', message: 'Failed' },
    ]);
    // A single container-level region would collapse these into one
    // announcement and give the failure the container's politeness.
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('hides the decorative icon, which only repeats the message', () => {
    const { container } = at([{ id: 1, type: 'error', message: 'Failed' }]);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });
});
