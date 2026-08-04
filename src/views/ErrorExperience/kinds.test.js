/**
 * Telling a stale tab apart from a real crash.
 *
 * ── Why this is worth a module of its own ──
 *
 * `chunk` shipped with copy, artwork and eligibility, and nothing that could
 * ever produce it: the route-table boundary reported every caught error as
 * `crash`. So the single most common client failure in a deployed SPA — a tab
 * left open across a release, asking for a bundle whose hashed filename no
 * longer exists — was described as "the screen stopped responding" and offered
 * a `reset` that cannot possibly help, because the file is genuinely not there.
 * A reload is the fix, and it is the one thing the crash wording does not say.
 *
 * The three engines word it three different ways and none of them expose a
 * machine-readable code, so this is string matching against a browser message.
 * That is fragile by nature, which is exactly why it is pinned here: when a
 * fourth wording appears, a test is the thing that notices.
 */
import { describe, it, expect } from 'vitest';
import { kindForError, KINDS } from './kinds';

describe('a bundle that never arrived is not a crash', () => {
  it.each([
    // Chrome / Edge
    ['Failed to fetch dynamically imported module: https://app.example/assets/Settings-D2u4yoAB.js'],
    // Firefox
    ['error loading dynamically imported module'],
    // Safari
    ['Importing a module script failed.'],
    // Vite's own preload helper, which wraps the fetch
    ['Unable to preload CSS for /assets/Settings-D2u4yoAB.css'],
  ])('recognises %s', (message) => {
    expect(kindForError(new Error(message))).toBe('chunk');
  });

  it('recognises a bundler that names the error instead of wording it', () => {
    const err = new Error('Loading chunk 42 failed.');
    err.name = 'ChunkLoadError';
    expect(kindForError(err)).toBe('chunk');
  });

  it('is not fooled by an application error that happens to mention a module', () => {
    // The failure mode that matters in the other direction: calling a genuine
    // crash a stale tab tells someone to reload, which loses their work and
    // does not fix anything.
    expect(kindForError(new Error('Cannot read properties of undefined (reading "module")')))
      .toBe('crash');
    expect(kindForError(new TypeError('event.slots is not iterable'))).toBe('crash');
  });

  it('never throws on whatever a boundary actually caught', () => {
    // React hands the fallback whatever was thrown, and that is not always an
    // Error — a rejected string, a null, an object with a hostile getter.
    for (const thrown of [undefined, null, 'a string', 42, {}, { message: null }]) {
      expect(KINDS, String(thrown)).toContain(kindForError(thrown));
    }
    const hostile = { get message() { throw new Error('boom'); } };
    expect(KINDS).toContain(kindForError(hostile));
  });
});
