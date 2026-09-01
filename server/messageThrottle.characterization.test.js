import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The message send throttle, pinned BEFORE it was made shareable.
 *
 * ── Why characterize rather than just port ──
 *
 * `checkMessageRateLimit` was a closure over a module-level `Map` inside
 * `routes/messageRoutes.js`, and its rules were never written down anywhere —
 * they were only observable by reading the loop. Moving that state to Redis is
 * exactly the kind of change that silently alters a limit, a window shape, or
 * the moment a bucket resets, so the rules are recorded here first and the new
 * implementation has to reproduce every one of them.
 *
 * What the original did, read off the code:
 *
 *   • keyed on `userId` alone — not conversation, not IP, not recipient
 *   • 20 messages per 60,000 ms
 *   • a SLIDING window: it kept a timestamp per send and filtered to those
 *     newer than 60s, so the budget recovers continuously rather than all at
 *     once on a boundary
 *   • a rejected send does NOT consume budget (the timestamp is only pushed on
 *     the allowed path)
 *
 * That third point is the one most easily lost. `express-rate-limit`'s store
 * uses fixed windows, so porting this onto the same primitive as the other
 * limiters would have turned a smooth 20-per-rolling-minute into a bursty
 * 40-across-a-boundary. It is tested explicitly below.
 */
const LIMIT = 20;
const WINDOW_MS = 60_000;

let allow;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
  vi.resetModules();
  const mod = await import('./messageThrottle.js');
  mod.__resetMessageThrottleForTests();
  allow = mod.checkMessageRateLimit;
});

afterEach(() => { vi.useRealTimers(); });

/** Sends `n` times and returns how many were allowed. */
async function send(user, n) {
  let ok = 0;
  for (let i = 0; i < n; i++) if (await allow(user)) ok++;
  return ok;
}

describe('the limit itself', () => {
  it('allows exactly 20 in a fresh window', async () => {
    expect(await send('u1', LIMIT)).toBe(LIMIT);
  });

  it('refuses the 21st', async () => {
    await send('u1', LIMIT);
    expect(await allow('u1')).toBe(false);
  });

  it('a refused send does not consume budget', async () => {
    /**
     * The original pushed the timestamp only on the allowed path, so hammering
     * while blocked does not extend the block. If a port started counting
     * rejections, a user who kept retrying would never recover — the window
     * would be pushed forward by their own retries.
     */
    await send('u1', LIMIT);
    for (let i = 0; i < 50; i++) expect(await allow('u1')).toBe(false);

    /* Exactly one slot's worth of time. The oldest send ages out and one more
       becomes available — which cannot happen if the retries were counted. */
    vi.advanceTimersByTime(WINDOW_MS + 1);
    expect(await allow('u1')).toBe(true);
  });
});

describe('the window is SLIDING, not fixed', () => {
  it('recovers one slot at a time as sends age out', async () => {
    /* Ten sends now, ten sends 30 seconds later. */
    await send('u1', 10);
    vi.advanceTimersByTime(30_000);
    await send('u1', 10);
    expect(await allow('u1'), 'twenty in the last minute should be the ceiling').toBe(false);

    /* At t=61s the first ten have aged out; ten slots free, not twenty. */
    vi.advanceTimersByTime(31_000);
    expect(await send('u1', 10)).toBe(10);
    expect(await allow('u1'), 'the second ten have NOT aged out yet').toBe(false);
  });

  it('does not permit a burst of 40 across a boundary', async () => {
    /**
     * The property that separates a sliding window from a fixed one, and the
     * reason this file exists. Under a fixed 60s window, 20 sends at 00:59 and
     * 20 at 01:01 are both legal — 40 messages in two seconds. Under the
     * sliding window the second batch is refused.
     */
    await send('u1', LIMIT);
    vi.advanceTimersByTime(2_000);
    expect(await send('u1', LIMIT), 'a sliding window must not allow a boundary burst').toBe(0);
  });
});

describe('keying', () => {
  it('is per user — one sender cannot spend another sender\'s budget', async () => {
    await send('u1', LIMIT);
    expect(await allow('u1')).toBe(false);
    expect(await allow('u2'), 'a second user shares u1\'s bucket').toBe(true);
  });

  it('keeps distinct users independent across the whole window', async () => {
    expect(await send('a', LIMIT)).toBe(LIMIT);
    expect(await send('b', LIMIT)).toBe(LIMIT);
    expect(await allow('a')).toBe(false);
    expect(await allow('b')).toBe(false);
  });
});
