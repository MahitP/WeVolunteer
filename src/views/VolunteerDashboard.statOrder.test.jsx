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
  it('reads Upcoming, then Shifts completed, then Awaiting reply', () => {
    const { container } = draw();
    expect(tiles(container).map(([label]) => label)).toEqual([
      'Upcoming',
      'Shifts completed',
      'Awaiting reply',
    ]);
  });

  it('puts Shifts completed above Awaiting reply, which is the change', () => {
    const { container } = draw();
    const labels = tiles(container).map(([label]) => label);
    expect(labels.indexOf('Shifts completed')).toBeLessThan(labels.indexOf('Awaiting reply'));
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
      ['Shifts completed', '3'],
      ['Awaiting reply', '2'],
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
