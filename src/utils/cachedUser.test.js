import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from './api';

/**
 * Reading the cached user never throws, and never invents one.
 *
 * ── Why this matters more than it looks ──
 *
 * `getCurrentCachedUser` did a bare `JSON.parse` on whatever was in
 * localStorage. Five call sites read it, and one of them now runs DURING RENDER
 * on `/about` — a public page whose whole audience is people deciding whether to
 * trust this platform. One corrupt entry and they get a blank page.
 *
 * Corruption is not exotic: a storage quota hit part-way through a write, a
 * browser extension, a hand-edit in devtools, or a half-synced profile between
 * browser versions all produce a value that is present and unparseable.
 *
 * A cache that cannot be read is the same thing as a cache that is not there,
 * and every caller already handles absent.
 */

/** The key `api.js` actually writes. Hard-coded here so a rename fails loudly. */
const KEY = 'wev_auth_user';

describe('api.getCurrentCachedUser', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('returns the cached user when one is stored', () => {
    /* The positive case, and the vacuity guard: without it every assertion
       below would pass against a function that always returned null. */
    localStorage.setItem(KEY, JSON.stringify({ id: 'u1', name: 'Alex' }));
    expect(api.getCurrentCachedUser()).toMatchObject({ id: 'u1', name: 'Alex' });
  });

  it('returns null when nothing is cached', () => {
    expect(api.getCurrentCachedUser()).toBeNull();
  });

  it.each([
    ['truncated JSON', '{"id":"u1"'],
    ['an unclosed brace', '{'],
    ['a bare word', 'undefined'],
    ['whitespace only', '   '],
    ['a stray quote', '"'],
  ])('survives %s without throwing', (_label, raw) => {
    localStorage.setItem(KEY, raw);
    expect(() => api.getCurrentCachedUser()).not.toThrow();
    expect(api.getCurrentCachedUser()).toBeNull();
  });

  it.each([
    ['a bare string', '"hello"'],
    ['a number', '7'],
    ['a boolean', 'true'],
    ['null', 'null'],
  ])('treats %s as no user rather than as one', (_label, raw) => {
    /**
     * These all PARSE. `JSON.parse('"hello"')` returns a string, and a caller
     * reading `.id` off it gets `undefined` rather than throwing — which is
     * worse than a crash, because the value behaves like a signed-in user all
     * the way to whatever it is finally used for.
     */
    localStorage.setItem(KEY, raw);
    expect(api.getCurrentCachedUser()).toBeNull();
  });

  it('does not mistake an array for a user', () => {
    /* `typeof [] === 'object'`, so an array passes a naive object check and
       then reads `.id` as undefined. */
    localStorage.setItem(KEY, '[{"id":"u1"}]');
    const got = api.getCurrentCachedUser();
    expect(Array.isArray(got), 'an array was returned as if it were a user').toBe(false);
  });
});
