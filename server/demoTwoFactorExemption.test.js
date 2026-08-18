import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * The demo administrator's two-factor exemption, and the walls around it.
 *
 * ── Why it exists ──
 *
 * `db.js` seeds a demo administrator as `admin@example.gov` — an address nobody
 * can receive mail at. That account was enrolled in EMAIL two-factor, so signing
 * in required a code delivered to a mailbox that does not exist, and the one
 * account a developer needs in order to see the administrative surfaces could not
 * be used at all.
 *
 * ── What this file is actually guarding ──
 *
 * Not the feature. The BLAST RADIUS. An exemption is a backdoor if it is one
 * character wider than intended, so every case below is an attempt to reach it
 * from somewhere it must not work: a real account, an owner, a lookalike address,
 * a non-demo process.
 *
 * `secondFactorRequiredFor` is a pure function of its arguments plus two
 * module-scope constants, so this tests it directly rather than through HTTP —
 * the questions here are about the predicate, and a route test would prove less
 * while running a server.
 */

const DEMO_ADMIN = { role: 'admin', email: 'admin@example.gov' };

/**
 * Imports `utils.js` with a given environment.
 *
 * `DEMO_MODE` and `REQUIRE_ADMIN_2FA` are resolved by `config.js` at module scope,
 * so the environment has to be set before the first import and the registry reset
 * between cases. `vitest.config.js` pins `isolate: true`, so this file's module
 * graph is its own.
 */
async function load({ demo = true, require2fa = true } = {}) {
  vi.resetModules();
  process.env.DEMO_MODE = demo ? 'true' : 'false';
  process.env.REQUIRE_ADMIN_2FA = require2fa ? 'true' : 'false';
  process.env.WEV_DB_PATH = ':memory:';
  const { secondFactorRequiredFor } = await import('./utils.js');
  return secondFactorRequiredFor;
}

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env.DEMO_MODE = ORIGINAL.DEMO_MODE;
  process.env.REQUIRE_ADMIN_2FA = ORIGINAL.REQUIRE_ADMIN_2FA;
  process.env.WEV_DB_PATH = ORIGINAL.WEV_DB_PATH;
  vi.resetModules();
});

describe('the demo administrator is exempt from two-factor', () => {
  it('does not require a second factor in a demo process', async () => {
    const required = await load({ demo: true });
    expect(required('admin', DEMO_ADMIN)).toBe(false);
  });

  /**
   * The exemption needs the account, not just the role.
   *
   * A caller that has only a role string gets the plain policy — the safe
   * direction to fail, and the reason the second parameter is optional rather
   * than required.
   */
  it('still requires one when the caller supplies no account', async () => {
    const required = await load({ demo: true });
    expect(required('admin')).toBe(true);
    expect(required('admin', null)).toBe(true);
  });
});

describe('the exemption cannot reach anything else', () => {
  /**
   * The case that matters most. `server.js` refuses to boot when
   * `IS_PRODUCTION && DEMO_MODE`, so this branch does not exist in production at
   * all — but the predicate is asserted directly so the guarantee does not rest
   * on a boot check in a different file.
   */
  it('does nothing in a process that is not a demo', async () => {
    const required = await load({ demo: false });
    expect(required('admin', DEMO_ADMIN)).toBe(true);
  });

  /**
   * An owner is never exempt, even in a demo and even at the exempt address.
   *
   * `db.js` already refuses to boot a demo database containing a `super_admin`,
   * so this is a second lock on a bolted door — which is the right number of
   * locks for the account that can do everything.
   */
  it('never exempts an owner', async () => {
    const required = await load({ demo: true });
    expect(required('super_admin', { role: 'super_admin', email: 'admin@example.gov' })).toBe(true);
  });

  /** One address, matched exactly — not a pattern, not a domain, not a prefix. */
  it.each([
    'admin@example.gov.attacker.test',
    'notadmin@example.gov',
    'admin@example.gov ',
    'admin@example.govv',
    'admin@example.com',
    'not.the.owner@example.com',
    'wevolunteer.platform@gmail.com',
  ])('does not exempt %s', async (email) => {
    const required = await load({ demo: true });
    expect(required('admin', { role: 'admin', email })).toBe(true);
  });

  it('is not confused by a missing or non-string address', async () => {
    const required = await load({ demo: true });
    for (const email of [undefined, null, 42, {}, []]) {
      expect(required('admin', { role: 'admin', email })).toBe(true);
    }
  });

  /** Case-insensitive on the address, because addresses are compared that way
   *  everywhere else — this is a convenience, not a widening. */
  it('matches the address case-insensitively', async () => {
    const required = await load({ demo: true });
    expect(required('admin', { role: 'admin', email: 'Admin@Example.GOV' })).toBe(false);
  });
});

describe('it does not disturb the policy it sits inside', () => {
  it('leaves ordinary roles unaffected', async () => {
    const required = await load({ demo: true });
    for (const role of ['student', 'organizer', 'partner']) {
      /* These never required a second factor in the first place. */
      expect(required(role, { role, email: 'someone@school.org' })).toBe(false);
    }
  });

  it('still requires one for a non-demo administrator in a demo process', async () => {
    const required = await load({ demo: true });
    expect(required('admin', { role: 'admin', email: 'realadmin@district.org' })).toBe(true);
  });

  /**
   * `REQUIRE_ADMIN_2FA=false` remains the separate, louder switch.
   *
   * The exemption is one fixture; the flag is the whole policy, and production
   * refuses to boot with it off. Neither should be mistaken for the other.
   */
  it('is not the same thing as turning the policy off', async () => {
    const required = await load({ demo: true, require2fa: false });
    expect(required('admin', { role: 'admin', email: 'realadmin@district.org' })).toBe(false);
  });
});
