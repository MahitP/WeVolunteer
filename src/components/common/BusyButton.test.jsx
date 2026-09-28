/**
 * A button waiting on the server says so, and cannot be pressed twice — but
 * only shows a spinner once the wait is long enough to be a wait.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import BusyButton from './BusyButton';

afterEach(() => vi.useRealTimers());

const at = (props) => render(
  <BusyButton className="btn btn-primary" busyLabel="Signing up…" {...props}>Sign up</BusyButton>
);

describe('BusyButton', () => {
  it('is an ordinary button while idle', () => {
    at({ busy: false });
    const button = screen.getByRole('button', { name: 'Sign up' });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('aria-busy');
  });

  it('says what it is doing, is busy, and blocks a second press', () => {
    const onClick = vi.fn();
    at({ busy: true, onClick });
    const button = screen.getByRole('button', { name: 'Signing up…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows no spinner for a reply under 300ms', () => {
    vi.useFakeTimers();
    const { container, rerender } = at({ busy: true });
    act(() => { vi.advanceTimersByTime(299); });
    expect(container.querySelector('.btn-busy-spinner')).toBeNull();
    rerender(<BusyButton busyLabel="Signing up…" busy={false}>Sign up</BusyButton>);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.querySelector('.btn-busy-spinner')).toBeNull();
  });

  it('adds the spinner once the wait passes 300ms, hidden from assistive technology', () => {
    vi.useFakeTimers();
    const { container } = at({ busy: true });
    act(() => { vi.advanceTimersByTime(300); });
    const spinner = container.querySelector('.btn-busy-spinner');
    expect(spinner).not.toBeNull();
    expect(spinner.getAttribute('aria-hidden')).toBe('true');
  });

  it('stays disabled for its own reasons when not busy', () => {
    at({ busy: false, disabled: true });
    expect(screen.getByRole('button', { name: 'Sign up' })).toBeDisabled();
  });
});
