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
import { denialDetail } from './denialDetail';
import { APP_ROUTES } from '../../routes/index.jsx';
import { ALL_CAPABILITIES } from '../../authz';

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
   * A capability with no plain-language name must degrade to naming nothing rather
   * than printing `event.moderate` at a fifteen-year-old.
   */
  it('falls back to a generic reason rather than showing a capability id', () => {
    /* `event.moderate` — the capability this test's own comment names, and one
       that gates no route, so the sweep below cannot start requiring a name for
       it. It previously used `analytics.platform`, which became a route-gated
       capability with `/admin/impact` and therefore had to be given a name;
       that made this assertion and the sweep below contradict each other. */
    const detail = denialDetail({ requiredCap: 'event.moderate' });
    expect(detail.feature).toBe(null);
    expect(detail.reason).not.toMatch(/event\.moderate/);
    expect(detail.reason).toMatch(/this area/);
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
