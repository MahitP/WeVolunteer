import { describe, it, expect } from 'vitest';
import { recipientCopyFor } from './recipientCopy';

/**
 * The "New message" dialog told three of its four audiences the wrong thing.
 *
 * One sentence was shown to everybody — "You can message the organizer of an
 * event you have applied to" — which is true of a student and of nobody else.
 * An organizer and an administrator both message in the opposite direction, and
 * a partner cannot message anyone at all: the server's search cascade has no
 * branch for them, so their results are unconditionally empty.
 */

const USER = (role) => ({ id: `user-${role}`, role });

describe('recipientCopyFor', () => {
  it('tells a student they reach organizers', () => {
    const c = recipientCopyFor(USER('student'));
    expect(c.description).toMatch(/organizer of an event you have applied to/i);
  });

  it('tells an organizer they reach applicants, not organizers', () => {
    const c = recipientCopyFor(USER('organizer'));
    expect(c.description).toMatch(/volunteers who have applied to your events/i);
    expect(c.description).not.toMatch(/you have applied to/i);
  });

  /**
   * The administrator case, and the reason this file is not just a lookup table.
   *
   * The staff branch of `GET /api/messages/users/search` joins on
   * `e.organizer_id = ?` — applicants to events THE CALLER ORGANIZES. An
   * administrator usually organizes none, so the box searches an empty set
   * however carefully they spell the name. Contacting somebody about a report
   * goes through the Moderation Center, which is also what records the
   * `ADMIN_CONVERSATION_OPENED` audit row, so that is where they are sent.
   */
  it('sends an administrator to the Moderation Center rather than the search box', () => {
    const c = recipientCopyFor(USER('admin'));
    expect(c.description).toMatch(/moderation center/i);
    expect(c.empty).toMatch(/moderation center/i);
  });

  /**
   * Most-privileged-first, which is the whole reason this is a cascade and not a
   * map keyed on role.
   *
   * `can()` answers true for EVERY capability when the principal is
   * super_admin, so an owner matches whichever entry is tested first. Testing
   * `application.withdraw` before `event.moderate` would hand the platform
   * owner a student's sentence — the client-side twin of the defect the server's
   * own cascade comments warn about at length.
   */
  it('gives the platform owner the administrator copy, not the student copy', () => {
    const owner = recipientCopyFor(USER('super_admin'));
    expect(owner).toEqual(recipientCopyFor(USER('admin')));
    expect(owner.description).not.toMatch(/you have applied to/i);
  });

  /**
   * The cascade ends in an explicit fallback rather than a bare last entry, for
   * the same reason the server's does: "no recognised capability" must mean
   * "nothing", never "whatever the last branch happened to be".
   */
  it('does not promise a partner a feature the server has no branch for', () => {
    const c = recipientCopyFor(USER('partner'));
    expect(c.description).toMatch(/not available for this account/i);
  });

  it('never returns nothing, however odd the user', () => {
    for (const u of [null, undefined, {}, { role: 'nonsense' }]) {
      const c = recipientCopyFor(u);
      expect(typeof c.description).toBe('string');
      expect(c.description.length).toBeGreaterThan(0);
      expect(typeof c.placeholder).toBe('string');
      expect(typeof c.empty).toBe('string');
    }
  });

  /** Nobody should be shown a placeholder that contradicts their description. */
  it('gives every role a distinct placeholder', () => {
    const seen = ['student', 'organizer', 'admin'].map((r) => recipientCopyFor(USER(r)).placeholder);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
