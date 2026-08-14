import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADDRESSES,
  AUTH_FLOWS,
  BRAND,
  MAIL_DOMAIN,
  identityFor,
  categoryForEvent,
} from './emailIdentity.js';

/**
 * Who every message says it is from.
 *
 * ── The rule this file exists to hold ──
 *
 * Every authentication message leaves from `noreply@wevolunteers.org`, displayed
 * as `WeVolunteer`. Verification, password reset, email change in both
 * directions, the login 2FA code, the admin invitation, the notice that a
 * recovery code was spent.
 *
 * The failure it prevents is quiet and total. Authentication mail is the mail a
 * domain's SPF, DKIM and DMARC records are configured for and that recipients'
 * filters are trained on. A password-reset message sent from an address the
 * domain never authorised does not bounce — it lands in spam, for exactly the
 * population that cannot work around it, and nothing in any log says so. Nobody
 * reports "my reset email went to junk"; they report "the site is broken", and
 * they report it to nobody.
 *
 * ── Why the whole matrix is asserted and not just the auth rule ──
 *
 * The previous behaviour was ONE address for everything, defaulting to
 * `noreply@wevolunteer.org` — singular, a domain one character off the one this
 * platform sends as. The fix is not "make it all noreply"; it is that the sender
 * describes the message. A suspension notice and a shift reminder should not be
 * indistinguishable in an inbox, and a reply to one of them should reach
 * somebody.
 */

describe('the address book', () => {
  it('is on the domain the platform actually sends as', () => {
    /* The plural. `wevolunteer.org` and `wevolunteers.org` are different
       domains, and the repo was full of the one nobody owns. */
    expect(MAIL_DOMAIN).toBe('wevolunteers.org');
    for (const [name, address] of Object.entries(ADDRESSES)) {
      expect(address, `${name} is not on the sending domain`).toMatch(/@wevolunteers\.org$/);
    }
  });

  it('has every official address, and no personal Gmail among them', () => {
    expect(Object.values(ADDRESSES).sort()).toEqual([
      'admin@wevolunteers.org',
      'contact@wevolunteers.org',
      'legal@wevolunteers.org',
      'mahit@wevolunteers.org',
      'noreply@wevolunteers.org',
      'platform@wevolunteers.org',
      'privacy@wevolunteers.org',
      'security@wevolunteers.org',
      'support@wevolunteers.org',
    ]);
  });
});

describe('authentication mail', () => {
  for (const flow of AUTH_FLOWS) {
    it(`"${flow}" is sent from noreply, as WeVolunteer`, () => {
      const { from, category } = identityFor(flow);
      expect(category).toBe('auth');
      expect(from).toBe(`"${BRAND}" <${ADDRESSES.noreply}>`);
    });

    it(`"${flow}" sets no Reply-To`, () => {
      /**
       * Deliberate, not an oversight. A reply to any of these carries a live
       * credential — a login code, a single-use reset link — and a Reply-To
       * would deliver it into a shared mailbox with a far longer life than the
       * token was designed to have. The body says where to get help instead.
       */
      expect(identityFor(flow).replyTo).toBeNull();
    });
  }

  it('covers every flow that actually authenticates', () => {
    /* A flow missing from this set gets the notification identity and ships
       from the wrong address — which is the whole failure mode. */
    for (const flow of [
      'verification', 'password-reset', 'email-change-confirm',
      'email-change-notice', '2fa-code', 'admin-invitation', 'recovery-code-used',
    ]) {
      expect(AUTH_FLOWS.has(flow), `${flow} is not treated as authentication mail`).toBe(true);
    }
  });

  it('refuses to hand an auth flow a non-noreply sender', () => {
    /**
     * The guard, exercised directly. `identityFor` throws rather than returning
     * a wrong answer, because the wrong answer is invisible until deliverability
     * has already been spent.
     */
    /* A contradiction — an authentication flow carrying an enforcement event —
       is refused rather than silently resolved. Either answer would be wrong,
       and a wrong sender on a password reset is not something to guess at. */
    expect(() => identityFor('verification', { event: 'ACCOUNT_SUSPENDED' }))
      .toThrow(/authentication flow/i);

    /* RECOVERY_CODE_USED arrives through the notification outbox but is an
       authentication event, and must not inherit the notification identity. */
    expect(categoryForEvent('RECOVERY_CODE_USED')).toBe('auth');
    expect(identityFor('notification-direct', { event: 'RECOVERY_CODE_USED' }).from)
      .toBe(`"${BRAND}" <${ADDRESSES.noreply}>`);
  });
});

describe('everything else is sent as what it is', () => {
  const cases = [
    ['notification', null, ADDRESSES.contact, ADDRESSES.support],
    ['error-alert', null, ADDRESSES.platform, ADDRESSES.platform],
    [null, 'ACCOUNT_SUSPENDED', ADDRESSES.admin, ADDRESSES.admin],
    [null, 'ORGANIZATION_BANNED', ADDRESSES.admin, ADDRESSES.admin],
    [null, 'APPEAL_DECISION_STANDS', ADDRESSES.admin, ADDRESSES.admin],
    [null, 'LEGAL_DOCUMENT_UPDATED', ADDRESSES.legal, ADDRESSES.legal],
    [null, 'EVENT_REMINDER_2H', ADDRESSES.contact, ADDRESSES.support],
    [null, 'APPLICATION_ACCEPTED', ADDRESSES.contact, ADDRESSES.support],
  ];

  for (const [flow, event, from, replyTo] of cases) {
    it(`${event || flow} comes from ${from}`, () => {
      const id = identityFor(flow || 'notification-direct', event ? { event } : undefined);
      expect(id.from).toContain(from);
      expect(id.replyTo).toBe(replyTo);
    });
  }

  it('does not make everything noreply', () => {
    /* The opposite failure. `noreply@` on a suspension notice tells somebody
       contesting a decision about their account that there is nobody to write
       to — which on this platform is not true, and is the one moment it matters
       most that it is not. */
    const enforcement = identityFor('notification-direct', { event: 'ACCOUNT_SUSPENDED' });
    expect(enforcement.from).not.toContain(ADDRESSES.noreply);
    expect(enforcement.replyTo).toBeTruthy();
  });

  it('reserves the owner address for a named human', () => {
    /* An automated message signed by a person is a small lie, and it costs
       trust the moment the recipient replies and gets silence. */
    const owner = identityFor('owner');
    expect(owner.from).toContain(ADDRESSES.owner);
    expect(owner.from).toContain('Mahit Pulavarthi');

    const automated = [...AUTH_FLOWS, 'notification-direct', 'error-alert'];
    for (const flow of automated) {
      expect(identityFor(flow).from, `${flow} sends as a person`).not.toContain(ADDRESSES.owner);
    }
  });
});

describe('the From header is well formed', () => {
  it('quotes the display name so a comma cannot split the header', () => {
    /* An unquoted display name containing a comma is parsed as two addresses,
       and the message either bounces or goes somewhere unintended. */
    expect(identityFor('verification').from).toBe(`"WeVolunteer" <noreply@wevolunteers.org>`);
    expect(identityFor('verification').from).toMatch(/^"[^"]+" <[^@]+@[^>]+>$/);
  });
});

describe('no send path still carries the old identity', () => {
  /**
   * A source scan, because the failure is a string that was missed rather than a
   * behaviour that can be called. The old default was `noreply@wevolunteer.org`
   * — singular — and it appeared in two separate places in email.js alone, one
   * of which had already survived a previous removal of the other.
   */
  const read = (rel) => fs.readFileSync(path.join(process.cwd(), 'server', rel), 'utf8');

  for (const file of [
    'email.js',
    'emailService.js',
    'emailProviders.js',
    'emailIdentity.js',
    'workers/notificationWorker.js',
    'services/notificationContent.js',
    'routes/geocodeRoutes.js',
    'routes/weatherRoutes.js',
    'routes/travelRoutes.js',
  ]) {
    it(`${file} names no retired domain`, () => {
      const src = read(file).replace(/^\s*\*.*$/gm, '');  // prose in block comments may cite it
      expect(src, 'the singular wevolunteer.org survives').not.toMatch(/@wevolunteer\.org/);
      expect(src, 'wevolunteer.app survives').not.toMatch(/wevolunteer\.app/);
      expect(src, 'a personal Gmail address survives').not.toMatch(/wevolunteer\.platform@gmail\.com/);
    });
  }
});
