/**
 * The runtime half of the interface motion. Each helper has to degrade to
 * "no motion" on its own — without the API, under reduced motion, and in the
 * test renderer — because the page must be correct with every animation gone.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useState } from 'react';
import {
  playDialogExit, withViewTransition, useDelayedFlag, rowTransitionStyle, prefersReducedMotion,
} from './motion';
import TintOnChange from '../components/common/TintOnChange';

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-motion');
  document.body.innerHTML = '';
  delete document.startViewTransition;
});

/** A dialog as React leaves it after unmounting: detached, with its overlay. */
function detachedDialog({ animatable = true } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'ov';
  const dialog = document.createElement('div');
  dialog.className = 'modal';
  dialog.id = 'dlg';
  dialog.setAttribute('role', 'dialog');
  dialog.textContent = 'Withdraw from this event?';
  overlay.appendChild(dialog);
  if (animatable) dialog.getAnimations = () => [];
  return dialog;
}

describe('playDialogExit', () => {
  beforeEach(() => vi.useFakeTimers());

  it('fades an inert, hidden, id-free copy and then removes it', () => {
    playDialogExit(detachedDialog());
    const ghost = document.body.querySelector('.modal-overlay.modal-exit');
    expect(ghost).not.toBeNull();
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.inert).toBe(true);
    expect(ghost.querySelector('[id]')).toBeNull();
    expect(ghost.id).toBe('');
    act(() => { vi.advanceTimersByTime(400); });
    expect(document.body.querySelector('.modal-exit')).toBeNull();
  });

  it('does nothing under the reader\'s own reduced-motion setting', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    playDialogExit(detachedDialog());
    expect(document.body.querySelector('.modal-exit')).toBeNull();
  });

  it('does nothing without the Web Animations API', () => {
    playDialogExit(detachedDialog({ animatable: false }));
    expect(document.body.querySelector('.modal-exit')).toBeNull();
  });

  it('does nothing while the dialog is still in the document (a StrictMode rehearsal)', () => {
    const dialog = detachedDialog();
    document.body.appendChild(dialog.parentElement);
    playDialogExit(dialog);
    expect(document.body.querySelectorAll('.modal-overlay')).toHaveLength(1);
  });
});

describe('withViewTransition', () => {
  it('just runs the update where the API is missing', () => {
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('runs the update inside the transition, and swallows a skipped one', async () => {
    const rejected = () => { const p = Promise.reject(new Error('skipped')); return p; };
    document.startViewTransition = vi.fn((cb) => {
      cb();
      return { ready: rejected(), finished: rejected(), updateCallbackDone: rejected() };
    });
    const update = vi.fn();
    withViewTransition(update);
    expect(document.startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // an unhandled rejection would fail the run here
  });

  it('falls back to a plain update if starting the transition throws', () => {
    document.startViewTransition = () => { throw new Error('InvalidStateError'); };
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('rowTransitionStyle', () => {
  it('builds a valid identifier from any id', () => {
    expect(rowTransitionStyle('ev', 'a b/c:1')).toEqual({ viewTransitionName: 'ev-a_b_c_1' });
    expect(rowTransitionStyle('ev', null)).toBeUndefined();
  });
});

describe('prefersReducedMotion', () => {
  it('honours the reader\'s own setting even when the OS says nothing', () => {
    expect(prefersReducedMotion()).toBe(false);
    document.documentElement.setAttribute('data-motion', 'reduce');
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('useDelayedFlag', () => {
  function Probe({ active }) {
    return <span>{useDelayedFlag(active, 300) ? 'shown' : 'hidden'}</span>;
  }

  it('turns on only after the threshold, and off the moment the wait ends', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Probe active />);
    act(() => { vi.advanceTimersByTime(299); });
    expect(container).toHaveTextContent('hidden');
    act(() => { vi.advanceTimersByTime(1); });
    expect(container).toHaveTextContent('shown');
    rerender(<Probe active={false} />);
    expect(container).toHaveTextContent('hidden');
  });
});

describe('TintOnChange', () => {
  function Counter() {
    const [n, setN] = useState(3);
    return (
      <>
        <TintOnChange value={n} className="stat-value">{n} places left</TintOnChange>
        <button onClick={() => setN(n - 1)}>take one</button>
      </>
    );
  }

  it('shows the new value at once, tinted only after a change and never on arrival', () => {
    const { container, getByRole } = render(<Counter />);
    const value = () => container.querySelector('.stat-value');
    expect(value()).toHaveTextContent('3 places left');
    expect(value().classList.contains('value-tint')).toBe(false);
    act(() => { getByRole('button').click(); });
    expect(value()).toHaveTextContent('2 places left');
    expect(value().classList.contains('value-tint')).toBe(true);
  });
});
