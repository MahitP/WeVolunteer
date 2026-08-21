/**
 * The suspension predicate, and the guard that keeps it the only one.
 *
 * ── Why the guard matters more than the unit tests ──
 *
 * Suspension is enforced at three doors: `authenticateToken` in `utils.js`, which
 * governs every already-issued cookie; the password sign-in in `authRoutes.js`; and
 * BOTH sign-in branches of `oauthRoutes.js`. Before timed suspension every one of
 * them compared `account_status === 'suspended'` directly.
 *
 * Getting it wrong is not symmetric, and each door fails its own way:
 *
 *   - `authenticateToken` — a suspended person keeps a working session. Silent, and
 *     the exact thing suspension exists to prevent.
 *   - password sign-in — somebody whose week is up cannot get back in. Visible, and
 *     reported within a day.
 *   - provider sign-in — the same lockout, except a provider-only account has no
 *     other door, so it is permanent rather than annoying.
 *
 * The third was missed by the first version of this file, which listed the two the
 * author happened to know about. It derives the list now — see the guard below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
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

  it('writes nothing when the suspension still applies', async () => {
    for (const until of [null, iso(60_000), 'unreadable']) {
      const db = fakeDb();
      expect(await liftIfExpired(db, row({ suspended_until: until }), NOW)).toBe(false);
      expect(db.calls.length, String(until)).toBe(0);
    }
  });

  it('lifts an expired suspension exactly once', async () => {
    const db = fakeDb();
    expect(await liftIfExpired(db, row({ suspended_until: iso(-1) }), NOW)).toBe(true);
    expect(db.calls).toEqual([[NOW.toISOString(), 'u_1']]);
  });
});

/**
 * ── Why this scans the whole tree instead of naming the files ──
 *
 * The first version of this guard listed two enforcement points, `utils.js` and
 * `authRoutes.js`, because those were the two the author knew about. There was a
 * third: `oauthRoutes.js` refuses a suspended account on both of its sign-in
 * branches, and it compared the status string.
 *
 * The consequence was the worst instance of the whole class. A timed suspension
 * ends when its deadline passes but `account_status` stays 'suspended' until
 * something lifts it, and the OAuth path never did — so a student suspended for a
 * week and signing in with Google was refused after their week was up, and for a
 * provider-only account there is no password path to fall back on. Not a delay: a
 * permanent lockout from an account whose sanction had already expired, with
 * nothing on screen to explain it.
 *
 * A hand-written list of enforcement points is a guard that covers the files
 * somebody remembered. The lesson is the same one `providers.completeness.test.js`
 * and `config.oauthProviders.test.js` record about the OAuth provider list, and
 * `errorStyles.test.js` about its animated classes: derive the subject, do not
 * enumerate it.
 */
describe('one definition of suspended', () => {
  const SERVER = path.join(process.cwd(), 'server');

  /** Every shipped server module, recursively. */
  function sourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'scratch') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { out.push(...sourceFiles(full)); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name.includes('.test.')) continue;
      out.push(full);
    }
    return out;
  }

  /**
   * Files allowed to compare the string, with the reason each is not a
   * suspension DECISION. Keyed by repo-relative path; a stale entry fails below,
   * so an exemption cannot outlive the code it was written for.
   */
  const ALLOWED = {
    /**
     * The `already_suspended` conflict check, and it must read the RAW column.
     *
     * `isSuspended` would answer false for a suspension whose deadline has passed
     * but whose row has not been normalised yet, so a second suspension would be
     * accepted and would overwrite `suspension_reason` — destroying the record of
     * why the first one happened, which is the thing `routes.suspension.test.js`
     * already pins ("the original reason must survive"). "Is there a suspension on
     * this row" and "is this person suspended right now" are genuinely different
     * questions, and this is the first one.
     */
    'server/routes/adminRoutes.js': 'refuses a second suspension by reading the stored '
      + 'column, which is deliberately not the same question as isSuspended()',
    'server/suspension.js': 'this is where the definition lives',
  };

  const offenders = [];
  const seen = new Set();

  for (const full of sourceFiles(SERVER)) {
    const rel = path.relative(process.cwd(), full).split(path.sep).join('/');
    const source = readFileSync(full, 'utf8');

    // Comments legitimately discuss the old comparison — several of them exist to
    // explain why it is wrong. Only code counts.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (!/account_status\s*===?\s*['"]suspended['"]/.test(code)) continue;

    seen.add(rel);
    if (!ALLOWED[rel]) offenders.push(rel);
  }

  it('no server module decides suspension by comparing the status string', () => {
    expect(
      offenders,
      'These files compare account_status to \'suspended\' directly. A timed '
      + 'suspension ends when its deadline passes, so a string comparison is a '
      + 'second — and wrong — definition of suspended: it refuses somebody whose '
      + 'sanction has already expired, and on a provider-only account that is a '
      + 'permanent lockout. Import isSuspended from server/suspension.js, or add the '
      + 'file to ALLOWED with the reason it is not a suspension decision.',
    ).toEqual([]);
  });

  it('has no stale exemptions', () => {
    // An exemption for a file that no longer compares the string is an exemption
    // nobody has re-read, and it would silently cover a comparison added later.
    const stale = Object.keys(ALLOWED).filter(f => !seen.has(f));
    expect(stale, 'ALLOWED entries that no longer match anything — remove them')
      .toEqual([]);
  });

  /**
   * The three doors, asserted positively. The negative check above passes for a
   * file that stopped enforcing suspension at all, which is the other way to get
   * this wrong.
   */
  it.each([
    ['server/utils.js', 'authenticateToken — governs every already-issued cookie'],
    ['server/routes/authRoutes.js', 'password sign-in — governs getting a new one'],
    ['server/routes/oauthRoutes.js', 'provider sign-in — the only door for a provider-only account'],
  ])('%s asks the shared predicate', (file) => {
    const code = readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(code, `${file} does not use isSuspended() at all`).toMatch(/isSuspended\s*\(/);
  });
});
