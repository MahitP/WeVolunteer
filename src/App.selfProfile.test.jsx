import { describe, it, expect } from 'vitest';
import { selfProfileFor } from './App';

/**
 * Which profile page an account gets.
 *
 * ── The defect this closes ──
 *
 * The rule was a most-privileged-first cascade, which is right for an account
 * that only administers and wrong for one that administers AND volunteers. The
 * platform owner is deliberately both, and the cascade sent them to
 * `AccountProfile` — a total and nothing else: no badges, no milestones, no
 * service record, no certificates. Their own record was the one record the
 * product would not show them.
 *
 * The fix names no person and no role. It reads a capability and a number.
 */

/**
 * A session payload, shaped the way `can()` reads one — a role, not a list of
 * capabilities. A first draft passed `capabilities: [...]`, which `can()`
 * ignores entirely, so every case resolved against an empty role and the whole
 * file was measuring nothing.
 */
const USER = (role, hours = 0) => ({ id: 'u1', role, volunteeredHours: hours });

describe('an account that only administers', () => {
  it('gets the account page', () => {
    expect(selfProfileFor(USER('admin'))).toBe('account');
  });

  it('still gets the account page when it holds a portfolio capability but has served nothing', () => {
    /* A fresh owner has no service record to show. Sending them to a page
       about shifts they have not worked would be an empty room. */
    expect(selfProfileFor(USER('super_admin', 0))).toBe('account');
  });
});

describe('an account that administers AND volunteers', () => {
  it('gets the volunteer page', () => {
    /* The whole point: privilege must not decide whether somebody sees their
       own service record. */
    expect(selfProfileFor(USER('super_admin', 12.5))).toBe('volunteer');
  });

  it('does so by capability and hours, never by name or role', () => {
    /* `profileSerializer.leakage.test.js` asserts the owner distinction is a
       pure function of role and never of a name. This rule must not
       reintroduce the thing that test forbids. */
    expect(selfProfileFor({ id: 'nobody', role: 'student', volunteeredHours: 3 })).toBe('volunteer');
    expect(selfProfileFor({ id: 'x', name: 'Mahit', role: 'student', volunteeredHours: 0 })).toBe('volunteer');
  });
});

describe('the ordinary roles are unchanged', () => {
  it('a student gets the volunteer page', () => {
    expect(selfProfileFor(USER('student', 4))).toBe('volunteer');
  });

  it('a student with no hours yet still gets the volunteer page', () => {
    /* They hold no administrative capability, so the cascade reaches
       `portfolio.write` on its own. */
    expect(selfProfileFor(USER('student', 0))).toBe('volunteer');
  });

  it('an organizer gets the host page', () => {
    expect(selfProfileFor(USER('organizer', 0))).toBe('host');
  });

  it('an organizer keeps the host page even with hours against their name', () => {
    /**
     * Not an oversight — organizers do not hold `portfolio.write`; only
     * students and the owner do. So the rule cannot fire for them, and that is
     * correct: an organizer's profile is their track record of running events,
     * and the hours they accrue are shown there rather than on a page about
     * shifts they signed up for.
     *
     * Asserted because a well-meaning edit that granted organizers
     * `portfolio.write` would silently move every organizer's profile.
     */
    expect(selfProfileFor(USER('organizer', 9))).toBe('host');
  });

  it('a partner gets the account page', () => {
    expect(selfProfileFor(USER('partner', 0))).toBe('account');
  });

  it('an account with nothing gets nothing', () => {
    expect(selfProfileFor(USER('nosuchrole', 0))).toBe('denied');
  });
});

describe('bad data cannot promote anybody', () => {
  it('treats a non-numeric hour count as no service', () => {
    expect(selfProfileFor({ id: 'u1', role: 'super_admin', volunteeredHours: 'lots' })).toBe('account');
  });

  it('survives a missing user', () => {
    expect(selfProfileFor(undefined)).toBe('denied');
  });
});
