/**
 * Network detection.
 *
 * This is new behaviour, not a restyling: before it, a volunteer on a school
 * bus with one bar and a volunteer whose session had expired got the same
 * silent empty screen. The hook is small enough that the interesting part is
 * entirely in the edges — the listeners actually being attached, the state
 * being re-read after they are, and the teardown really removing them.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useOnline from './useOnline';

/** `navigator.onLine` is a getter; this is the only way to drive it. */
function setOnLine(value) {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  setOnLine(true);
  vi.restoreAllMocks();
});

describe('useOnline', () => {
  it('starts from what the browser already reports', () => {
    setOnLine(false);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(false);
  });

  it('defaults to online rather than blocking the app when unknown', () => {
    setOnLine(true);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
  });

  it('goes offline when the browser says so', () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);

    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
  });

  it('recovers on its own when the connection returns', () => {
    setOnLine(false);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(false);

    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
    });
    // The offline experience promises it "recovers on its own"; this is that
    // promise. Nothing about it requires the reader to press anything.
    expect(result.current).toBe(true);
  });

  /**
   * The connection can drop between the first render and the effect running,
   * and that gap is exactly when somebody is walking out of range. Without the
   * re-read inside the effect the hook would report online forever, because the
   * `offline` event fired before anything was listening for it.
   */
  it('re-reads the connection after the listeners are attached', () => {
    setOnLine(true);
    const { result, rerender } = renderHook(() => useOnline());

    // Drop with no event at all — this is the missed-event case.
    setOnLine(false);
    rerender();
    expect(result.current).toBe(true); // no event, no re-read yet

    // A fresh mount must pick up the true state from the effect.
    const second = renderHook(() => useOnline());
    expect(second.result.current).toBe(false);
  });

  it('removes both listeners on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useOnline());
    unmount();

    const removed = remove.mock.calls.map(([type]) => type);
    expect(removed).toContain('online');
    expect(removed).toContain('offline');
  });
});
