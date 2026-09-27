/**
 * R-06 — a volunteer is told when a machine decided about them.
 *
 * Auto Select is disclosed where somebody APPLIES, and until 2026-09-27 was
 * disclosed nowhere at the moment it actually decided. A volunteer read "You are
 * on the waitlist" and could not tell an organizer's judgement from a draw.
 *
 * The finding says "at the application form and on decline". The decline half is
 * deliberately NOT implemented, and this file is where that is written down:
 * Auto Select never rejects. Unselected applicants are waitlisted on purpose,
 * because "the organizer did not reject them" (autoSelect.js). Every
 * APPLICATION_REJECTED is a person's decision, so naming Auto Select there would
 * blame a machine for a human refusal — the opposite of a disclosure.
 */
import { describe, it, expect } from 'vitest';
import { getInAppContent, AUTO_SELECT_NOTE } from './services/notificationContent.js';

const EVENT = { eventId: 'evt-1', eventTitle: 'Park Cleanup' };
const auto = (extra = {}) => ({ ...EVENT, decidedBy: 'auto-select', ...extra });

describe('Auto Select discloses itself to the volunteer it decided about', () => {
  it('says so when it accepts somebody', () => {
    const { body } = getInAppContent('APPLICATION_ACCEPTED', auto());
    expect(body).toContain('Park Cleanup');
    expect(body).toContain(AUTO_SELECT_NOTE.trim());
  });

  it('says so when it waitlists somebody, and still gives their rank', () => {
    const { body } = getInAppContent('APPLICATION_WAITLISTED', auto({ waitlistRank: 3 }));
    expect(body).toContain('number 3');
    expect(body).toContain(AUTO_SELECT_NOTE.trim());
  });

  it('says so when it waitlists somebody whose rank is unknown', () => {
    const { body } = getInAppContent('APPLICATION_WAITLISTED', auto());
    expect(body).toContain(AUTO_SELECT_NOTE.trim());
  });
});

describe('a human decision never claims to be automated', () => {
  /* The organizer paths in applicationRoutes.js pass no `decidedBy`. If the note
     ever leaked into them, a volunteer would be told a machine made a choice a
     person made — which is worse than saying nothing, because it is false and it
     removes the person they would otherwise ask about it. */
  it('an organizer accepting says nothing about Auto Select', () => {
    expect(getInAppContent('APPLICATION_ACCEPTED', { ...EVENT }).body)
      .not.toContain('Auto Select');
  });

  it('an organizer waitlisting says nothing about Auto Select', () => {
    expect(getInAppContent('APPLICATION_WAITLISTED', { ...EVENT, waitlistRank: 2 }).body)
      .not.toContain('Auto Select');
  });

  it('a decline NEVER mentions Auto Select, even if a flag is somehow present', () => {
    /* Belt and braces: Auto Select cannot produce this event at all, and the
       template has no branch for it. Asserted so that adding one later fails
       here rather than in a volunteer's notification. */
    expect(getInAppContent('APPLICATION_REJECTED', auto()).body)
      .not.toContain('Auto Select');
  });
});
