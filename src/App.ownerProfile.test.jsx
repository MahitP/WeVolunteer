import { describe, it, expect } from 'vitest';
import { selfProfileFor, PAGE_META, tabForPath, pageMetaFor } from './App.jsx';

/**
 * Holding the platform is not a reason to stop being a volunteer.
 *
 * ── What this file is about ──
 *
 * The person who runs WeVolunteer is a high-school student who volunteers. Their
 * hours, badges and service record are real and belong on their profile exactly
 * as anybody else's do. The owner status is additive — a pill on the page — and
 * must not replace the page.
 *
 * ── The bug it caught ──
 *
 * `/profile` picks its BODY with `selfProfileFor` and its CHROME with
 * `personaFor`, and those two disagree by design for an account that both holds
 * administrative capability and has volunteered. `selfProfileFor` sends the
 * owner to `VolunteerProfile`; `PAGE_META` was keyed on persona, so the heading
 * came from the `staff` block. The result was a page of service hours,
 * milestones and a Silver Award meter captioned "Your account on this platform".
 *
 * Nothing here matches a username or an email. The whole point is that the
 * behaviour follows capability and volunteer history, so an account changing
 * hands needs no edit — and a test that named Mahit would be the same
 * hard-coding the production rule forbids.
 */

/** A super_admin holds `*`, so capability checks pass for everything. */
const owner = (over = {}) => ({ id: 'u-owner', role: 'super_admin', ...over });
const student = (over = {}) => ({ id: 'u-stu', role: 'student', ...over });
const organizer = (over = {}) => ({ id: 'u-org', role: 'organizer', ...over });
const partner = (over = {}) => ({ id: 'u-par', role: 'partner', ...over });

describe('the owner sees a volunteer profile when they have volunteered', () => {
  it('routes an owner WITH hours to the volunteer profile', () => {
    /* The requirement in one line. A super_admin who volunteers gets the
       student presentation, not an admin-style account page. */
    expect(selfProfileFor(owner({ volunteeredHours: 520 }))).toBe('volunteer');
  });

  it('routes a student with the same hours to the same place', () => {
    /* The comparison that makes the previous assertion mean something: the
       owner is treated as a volunteer, not merely sent somewhere. */
    expect(selfProfileFor(student({ volunteeredHours: 520 })))
      .toBe(selfProfileFor(owner({ volunteeredHours: 520 })));
  });

  it('still routes an owner with NO volunteer history to the account page', () => {
    /**
     * The other half, and the reason this is history-driven rather than
     * role-driven: an owner who has never volunteered has no service record to
     * show, and a volunteer profile of zeroes reads as data rather than as
     * absence.
     */
    expect(selfProfileFor(owner({ volunteeredHours: 0 }))).toBe('account');
  });

  it('does not decide any of this from a name or an email', () => {
    /**
     * Same account, renamed. If the answer moved, something matched an
     * identity rather than a capability — which is exactly what the production
     * rule forbids.
     */
    const a = selfProfileFor(owner({ volunteeredHours: 520, name: 'Mahit Pulavarthi', email: 'mahitp.16@gmail.com', username: 'mahit' }));
    const b = selfProfileFor(owner({ volunteeredHours: 520, name: 'Someone Else', email: 'other@example.org', username: 'someone' }));
    expect(a).toBe(b);
    expect(a).toBe('volunteer');
  });
});

describe('the page chrome describes the profile that is rendered', () => {
  /**
   * The shell's OWN function, not a copy of its rule.
   *
   * An earlier version of this file re-implemented the persona lookup here,
   * which would have passed happily while `App.jsx` did something else. The
   * path goes through `tabForPath` too, so a route that stopped resolving to
   * the profile tab is caught rather than assumed.
   */
  const metaFor = (user) => pageMetaFor(user, tabForPath('/profile'));

  it('titles the owner volunteer profile as a service record, not an account', () => {
    /**
     * The bug, stated as the reader met it. `staff.profile.sub` is "Your account
     * on this platform"; the body underneath is a service record.
     */
    const meta = metaFor(owner({ volunteeredHours: 520 }));
    expect(meta.sub).toBe(PAGE_META.volunteer.profile.sub);
    expect(meta.sub).not.toBe(PAGE_META.staff.profile.sub);
  });

  it('gives the owner and a student the identical profile caption', () => {
    expect(metaFor(owner({ volunteeredHours: 520 })))
      .toEqual(metaFor(student({ volunteeredHours: 520 })));
  });

  it('leaves an owner with no hours reading as an account, which is what renders', () => {
    /* Not over-corrected: where the persona lookup was already right, it stays.
       The body here IS `AccountProfile`. */
    expect(metaFor(owner({ volunteeredHours: 0 })).sub).toBe(PAGE_META.staff.profile.sub);
  });

  it('leaves the profile caption of every other persona alone', () => {
    expect(metaFor(student({ volunteeredHours: 12 })).sub).toBe(PAGE_META.volunteer.profile.sub);
    expect(metaFor(organizer({ volunteeredHours: 0 })).sub).toBe(PAGE_META.host.profile.sub);
    expect(metaFor(partner({ volunteeredHours: 0 })).sub).toBe(PAGE_META.partner.profile.sub);
  });

  it('describes every profile it can render, so none falls back to a bare app name', () => {
    /* A missing entry renders `{ title: APP_NAME, sub: '' }` — a page headed
       "WeVolunteer" with no subtitle, which looks deliberate and is not. */
    for (const user of [owner({ volunteeredHours: 520 }), owner({ volunteeredHours: 0 }),
      student({ volunteeredHours: 3 }), organizer(), partner()]) {
      const meta = metaFor(user);
      expect(meta, `no profile meta for role ${user.role}`).toBeTruthy();
      expect(meta.title).toBe('Profile');
    }
  });
});
