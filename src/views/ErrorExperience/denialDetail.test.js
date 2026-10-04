/**
 * The factual half of a permission refusal.
 *
 * ── What this is protecting ──
 *
 * Every 403 read identically no matter what the reader had tried to open. "Limited
 * to certain accounts" is true and useless: it names neither the feature, nor why
 * this account is not one of them, nor who could change that.
 *
 * The two cases worth pinning are the ones where saying the obvious thing would be
 * WRONG:
 *
 *   1. An unapproved organizer holds `event.create` and is still refused
 *      `/events/new`. Reporting the capability tells them they lack a permission
 *      they actually have, and sends them to ask for something they already hold.
 *   2. `error.read` is SUPER_ONLY, so no grant can reach it. Telling somebody an
 *      administrator can help is simply false.
 */
import { describe, it, expect } from 'vitest';
import { denialDetail, FEATURE_NAMES } from './denialDetail';
import { APP_ROUTES } from '../../routes/index.jsx';
import { ALL_CAPABILITIES, SUPER_ONLY } from '../../authz';

describe('denialDetail', () => {
  it('is null when there is no matched route to describe', () => {
    expect(denialDetail(null)).toBe(null);
    expect(denialDetail(undefined)).toBe(null);
    // A route with no condition was not refused for a capability reason.
    expect(denialDetail({ path: '/notifications' })).toBe(null);
  });

  it('names the feature, the reason and who can grant it', () => {
    const detail = denialDetail({ path: '/messages', requiredCap: 'message.send' });
    expect(detail.feature).toBe('messages');
    expect(detail.reason).toContain('does not have permission for messages');
    expect(detail.remedy).toMatch(/administrator can grant it/);
  });

  /**
   * The ordering case. `deniedRoute()` tests `requiresVerified` first for the same
   * reason, and disagreeing with it here would explain the refusal wrongly.
   */
  it('reports pending approval rather than a capability the account already holds', () => {
    const detail = denialDetail({
      path: '/events/new', requiredCap: 'event.create', requiresVerified: true,
    });
    expect(detail.reason).toMatch(/has not been approved yet/);
    expect(detail.reason).not.toMatch(/permission/);
    expect(detail.remedy).toMatch(/reviews new organizer requests/);
  });

  /**
   * Approved, but the agreement is not accepted yet (Phase 5 walk, 2026-10-04).
   *
   * A newly approved organizer pressed "New event" and was told their account
   * "has not been approved yet" and that "nothing else is needed" — both false.
   * It was approved; what was missing was the Organizer Agreement, and that page
   * was the one thing the refusal never mentioned. `deniedRoute()` now says WHY
   * it refused (`because`), and the role, so the refusal can name the document.
   */
  describe('a capability paused until an agreement is accepted', () => {
    const route = { path: '/events/new', requiredCap: 'event.create', requiresVerified: true };

    it('names the agreement, links to it, and promises no administrator', () => {
      const detail = denialDetail({ ...route, because: 'withheld', role: 'organizer' });
      expect(detail.reason).not.toMatch(/approved/);
      expect(detail.reason).toMatch(/Organizer Agreement/);
      expect(detail.action).toEqual({ to: '/organizer-agreement', label: 'Read the Organizer Agreement' });
      expect(detail.grantable).toBe(false);
    });

    it('sends a student organizer and an administrator to their own documents', () => {
      expect(denialDetail({ requiredCap: 'attendance.mark', because: 'withheld', role: 'student' }).action.to)
        .toBe('/student-organizer-agreement');
      for (const role of ['admin', 'super_admin']) {
        const detail = denialDetail({ requiredCap: 'report.resolve', because: 'withheld', role });
        expect(detail.reason).toMatch(/Admin Responsibilities Policy/);
        expect(detail.action.to).toBe('/admin');
      }
    });

    it('still reports pending approval when that is the reason', () => {
      expect(denialDetail({ ...route, because: 'unverified', role: 'organizer' }).reason)
        .toMatch(/has not been approved yet/);
    });
  });

  it('does not promise a grant for a capability no grant can reach', () => {
    const detail = denialDetail({ path: '/errors', requiredCap: 'error.read' });
    expect(detail.remedy).toMatch(/cannot be granted/);
    expect(detail.remedy).not.toMatch(/administrator can grant/);
  });

  /**
   * WeVolunteer is an independent platform, not a school district service, so a
   * school administrator has no access to it, cannot see the refusal and cannot do
   * anything about it. `authRoutes.js` corrected the suspension notice for exactly
   * this reason; the same rule applies to every refusal.
   */
  it('never sends the reader to somebody powerless', () => {
    for (const route of [
      { requiredCap: 'message.send' },
      { requiredCap: 'error.read' },
      { requiredCap: 'event.create', requiresVerified: true },
    ]) {
      const { remedy } = denialDetail(route);
      expect(remedy, JSON.stringify(route)).not.toMatch(/school administrator/i);
    }
  });

  /**
   * A capability with no plain-language name must degrade to naming nothing
   * rather than printing a capability id at a fifteen-year-old.
   *
   * ── The fixture is DERIVED, and that is the third fix to this case ──
   *
   * It has now been broken twice by the same mechanism. It named
   * `analytics.platform`, which became route-gated with `/admin/impact` and so
   * had to be given a name — putting this assertion in direct contradiction
   * with the sweep below. It was changed to `event.moderate`, described in its
   * own comment as "one that gates no route", and `/admin/badges` then gated
   * exactly that.
   *
   * Naming any capability here makes it a hostage: the moment a route gates it,
   * one of these two cases must fail. So the fixture is computed instead — any
   * real capability the route table does NOT gate. The two cases can no longer
   * disagree, because this one is defined as the complement of that one.
   */
  it('falls back to a generic reason rather than showing a capability id', () => {
    const gated = new Set(APP_ROUTES.map(r => r.requiredCap).filter(Boolean));
    const ungated = ALL_CAPABILITIES.filter(c => !gated.has(c) && !FEATURE_NAMES[c]);

    /* Vacuity guard. If every capability were route-gated and named, there
       would be no way to exercise the fallback at all, and this case would
       silently stop testing anything. */
    expect(ungated.length, 'no un-named, un-gated capability left to test the fallback with')
      .toBeGreaterThan(0);

    for (const cap of ungated) {
      const detail = denialDetail({ requiredCap: cap });
      expect(detail.feature, cap).toBe(null);
      expect(detail.reason, cap).not.toContain(cap);
      expect(detail.reason, cap).toMatch(/this area/);
    }
  });

  /**
   * Every capability a ROUTE gates should have a name, because every one of them
   * can reach this screen. Derived from the route table, so adding a gated route
   * without naming its capability fails here rather than shipping a vaguer
   * refusal than the reader deserves.
   */
  it('has a plain-language name for every capability the route table gates', () => {
    const gated = [...new Set(APP_ROUTES.map(r => r.requiredCap).filter(Boolean))];
    expect(gated.length).toBeGreaterThan(0);

    for (const cap of gated) {
      // Sanity: the table must not gate on a name that does not exist.
      expect(ALL_CAPABILITIES, `${cap} is not a real capability`).toContain(cap);

      const { feature } = denialDetail({ requiredCap: cap });
      expect(
        feature,
        `'${cap}' gates a route but has no entry in FEATURE_NAMES, so a reader `
        + 'refused that route is told only that "this area" is limited. Add a '
        + 'plain-language name in denialDetail.js.',
      ).toBeTruthy();
    }
  });
});

/**
 * A refusal must not send the reader to somebody who cannot help.
 *
 * SUPER_ONLY is checked before per-user grants are consulted, and
 * `userCapabilities.js` refuses to STORE a grant naming one — so "a WeVolunteer
 * administrator can grant it" is not merely unhelpful for these capabilities, it
 * is false in a way that costs two people their time: the reader asks, the
 * administrator tries, and the grant is rejected with nothing explaining why.
 *
 * The list this used to be checked against was hand-written and went stale the
 * moment SUPER_ONLY grew. Measured live on 2026-09-06 against the merged tree:
 * an administrator with 2FA satisfied, refused at `/owner`, was told an
 * administrator could grant it. `owner.console` had been SUPER_ONLY since the
 * Owner Center shipped.
 */
describe('capabilities no grant can reach', () => {
  it('has some to check, so this cannot pass by finding none', () => {
    expect(SUPER_ONLY.length).toBeGreaterThan(3);
    expect(SUPER_ONLY).toContain('owner.console');
  });

  it.each(SUPER_ONLY)('%s does not promise a grant that would be refused', (cap) => {
    const { remedy } = denialDetail({ requiredCap: cap });

    expect(
      remedy,
      `${cap} is SUPER_ONLY, so no grant can reach it — but its refusal tells `
      + 'the reader an administrator can grant it. Derive UNREACHABLE_BY_GRANT '
      + 'from SUPER_ONLY rather than restating it.',
    ).not.toMatch(/can grant it/);

    /* And it must still say something, rather than going silent on the reader
       who is owed the most explanation. */
    expect(remedy).toBeTruthy();
  });
});
