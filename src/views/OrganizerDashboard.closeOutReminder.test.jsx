import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizerDashboard from './OrganizerDashboard';

/* Every network call the page makes on mount. Stubbed rather than intercepted:
   this file is about what the dashboard DERIVES from the events it is handed,
   and a real request would make that depend on a fixture server. */
vi.mock('../utils/api', () => ({
  api: {
    fetchOrganizerStats: vi.fn().mockResolvedValue({ hoursAwarded: 0 }),
    fetchOrganizerAgreement: vi.fn().mockResolvedValue({ required: false }),
    deleteEvent: vi.fn(),
    duplicateEvent: vi.fn(),
    toggleEventStatus: vi.fn(),
    updateEvent: vi.fn(),
    exportRosterCSV: vi.fn(),
  },
}));

/**
 * The dashboard's reminder that an event's hours are credited but not permanent.
 *
 * ── Why the reminder exists ──
 *
 * Closing out is a deliberate act, and that is what stops a mistyped number
 * becoming permanent the moment the last checkbox is ticked. The cost of the
 * design is that it can simply never happen: the organizer finishes an event,
 * credits everybody, and does not come back. Nothing is broken — hours are
 * credited, certificates issued — so there is no error anywhere to notice.
 *
 * ── Why the tone is asserted, not just the presence ──
 *
 * Nobody is waiting on this, unlike the applications card directly above it
 * where a day's delay lands on a student who is told nothing. If this reads as
 * an alarm, an organizer will close out to make the alarm stop — which is
 * exactly the unconsidered, irreversible press the confirmation dialog exists to
 * prevent. So the copy has to say "still correctable" before it says
 * "permanent", and it must never call the action just "Close": this same page
 * carries a "Close sign-ups" control, and the two are unrelated.
 */

/**
 * `verified` because an unverified organizer gets a "waiting for approval" page
 * instead of the dashboard — a different screen with none of this on it.
 *
 * Capabilities come from the ROLE (and from `grants` for a per-user award), not
 * from a `capabilities` array: `src/authz.js` builds a principal out of
 * `{ id, role, grants, withheld }` and asks the server's own table. An organizer
 * therefore holds `attendance.mark` by being one.
 */
const ORGANIZER = {
  id: 'org-1',
  name: 'Jordan Whitfield',
  role: 'organizer',
  verified: true,
  grants: [],
};

const baseEvent = (over = {}) => ({
  id: 'evt-1',
  title: 'Park Cleanup',
  organizerId: 'org-1',
  category: 'Environment',
  location: 'Reichler Park',
  status: 'completed',
  hoursClosedOutAt: null,
  applicationDeadline: '2026-08-01T12:00:00.000Z',
  startDatetime: '2026-08-05T13:00:00.000Z',
  endDatetime: '2026-08-05T17:00:00.000Z',
  maxSpots: 5,
  spotsRemaining: 0,
  slots: [],
  ...over,
});

const draw = (events, { user = ORGANIZER, onViewDetails = vi.fn() } = {}) => {
  render(
    <MemoryRouter>
      <OrganizerDashboard
        currentUser={user}
        events={events}
        applications={[]}
        refreshEvents={vi.fn()}
        addToast={vi.fn()}
        onViewDetails={onViewDetails}
        onViewVolunteerProfile={vi.fn()}
        setActiveTab={vi.fn()}
      />
    </MemoryRouter>,
  );
  return { onViewDetails };
};

/** The reminder card, found by the one phrase only it uses. */
const reminder = () => screen.queryByText(/hours not closed out/i);

beforeEach(() => { vi.clearAllMocks(); });

describe('a completed event whose hours are not closed out', () => {
  it('is reported on the dashboard', () => {
    draw([baseEvent()]);
    expect(reminder()).toBeInTheDocument();
  });

  it('says the hours are still correctable', () => {
    draw([baseEvent()]);
    expect(screen.getByText(/still correctable/i)).toBeInTheDocument();
  });

  it('says that closing out cannot be undone', () => {
    draw([baseEvent()]);
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  /**
   * The applications card above uses `--danger` and `--warn` for people who are
   * genuinely stuck. Nobody is stuck here, and borrowing that colour would teach
   * organizers to clear an irreversible action the way they clear a notification.
   */
  it('does not present itself as urgent', () => {
    const { container } = render(
      <MemoryRouter>
        <OrganizerDashboard
          currentUser={ORGANIZER} events={[baseEvent()]} applications={[]}
          refreshEvents={vi.fn()} addToast={vi.fn()} onViewDetails={vi.fn()}
          onViewVolunteerProfile={vi.fn()} setActiveTab={vi.fn()}
        />
      </MemoryRouter>,
    );
    const card = container.querySelector('.s-closeout-card');
    expect(card).toBeTruthy();
    expect(card.className).not.toMatch(/danger|warn/);
    expect(screen.getByText('Ready when you are')).toBeInTheDocument();
  });

  /**
   * "Close sign-ups" stops new applications; "close out hours" permanently locks
   * credited service hours. Both live on this page, and a bare "Close" would be
   * the one word that could mean either.
   */
  it('never calls the action just "Close"', () => {
    const { container } = render(
      <MemoryRouter>
        <OrganizerDashboard
          currentUser={ORGANIZER} events={[baseEvent()]} applications={[]}
          refreshEvents={vi.fn()} addToast={vi.fn()} onViewDetails={vi.fn()}
          onViewVolunteerProfile={vi.fn()} setActiveTab={vi.fn()}
        />
      </MemoryRouter>,
    );
    const card = container.querySelector('.s-closeout-card');
    for (const button of card.querySelectorAll('button')) {
      expect(button.textContent.trim()).not.toBe('Close');
    }
    /**
     * Every mention of closing in this card is "clos… out" — never "close" on
     * its own, which on this page could equally mean the sign-up toggle three
     * sections down.
     */
    const text = card.textContent;
    const mentions = [...text.matchAll(/\bclos\w*/gi)];
    expect(mentions.length, 'the card never names the act at all').toBeGreaterThan(0);
    for (const m of mentions) {
      const following = text.slice(m.index, m.index + m[0].length + 12);
      expect(following, `"${m[0]}" is not followed by "out"`).toMatch(/^clos\w*(\s+them)?\s*out/i);
    }
  });
});

describe('events the reminder must leave alone', () => {
  it('says nothing once the hours have been closed out', () => {
    draw([baseEvent({ hoursClosedOutAt: '2026-08-20T10:00:00.000Z' })]);
    expect(reminder()).toBeNull();
  });

  /** Closing out an unfinished roster would leave the unmarked uncreditable. */
  it('says nothing about an event that is not complete', () => {
    draw([baseEvent({ status: 'open' })]);
    expect(reminder()).toBeNull();
  });

  it('says nothing about an event whose sign-ups are merely closed', () => {
    draw([baseEvent({ status: 'closed' })]);
    expect(reminder()).toBeNull();
  });

  it('says nothing about a cancelled event, which has no hours to freeze', () => {
    draw([baseEvent({ status: 'cancelled' })]);
    expect(reminder()).toBeNull();
  });

  it('says nothing when the organizer hosts no events at all', () => {
    draw([]);
    expect(reminder()).toBeNull();
  });
});

describe('authorization', () => {
  /**
   * The dashboard already scopes to `organizerId === currentUser.id`, so this is
   * the second of two gates rather than the only one. It is asserted because the
   * card is the one place a completed event of somebody else's could otherwise
   * be named — the title, the date, and an action against it.
   */
  it('does not name an event hosted by somebody else', () => {
    draw([baseEvent({ id: 'evt-other', organizerId: 'org-2', title: 'Not Mine' })]);
    expect(reminder()).toBeNull();
    expect(screen.queryByText('Not Mine')).toBeNull();
  });

  /**
   * The server refuses the close-out without `attendance.mark` or
   * `organization.event.manage.own` (`hostRefusal` on every attendance route).
   * Offering it to somebody who holds neither would be a button whose only
   * outcome is a 403.
   */
  it('does not offer the action to somebody without the capability', () => {
    /* A student with no grant holds neither `attendance.mark` nor
       `organization.event.manage.own`, which is what the server requires. */
    const viewerOnly = { ...ORGANIZER, role: 'student', grants: [] };
    draw([baseEvent()], { user: viewerOnly });
    expect(reminder()).toBeNull();
  });

  it('offers it to a Student Organizer, who may run their club\'s events', () => {
    const studentOrganizer = {
      id: 'org-1', name: 'Leo Chen', role: 'student', verified: true,
      grants: ['organization.event.manage.own'],
    };
    draw([baseEvent()], { user: studentOrganizer });
    expect(reminder()).toBeInTheDocument();
  });
});

describe('more than one event waiting', () => {
  const two = () => [
    baseEvent({ id: 'evt-1', title: 'Park Cleanup', endDatetime: '2026-08-05T17:00:00.000Z' }),
    baseEvent({ id: 'evt-2', title: 'Food Drive', endDatetime: '2026-07-02T17:00:00.000Z' }),
  ];

  it('counts them', () => {
    draw(two());
    expect(screen.getByText(/2 finished events with\s+hours not closed out/i)).toBeInTheDocument();
  });

  it('lists each one so neither is hidden behind the other', () => {
    const { container } = render(
      <MemoryRouter>
        <OrganizerDashboard
          currentUser={ORGANIZER} events={two()} applications={[]}
          refreshEvents={vi.fn()} addToast={vi.fn()} onViewDetails={vi.fn()}
          onViewVolunteerProfile={vi.fn()} setActiveTab={vi.fn()}
        />
      </MemoryRouter>,
    );
    const card = within(container.querySelector('.s-closeout-card'));
    expect(card.getByText('Park Cleanup')).toBeInTheDocument();
    expect(card.getByText('Food Drive')).toBeInTheDocument();
  });

  /** Longest-finished first: the one most likely to have been forgotten. */
  it('puts the event that finished longest ago at the top', () => {
    const { onViewDetails } = draw(two());
    fireEvent.click(screen.getByRole('button', { name: /Review hours/i }));
    expect(onViewDetails.mock.calls[0][0].id).toBe('evt-2');
  });

  it('shows a single event without a redundant list beneath it', () => {
    const { container } = render(
      <MemoryRouter>
        <OrganizerDashboard
          currentUser={ORGANIZER} events={[baseEvent()]} applications={[]}
          refreshEvents={vi.fn()} addToast={vi.fn()} onViewDetails={vi.fn()}
          onViewVolunteerProfile={vi.fn()} setActiveTab={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('.s-closeout-card .list')).toBeNull();
  });

  it('counts only the events that qualify', () => {
    draw([
      baseEvent({ id: 'evt-1' }),
      baseEvent({ id: 'evt-2', hoursClosedOutAt: '2026-08-20T10:00:00.000Z' }),
      baseEvent({ id: 'evt-3', status: 'open' }),
    ]);
    expect(screen.getByText(/1 finished event with\s+hours not closed out/i)).toBeInTheDocument();
  });
});

describe('following the reminder', () => {
  /**
   * Straight to the Closeout screen, not to the event page beside a button that
   * reaches it. `mode: 'hours'` rides in the URL alongside the event id, so the
   * destination survives a reload — and `EventModal` ignores it for anybody who
   * could not have pressed the button, since the parameter is user-supplied.
   */
  it('opens the hours workflow for the event', () => {
    const { onViewDetails } = draw([baseEvent()]);
    fireEvent.click(screen.getByRole('button', { name: /Review hours/i }));
    expect(onViewDetails).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt-1' }),
      { mode: 'hours' },
    );
  });

  it('opens the hours workflow from a row in the list too', () => {
    const { onViewDetails } = draw([
      baseEvent({ id: 'evt-1', title: 'Park Cleanup' }),
      baseEvent({ id: 'evt-2', title: 'Food Drive' }),
    ]);
    fireEvent.click(screen.getByText('Park Cleanup'));
    expect(onViewDetails).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt-1' }),
      { mode: 'hours' },
    );
  });
});
