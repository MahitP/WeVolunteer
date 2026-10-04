import { describe, it, expect } from 'vitest';
import { pageMetaFor, PAGE_META } from './App.jsx';

/**
 * A pending organizer's dashboard subtitle (owner ruling 25, 2026-10-04).
 *
 * It read "Track your volunteers, hours, and pending reviews" above a page
 * whose only content is "your organizer account is awaiting approval".
 */
const organizer = (over = {}) => ({ id: 'u-o', role: 'organizer', verified: true, grants: [], withheld: [], ...over });

describe('the organizer dashboard subtitle', () => {
  it('says what is happening while the account awaits approval', () => {
    expect(pageMetaFor(organizer({ verified: false }), 'dashboard').sub).toMatch(/awaiting approval/i);
  });

  it('is unchanged once approved', () => {
    expect(pageMetaFor(organizer(), 'dashboard').sub).toBe(PAGE_META.host.dashboard.sub);
  });
});
