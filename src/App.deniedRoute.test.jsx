import { describe, it, expect } from 'vitest';
import { deniedRoute } from './App.jsx';

/**
 * Why a route was refused, not only that it was (Phase 5 walk, 2026-10-04).
 *
 * The refusal page was given the matched route and nothing else, so it worked
 * out the reason from the route's flags. `/events/new` carries
 * `requiresVerified`, and an APPROVED organizer who had not yet accepted the
 * Organizer Agreement was therefore told "your organizer account has not been
 * approved yet … nothing else is needed from you" — while the dashboard
 * behind it said to accept the agreement. Only the shell knows which condition
 * failed, so it says.
 */

const organizer = (over = {}) => ({ id: 'u-org', role: 'organizer', verified: true, withheld: [], ...over });

describe('deniedRoute', () => {
  it('lets an approved organizer with the agreement accepted through', () => {
    expect(deniedRoute('/events/new', organizer())).toBeNull();
  });

  it('says "unverified" for an organizer awaiting approval', () => {
    expect(deniedRoute('/events/new', organizer({ verified: false })).because).toBe('unverified');
  });

  it('says "withheld", with the role, for an approved organizer whose agreement is pending', () => {
    /* Both capabilities `/events/new` accepts, as the server withholds them. */
    const denied = deniedRoute('/events/new', organizer({ withheld: ['event.create', 'organization.event.create'] }));
    expect(denied.because).toBe('withheld');
    expect(denied.role).toBe('organizer');
    expect(denied.path).toBe('/events/new');
  });

  it('says "capability" for a role that never held it', () => {
    expect(deniedRoute('/events/new', { id: 'u-s', role: 'student', verified: true, withheld: [] }).because)
      .toBe('capability');
  });
});
