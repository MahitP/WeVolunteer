import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ApplicantReview from './ApplicantReview';

/**
 * The screen where an organizer decides who gets a place.
 *
 * The first test this component has ever had, and the reason is the payload it
 * now reads: a badge list, a last-served date that can be absent, and counts
 * whose whole design is about not reading as a verdict. Each of those is a
 * decision about how a real student is described to somebody holding twenty
 * places, and none of them was pinned by anything.
 */

function applicant(overrides = {}, volunteer = {}) {
  return {
    id: `app-${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    appliedAt: '2026-08-01T10:00:00.000Z',
    slot: { id: 'slot-1', name: 'Morning Setup' },
    volunteer: {
      id: 'user-1',
      name: 'Leo Chen',
      avatar: '🙂',
      school: 'South Brunswick High',
      grade: 11,
      volunteeredHours: 12,
      completedEvents: 5,
      lastVolunteeredDate: '2026-07-11T18:00:00.000Z',
      eventsSignedUp: 6,
      eventsAttended: 5,
      eventsAbsent: 1,
      eventsAwaitingRecord: 0,
      badges: [],
      skills: [],
      ...volunteer,
    },
    ...overrides,
  };
}

function draw(applications) {
  return render(
    <ApplicantReview
      applications={applications}
      onDecide={vi.fn()}
      onViewVolunteer={vi.fn()}
      onMessage={vi.fn()}
      busy={false}
    />,
  );
}

const badge = (name, icon, category, criteria_type, criteria_value) =>
  ({ name, icon, category, criteria_type, criteria_value, earnedAt: '2026-07-01T00:00:00.000Z' });

const RELIABLE = badge('Reliable Volunteer', '⭐', 'Participation', 'attendance_rate', 90);
const HOURS_50 = badge('50 Hours', '🕐', 'Service hours', 'hours', 50);
const HOURS_25 = badge('25 Hours', '🕐', 'Service hours', 'hours', 25);
const STREAK_6 = badge('6 Month Streak', '🔥', 'Consistency', 'streak_months', 6);
const EARLY = badge('Early Supporter', '🌟', 'Participation', 'early_adopter', 250);

describe('badges beside an applicant', () => {
  it('shows the reliability badge, which is what the organizer is reading for', () => {
    draw([applicant({}, { badges: [RELIABLE] })]);
    expect(screen.getByText('Reliable Volunteer')).toBeInTheDocument();
  });

  it('shows the highest tier of a progression and not the whole ladder', () => {
    /* Nine hour tiers would bury the two badges that answer the actual
       question. `organizerBadges` keeps the top of each progression. */
    draw([applicant({}, { badges: [HOURS_25, HOURS_50, RELIABLE] })]);

    expect(screen.getByText('50 Hours')).toBeInTheDocument();
    expect(screen.queryByText('25 Hours')).not.toBeInTheDocument();
  });

  it('shows at most three', () => {
    draw([applicant({}, { badges: [RELIABLE, HOURS_25, HOURS_50, STREAK_6, EARLY] })]);
    /* Reliable + top hours + top streak. Early Supporter says nothing about
       whether somebody turns up. */
    expect(screen.queryByText('Early Supporter')).not.toBeInTheDocument();
    expect(screen.getByText('6 Month Streak')).toBeInTheDocument();
  });

  it('renders nothing when the volunteer has none', () => {
    const { container } = draw([applicant({}, { badges: [] })]);
    expect(container.querySelectorAll('.tag')).toHaveLength(0);
  });

  it('survives a payload with no badges field at all', () => {
    /* An older client or a cached response. A missing list must not blank the
       whole applicant row. */
    const app = applicant();
    delete app.volunteer.badges;
    expect(() => draw([app])).not.toThrow();
    expect(screen.getByText('Leo Chen')).toBeInTheDocument();
  });

  it('hides the icon from assistive technology and keeps the name readable', () => {
    /* An emoji read aloud as "high voltage" is noise; the name carries the
       meaning. */
    const { container } = draw([applicant({}, { badges: [RELIABLE] })]);
    const icon = container.querySelector('.tag [aria-hidden="true"]');
    expect(icon).toBeTruthy();
    expect(icon.textContent).toBe('⭐');
  });
});

describe('when somebody last served', () => {
  it('gives the date when there is one', () => {
    draw([applicant({}, { lastVolunteeredDate: '2026-07-11T18:00:00.000Z' })]);
    expect(screen.getByText(/^last /)).toBeInTheDocument();
  });

  it('says so in words when there is none, rather than "last —"', () => {
    /**
     * The bug this closes. `formatDay(null)` returns an em dash, so a volunteer
     * with commitments but no confirmed attendance read "last —" — a blank the
     * organizer fills in themselves, and the likeliest guess is the unkindest
     * one.
     */
    draw([applicant({}, { lastVolunteeredDate: null, eventsSignedUp: 4, eventsAttended: 0, eventsAbsent: 0, eventsAwaitingRecord: 4 })]);

    expect(screen.getByText('no confirmed shifts yet')).toBeInTheDocument();
    expect(screen.queryByText('last —')).not.toBeInTheDocument();
  });

  it('never renders an em dash as the whole of what it knows', () => {
    draw([applicant({}, { lastVolunteeredDate: undefined, eventsSignedUp: 5, eventsAttended: 3, eventsAbsent: 0, eventsAwaitingRecord: 2 })]);
    expect(screen.queryByText(/last\s+—/)).not.toBeInTheDocument();
  });
});

describe('too little history to say anything', () => {
  it('says "First event" rather than "0 of 0 attended"', () => {
    draw([applicant({}, { eventsSignedUp: 0, eventsAttended: 0, completedEvents: 0 })]);
    expect(screen.getByText(/First event/)).toBeInTheDocument();
    expect(screen.queryByText(/attended/)).not.toBeInTheDocument();
  });

  it('says "New volunteer" for one or two commitments rather than a damning ratio', () => {
    /* "0 of 1 attended" is one shift's worth of evidence presented as a
       character reference. */
    const { container } = draw([applicant({}, { eventsSignedUp: 1, eventsAttended: 0, completedEvents: 1 })]);

    /* Scoped to the status chip: the sort dropdown also offers "New volunteers
       first", and matching that instead would pass whatever the row said. */
    expect(container.querySelector('.tag-brand').textContent).toMatch(/New volunteer/);
    expect(screen.queryByText('0 of 1 attended')).not.toBeInTheDocument();
  });

  it('shows the counts once there are three completed commitments', () => {
    draw([applicant({}, { eventsSignedUp: 3, eventsAttended: 3, completedEvents: 3 })]);
    expect(screen.getByText('3 of 3 attended')).toBeInTheDocument();
  });

  it('shows no badges for a first-timer, because the row is a status line', () => {
    /* A brand-new volunteer can hold Early Supporter. Showing it beside "First
       event" would look like experience they do not have. */
    draw([applicant({}, { eventsSignedUp: 0, eventsAttended: 0, completedEvents: 0, badges: [EARLY] })]);
    expect(screen.queryByText('Early Supporter')).not.toBeInTheDocument();
  });
});

describe('naming the unconfirmed shifts', () => {
  it('says how many an organizer never got round to confirming', () => {
    /**
     * "7 of 9" invites one reading — that somebody missed two — and that
     * reading is wrong whenever nobody closed out the event. The volunteer
     * cannot make it happen and cannot see it counting against them.
     */
    draw([applicant({}, { eventsSignedUp: 9, eventsAttended: 7, eventsAbsent: 0, eventsAwaitingRecord: 2 })]);

    expect(screen.getByText('7 of 9 attended')).toBeInTheDocument();
    expect(screen.getByText('2 not confirmed by an organizer')).toBeInTheDocument();
  });

  it('stays quiet when everything has been confirmed', () => {
    draw([applicant({}, { eventsSignedUp: 9, eventsAttended: 8, eventsAbsent: 1, eventsAwaitingRecord: 0 })]);
    expect(screen.queryByText(/not confirmed/)).not.toBeInTheDocument();
  });

  it('never shows a percentage', () => {
    /* Four independent in-repo decisions say counts only. This is the one that
       fails if a future edit adds "78%". */
    const { container } = draw([applicant({}, { eventsSignedUp: 9, eventsAttended: 7, eventsAbsent: 2, eventsAwaitingRecord: 0 })]);
    expect(container.textContent).not.toMatch(/\d%/);
  });
});
