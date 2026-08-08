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

/**
 * The three empty states, which had the same defect as the dialog and were fixed
 * with the same cascade rather than a second one.
 *
 * ── Why they are tested as a SET rather than sentence by sentence ──
 *
 * The failure that matters is not a particular wording. It is one role quietly
 * inheriting another's copy — which is what happened when a single sentence was
 * shown to everybody, and which is exactly what a per-sentence test with a
 * generous regex would keep passing through. So the assertions below are mostly
 * about DISTINCTNESS and about the specific phrase that was wrong for each
 * audience.
 */
describe('the messaging empty states', () => {
  const SURFACES = ['listEmpty', 'noneSelected', 'threadEmpty'];
  const ROLES = ['student', 'organizer', 'admin'];

  const textOf = (copy, surface) => {
    const v = copy[surface];
    return typeof v === 'string' ? v : `${v.title} ${v.body}`;
  };

  it.each(SURFACES)('gives every role its own %s', (surface) => {
    const texts = ROLES.map((r) => textOf(recipientCopyFor(USER(r)), surface));
    expect(new Set(texts).size, `${surface} is shared between roles`).toBe(ROLES.length);
  });

  it.each(SURFACES)('never shows an administrator the volunteer-opportunity wording in %s', (surface) => {
    /* The exact phrase every account used to see. An administrator's threads are
       moderation conversations opened from a report — the one kind of thread they
       do NOT have is a conversation about a shift somebody applied for. */
    expect(textOf(recipientCopyFor(USER('admin')), surface))
      .not.toMatch(/volunteer opportunity/i);
  });

  it.each(SURFACES)('never tells an organizer they applied to something in %s', (surface) => {
    /* The direction error: an organizer is messaged BY applicants, they do not
       apply. "an event you have applied to" is the student's sentence. */
    expect(textOf(recipientCopyFor(USER('organizer')), surface))
      .not.toMatch(/you have applied/i);
  });

  /**
   * An administrator is told the thread is visible to whoever reviews the report.
   *
   * This is the one empty state carrying a warning rather than an instruction,
   * and it is the one worth pinning by content: an administrator writing to a
   * student about a safety report should know before they type that it is not a
   * private word between the two of them.
   */
  it('warns an administrator that a moderation thread is reviewable', () => {
    const c = recipientCopyFor(USER('admin'));
    expect(c.threadEmpty.body).toMatch(/administrator reviewing the report/i);
  });

  /**
   * A student is told an adult will see it.
   *
   * Most people using this platform are minors, and the Youth Safety Guidelines
   * promise that messaging is not a private channel between a child and an adult
   * stranger. The first thing a student sees in an empty thread should say so.
   */
  it('tells a student an adult at the organization will see what they write', () => {
    const c = recipientCopyFor(USER('student'));
    expect(c.threadEmpty.body).toMatch(/adult at the organization/i);
  });

  /**
   * A partner holds none of the three capabilities. Falling through to the
   * student's copy would send them looking for a feature their account does not
   * have — the same failure the dialog had, in a different place.
   */
  it.each(SURFACES)('tells a partner messaging is unavailable in %s', (surface) => {
    expect(textOf(recipientCopyFor(USER('partner')), surface)).toMatch(/not available/i);
  });

  /** Every surface exists for every role — a missing one renders `undefined`. */
  it.each([...ROLES, 'partner', 'super_admin'])('defines every surface for %s', (role) => {
    const c = recipientCopyFor(USER(role));
    expect(typeof c.listEmpty).toBe('string');
    for (const s of ['noneSelected', 'threadEmpty']) {
      expect(c[s]?.title, `${role}.${s}.title`).toBeTruthy();
      expect(c[s]?.body, `${role}.${s}.body`).toBeTruthy();
    }
  });
});
