import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  rememberPendingInvite, peekPendingInvite, consumePendingRedirect,
  inviteTokenFor, clearPendingInvite,
} from './pendingInvite';

/**
 * The invitation somebody was holding when they were sent to sign in.
 *
 * ── The property that makes this safe, asserted first ──
 *
 * This is NOT a `returnTo`. What it stores is a slug the server produced, and
 * `App.jsx` interpolates it into a fixed `/organizations/` prefix. So the tests
 * that matter most are the ones proving nothing else can get in: a value that is
 * not a plausible slug, or a token that is not 64 hex characters, is refused at
 * the door rather than validated later by whoever reads it.
 *
 * ── And the property that makes it not break a signup ──
 *
 * `sessionStorage` does not merely return null in a private window or with site
 * data blocked — reading the accessor itself throws. Every function here has to
 * degrade to "no pending invitation", never to an exception inside a sign-in
 * flow, which is why the throwing case is exercised rather than assumed.
 */

const SLUG = 'chess-club';
const TOKEN = 'a'.repeat(64);

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('remembering an invitation', () => {
  it('stores a slug and a token and reads them back', () => {
    expect(rememberPendingInvite({ slug: SLUG, token: TOKEN, name: 'Chess Club' })).toBe(true);
    expect(peekPendingInvite()).toMatchObject({ slug: SLUG, token: TOKEN, name: 'Chess Club' });
  });

  it('stores a slug with no token, for a club anybody can join', () => {
    expect(rememberPendingInvite({ slug: SLUG })).toBe(true);
    expect(peekPendingInvite().slug).toBe(SLUG);
    expect(inviteTokenFor(SLUG)).toBeNull();
  });

  it.each([
    ['no slug', {}],
    ['an empty slug', { slug: '' }],
    ['a non-string slug', { slug: 42 }],
    ['an absurdly long slug', { slug: 'x'.repeat(500) }],
    ['a token that is not hex', { slug: SLUG, token: 'z'.repeat(64) }],
    ['a token of the wrong length', { slug: SLUG, token: 'abc' }],
    ['an upper-case token', { slug: SLUG, token: 'A'.repeat(64) }],
    ['a non-string token', { slug: SLUG, token: 12345 }],
  ])('refuses %s', (_label, value) => {
    expect(rememberPendingInvite(value)).toBe(false);
    expect(peekPendingInvite()).toBeNull();
  });

  it('refuses nothing at all without throwing', () => {
    expect(rememberPendingInvite()).toBe(false);
    expect(peekPendingInvite()).toBeNull();
  });
});

describe('the redirect after signing in', () => {
  it('is offered once, and then not again', () => {
    rememberPendingInvite({ slug: SLUG, token: TOKEN });
    expect(consumePendingRedirect()).toMatchObject({ slug: SLUG });
    /* A second sign-in in the same tab lands on the dashboard like any other. */
    expect(consumePendingRedirect()).toBeNull();
  });

  /**
   * The token survives the redirect being spent.
   *
   * Two consumers need this entry at different moments: signing in needs to
   * know WHERE to go, and the organization page then needs the TOKEN so its Join
   * press carries it. Deleting on redirect would serve the first and starve the
   * second.
   */
  it('leaves the token readable for the page it redirected to', () => {
    rememberPendingInvite({ slug: SLUG, token: TOKEN });
    consumePendingRedirect();
    expect(inviteTokenFor(SLUG)).toBe(TOKEN);
  });

  it('offers nothing when nothing was remembered', () => {
    expect(consumePendingRedirect()).toBeNull();
  });
});

describe('the token for one club', () => {
  it('is given only for the club it was stored against', () => {
    rememberPendingInvite({ slug: SLUG, token: TOKEN });
    expect(inviteTokenFor(SLUG)).toBe(TOKEN);
    /* `/organizations/:key` accepts an id as well as a slug, so a token stored
       against one club must not be handed to a page showing another. */
    expect(inviteTokenFor('robotics')).toBeNull();
    expect(inviteTokenFor('org-1')).toBeNull();
    expect(inviteTokenFor(undefined)).toBeNull();
  });

  it('is gone once cleared', () => {
    rememberPendingInvite({ slug: SLUG, token: TOKEN });
    clearPendingInvite();
    expect(inviteTokenFor(SLUG)).toBeNull();
    expect(peekPendingInvite()).toBeNull();
  });
});

describe('when the browser will not let us store anything', () => {
  /**
   * A private window, blocked site data, or a full quota.
   *
   * The reads must answer "no pending invitation" and the write must answer
   * false. Nothing here may throw, because every caller is inside a sign-in or a
   * page load: losing the destination is acceptable, and losing the sign-in is
   * not.
   */
  const breakStorage = () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
  };

  it('reports a failed write rather than throwing', () => {
    breakStorage();
    expect(() => rememberPendingInvite({ slug: SLUG, token: TOKEN })).not.toThrow();
    expect(rememberPendingInvite({ slug: SLUG, token: TOKEN })).toBe(false);
  });

  it('reads as empty rather than throwing', () => {
    breakStorage();
    expect(peekPendingInvite()).toBeNull();
    expect(consumePendingRedirect()).toBeNull();
    expect(inviteTokenFor(SLUG)).toBeNull();
    expect(() => clearPendingInvite()).not.toThrow();
  });
});

describe('a corrupted entry', () => {
  it('is ignored rather than acted on', () => {
    sessionStorage.setItem('wev_pending_invite', 'not json at all');
    expect(peekPendingInvite()).toBeNull();
    expect(consumePendingRedirect()).toBeNull();
  });

  it('is ignored when it is valid JSON of the wrong shape', () => {
    sessionStorage.setItem('wev_pending_invite', JSON.stringify({ url: 'https://evil.example/' }));
    expect(peekPendingInvite()).toBeNull();
    expect(consumePendingRedirect()).toBeNull();
  });
});
