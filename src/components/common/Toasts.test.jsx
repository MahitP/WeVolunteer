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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import Toasts, { TOAST_LIFETIME_MS, TOAST_RESUME_MIN_MS } from './Toasts';

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

/**
 * How long a toast stays, which is the other half nobody sees in a screenshot:
 * a message that disappears mid-sentence, or a failure that dismisses itself
 * before the reader looked back.
 */
describe('Toasts: the clock', () => {
  const setup = (toast) => {
    vi.useFakeTimers();
    const onRemove = vi.fn();
    render(<Toasts toasts={[toast]} onRemove={onRemove} />);
    return onRemove;
  };
  afterEach(() => vi.useRealTimers());

  it('a confirmation closes itself after its lifetime', () => {
    const onRemove = setup({ id: 1, type: 'success', message: 'Saved' });
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS - 1); });
    expect(onRemove).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('a failure stays until it is dismissed', () => {
    const onRemove = setup({ id: 2, type: 'error', message: 'Could not save' });
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS * 10); });
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onRemove).toHaveBeenCalledWith(2);
  });

  it('waits while the pointer is over it, then resumes with the time it had left', () => {
    const onRemove = setup({ id: 3, type: 'info', message: 'Heads up' });
    const toast = screen.getByRole('status');
    act(() => { vi.advanceTimersByTime(3000); });
    fireEvent.mouseEnter(toast);
    act(() => { vi.advanceTimersByTime(60000); });
    expect(onRemove, 'closed under the pointer').not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    act(() => { vi.advanceTimersByTime(1999); });
    expect(onRemove).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onRemove).toHaveBeenCalledWith(3);
  });

  it('waits while focus is inside it', () => {
    const onRemove = setup({ id: 4, type: 'success', message: 'Saved' });
    fireEvent.focus(screen.getByRole('button', { name: 'Dismiss' }));
    act(() => { vi.advanceTimersByTime(60000); });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('gives at least the resume minimum after being let go near the end', () => {
    const onRemove = setup({ id: 5, type: 'success', message: 'Saved' });
    const toast = screen.getByRole('status');
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS - 10); });
    fireEvent.mouseEnter(toast);
    fireEvent.mouseLeave(toast);
    act(() => { vi.advanceTimersByTime(TOAST_RESUME_MIN_MS - 1); });
    expect(onRemove).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onRemove).toHaveBeenCalledWith(5);
  });
});
