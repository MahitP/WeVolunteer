import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  api: {
    fetchLeaderboard: vi.fn(),
    fetchVolunteerStats: vi.fn(),
    getWeather: vi.fn(() => new Promise(() => {})),
  },
}));
vi.mock('../utils/errorReporting', () => ({ reportClientError: vi.fn() }));
vi.mock('../contexts/LocationContext', () => ({ useLocationContext: () => ({ location: null }) }));

import { api } from '../utils/api';
import VolunteerDashboard from './VolunteerDashboard';

/**
 * The order of the three figures at the top of a volunteer's dashboard.
 *
 * ── Why this is asserted rather than left to the JSX ──
 *
 * An order is the easiest thing in a file to undo by accident: somebody adds a
 * fourth tile and puts it where the diff is smallest, or reorders while moving
 * the block, and nothing anywhere fails. The three tiles here read as one
 * sentence about where the reader stands — what is booked, what has been done,
 * and only then what is still waiting on somebody else — and "Awaiting reply",
 * the least settled of the three, belongs at the end of it rather than in the
 * middle.
 *
 * ── Why it renders instead of reading the source ──
 *
 * The claim is about what a reader sees, and a source scan cannot tell a tile
 * that is rendered from one that sits behind a condition. This is also the
 * assertion that the FIGURES did not move with the labels: the whole risk of a
 * reordering change is that a value ends up under the wrong heading, which no
 * amount of checking the sequence of strings would catch.
 */

const currentUser = {
  id: 'u1',
  name: 'Leo Chen',
  role: 'student',
  volunteeredHours: 12,
  serviceHourGoal: 25,
};

const futureIso = days => new Date(Date.now() + days * 86400000).toISOString();
const pastIso = days => new Date(Date.now() - days * 86400000).toISOString();

const events = [
  { id: 'e1', title: 'Park Cleanup', location: 'Reichler Park', status: 'open' },
  { id: 'e2', title: 'Food Drive', location: 'Community Center', status: 'open' },
  { id: 'e3', title: 'Book Fair', location: 'Library', status: 'completed' },
];

/** One accepted future shift, two awaiting a reply, three already worked. */
const applications = [
  {
    id: 'a1', userId: 'u1', eventId: 'e1', status: 'accepted',
    slot: { id: 's1', name: 'Morning', startDatetime: futureIso(2), endDatetime: futureIso(2.2) },
  },
  {
    id: 'a2', userId: 'u1', eventId: 'e2', status: 'pending',
    slot: { id: 's2', name: 'Afternoon', startDatetime: futureIso(5), endDatetime: futureIso(5.2) },
  },
  {
    id: 'a3', userId: 'u1', eventId: 'e2', status: 'waitlisted',
    slot: { id: 's3', name: 'Evening', startDatetime: futureIso(6), endDatetime: futureIso(6.2) },
  },
  ...[1, 2, 3].map(n => ({
    id: `a${3 + n}`, userId: 'u1', eventId: 'e3', status: 'accepted',
    attendance: { present: true },
    slot: { id: `s${3 + n}`, name: `Shift ${n}`, startDatetime: pastIso(n + 7), endDatetime: pastIso(n + 7) },
  })),
];

const draw = () => render(
  <MemoryRouter>
    <VolunteerDashboard
      currentUser={currentUser}
      events={events}
      applications={applications}
      addToast={vi.fn()}
      setActiveTab={vi.fn()}
      onViewDetails={vi.fn()}
    />
  </MemoryRouter>,
);

/** `[label, value]` for every tile in the summary strip, in the order drawn. */
function tiles(container) {
  return [...container.querySelectorAll('.stats .stat')].map(stat => [
    stat.querySelector('.stat-label')?.textContent.trim(),
    stat.querySelector('.stat-value')?.textContent.trim(),
  ]);
}

beforeEach(() => {
  vi.mocked(api.fetchLeaderboard).mockResolvedValue([]);
  vi.mocked(api.fetchVolunteerStats).mockReturnValue(new Promise(() => {}));
});

describe('the volunteer dashboard summary tiles', () => {
  /* The owner's own order, pasted in his request (CK-11): "UPCOMING, AWAITING
     REPLY, SHIFTS COMPLETED … Keep everything else as is". An earlier change
     reordered these tiles after reading the request as being about them; it was
     about the hours box and the "Waiting on a reply" SECTION (see below). */
  it('reads Upcoming, then Awaiting reply, then Shifts completed — the owner\'s order', () => {
    const { container } = draw();
    expect(tiles(container).map(([label]) => label)).toEqual([
      'Upcoming',
      'Awaiting reply',
      'Shifts completed',
    ]);
  });

  /* CK-11, the request itself: "This box should be Above waiting for reply not
     below the waiting for reply section". The box is the hours card he pasted
     ("SERVICE HOURS THIS YEAR … How hours are credited"); the section is
     "Waiting on a reply", which renders only when something is pending — and
     he had two applications pending when he wrote it. */
  it('draws the hours box ABOVE the "Waiting on a reply" section', () => {
    const { container } = draw();
    const hours = screen.getByText(/Service hours this year/i).closest('section, .card');
    const waiting = screen.getByRole('heading', { name: /Waiting on a reply/i }).closest('section');
    expect(hours, 'fixture: the hours box renders').toBeTruthy();
    expect(waiting, 'fixture: a pending application renders the section').toBeTruthy();
    expect(hours.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    void container;
  });

  /**
   * The figures are the point of the tiles, and a reorder is exactly the edit
   * that can leave one under the wrong heading. One accepted future shift, two
   * applications still waiting (pending and waitlisted both count), three worked.
   */
  it('keeps each figure with the label it belongs to', () => {
    const { container } = draw();
    expect(tiles(container)).toEqual([
      ['Upcoming', '1'],
      ['Awaiting reply', '2'],
      ['Shifts completed', '3'],
    ]);
  });

  it('still draws exactly three tiles and adds nothing', () => {
    const { container } = draw();
    expect(tiles(container)).toHaveLength(3);
  });

  /* The rest of the dashboard is untouched by a reordering of this strip. */
  it('leaves the next-shift card where it was', async () => {
    draw();
    expect(await screen.findByText(/Your next shift/i)).toBeInTheDocument();
    expect(screen.getByText('Park Cleanup · Morning')).toBeInTheDocument();
  });
});
