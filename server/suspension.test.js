/**
 * The suspension predicate, and the guard that keeps it the only one.
 *
 * ── Why the guard matters more than the unit tests ──
 *
 * Suspension is enforced at exactly two places: `authenticateToken` in `utils.js`,
 * on every authenticated request, and the sign-in handler in `authRoutes.js`.
 * Before timed suspension both compared `account_status === 'suspended'` directly.
 *
 * Getting the date arithmetic wrong in one of them is not a symmetric mistake.
 * Miss it in sign-in and a student whose week is up cannot get back in — annoying,
 * visible, reported within a day. Miss it in `authenticateToken` and a suspended
 * person keeps a working session, which is silent and is the exact thing
 * suspension exists to prevent. So the rule is that neither file may re-implement
 * the question, and the last test here fails the build if either one does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { isSuspended, suspensionHasExpired, liftIfExpired } from './suspension.js';

const NOW = new Date('2026-08-06T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();

const row = (over = {}) => ({
  id: 'u_1', account_status: 'suspended', suspended_until: null, ...over,
});

describe('isSuspended', () => {
  it('is false for an account that was never suspended', () => {
    expect(isSuspended(row({ account_status: 'active' }), NOW)).toBe(false);
    expect(isSuspended(row({ account_status: 'deleted' }), NOW)).toBe(false);
  });

  it('is false for no row at all', () => {
    expect(isSuspended(null, NOW)).toBe(false);
    expect(isSuspended(undefined, NOW)).toBe(false);
  });

  it('is true with no deadline — indefinite stays indefinite', () => {
    expect(isSuspended(row({ suspended_until: null }), NOW)).toBe(true);
    // An empty string is not a deadline. Treated as absent rather than as
    // "expired at the epoch", which would release the account.
    expect(isSuspended(row({ suspended_until: '' }), NOW)).toBe(true);
  });

  it('is true while the deadline is in the future', () => {
    expect(isSuspended(row({ suspended_until: iso(60_000) }), NOW)).toBe(true);
  });

  it('is false once the deadline has passed', () => {
    expect(isSuspended(row({ suspended_until: iso(-1) }), NOW)).toBe(false);
  });

  /**
   * The boundary is exclusive: at exactly the deadline the suspension is over.
   * Stated as a test because the alternative — one more second of lockout — is
   * the sort of off-by-one nobody notices and a student experiences as the
   * platform not honouring what it told them.
   */
  it('treats the deadline instant itself as over', () => {
    expect(isSuspended(row({ suspended_until: NOW.toISOString() }), NOW)).toBe(false);
  });

  /**
   * FAILS CLOSED. Between "stays locked out until a human looks" and "quietly
   * un-suspended by a typo", only the first is recoverable — and the write path
   * refuses unparseable dates anyway, so reaching this means the row was written
   * by something other than the route.
   */
  it('keeps an account suspended when the deadline is unreadable', () => {
    for (const bad of ['next tuesday', 'soon', '2026-13-45', 'null']) {
      expect(isSuspended(row({ suspended_until: bad }), NOW), bad).toBe(true);
    }
  });
});

describe('suspensionHasExpired', () => {
  it('is true only for a timed suspension whose deadline has passed', () => {
    expect(suspensionHasExpired(row({ suspended_until: iso(-1) }), NOW)).toBe(true);
    expect(suspensionHasExpired(row({ suspended_until: iso(60_000) }), NOW)).toBe(false);
    // Indefinite never "expires" — there is nothing to have passed.
    expect(suspensionHasExpired(row({ suspended_until: null }), NOW)).toBe(false);
    expect(suspensionHasExpired(row({ account_status: 'active' }), NOW)).toBe(false);
  });
});

describe('liftIfExpired', () => {
  /** A stand-in for `db`, so this stays a unit test of the decision. */
  const fakeDb = () => {
    const calls = [];
    return {
      calls,
      prepare: () => ({ run: (...args) => calls.push(args) }),
    };
  };

  it('writes nothing when the suspension still applies', () => {
    for (const until of [null, iso(60_000), 'unreadable']) {
      const db = fakeDb();
      expect(liftIfExpired(db, row({ suspended_until: until }), NOW)).toBe(false);
      expect(db.calls.length, String(until)).toBe(0);
    }
  });

  it('lifts an expired suspension exactly once', () => {
    const db = fakeDb();
    expect(liftIfExpired(db, row({ suspended_until: iso(-1) }), NOW)).toBe(true);
    expect(db.calls).toEqual([[NOW.toISOString(), 'u_1']]);
  });
});

/**
 * Neither enforcement point may ask the question itself.
 *
 * A static guard rather than a behavioural one because the failure it prevents is
 * a SECOND definition of "suspended" appearing next to the first. That is invisible
 * in review — both lines look correct — and it only diverges later, when one of
 * them is updated.
 */
describe('one definition of suspended', () => {
  const ENFORCEMENT_POINTS = [
    ['server/utils.js', 'authenticateToken — governs every already-issued cookie'],
    ['server/routes/authRoutes.js', 'sign-in — governs getting a new one'],
  ];

  for (const [file, why] of ENFORCEMENT_POINTS) {
    it(`${file} asks isSuspended() rather than comparing the status string`, () => {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');

      // Comments legitimately discuss the old comparison, and this file's whole
      // point is that they explain why. Only code counts.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      expect(
        code,
        `${file} (${why}) compares account_status to 'suspended' directly. A timed `
        + 'suspension ends when its deadline passes, so a string comparison here is a '
        + 'second, wrong definition of suspended — import isSuspended from '
        + 'server/suspension.js instead.',
      ).not.toMatch(/account_status\s*===?\s*['"]suspended['"]/);

      expect(code, `${file} does not use the shared predicate at all`)
        .toMatch(/isSuspended\s*\(/);
    });
  }
});
