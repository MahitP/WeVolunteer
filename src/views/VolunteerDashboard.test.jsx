import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  api: {
    fetchLeaderboard: vi.fn(),
    fetchVolunteerStats: vi.fn(),
    getWeather: vi.fn(() => new Promise(() => {})),
  },
}));
vi.mock('../utils/errorReporting', () => ({ reportClientError: vi.fn() }));

const locationState = { location: null };
vi.mock('../contexts/LocationContext', () => ({ useLocationContext: () => locationState }));

import { api } from '../utils/api';
import VolunteerDashboard from './VolunteerDashboard';

/**
 * The dashboard had no test at all.
 *
 * That is not a theoretical gap: while this change was being made, an edit left
 * unbalanced JSX in this file and the entire client suite stayed green — 99
 * files, 1452 tests — because nothing rendered it. The build caught it. A view
 * this central should not be relying on the bundler to notice it is broken.
 */

const currentUser = {
  id: 'u1',
  name: 'Leo Chen',
  role: 'student',
  volunteeredHours: 12,
  serviceHourGoal: 25,
};

const futureIso = (days) => new Date(Date.now() + days * 86400000).toISOString();

const event = {
  id: 'e1',
  title: 'Park Cleanup',
  location: 'Reichler Park',
  address: '100 Reichler Park Drive, Example Valley, NJ 08824',
  latitude: 40.386,
  longitude: -74.556,
  status: 'open',
};

const application = {
  id: 'a1',
  userId: 'u1',
  eventId: 'e1',
  status: 'accepted',
  slot: {
    id: 's1',
    name: 'Morning',
    startDatetime: futureIso(2),
    endDatetime: futureIso(2.2),
  },
};

const renderDashboard = (props = {}) => render(
  <MemoryRouter>
    <VolunteerDashboard
      currentUser={currentUser}
      events={[event]}
      applications={[application]}
      addToast={vi.fn()}
      setActiveTab={vi.fn()}
      onViewDetails={vi.fn()}
      {...props}
    />
  </MemoryRouter>,
);

describe('VolunteerDashboard', () => {
  beforeEach(() => {
    locationState.location = null;
    vi.mocked(api.fetchLeaderboard).mockResolvedValue([]);
    vi.mocked(api.fetchVolunteerStats).mockReturnValue(new Promise(() => {}));
  });

  it('renders without throwing', async () => {
    renderDashboard();
    expect(await screen.findByText(/Your next shift/i)).toBeInTheDocument();
  });

  it('shows the next shift with its place as a directions link', async () => {
    renderDashboard();
    expect(await screen.findByText('Park Cleanup · Morning')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Reichler Park/ })).toBeInTheDocument();
  });

  it('shows how far the next shift is once a position is shared', async () => {
    locationState.location = { latitude: 40.4188, longitude: -74.5931 };
    renderDashboard();
    expect(await screen.findByText(/mi away/)).toBeInTheDocument();
  });

  it('shows no distance when no position has been shared', async () => {
    renderDashboard();
    await screen.findByText(/Your next shift/i);
    expect(screen.queryByText(/mi away/)).toBeNull();
  });

  it('renders the insight section even while its data is still loading', async () => {
    renderDashboard();
    /* The heading is present in every state, which is what stops the page
       reflowing when the figures land. */
    expect(await screen.findByRole('heading', { name: /your service so far/i })).toBeInTheDocument();
  });

  it('keeps the rest of the page when the insight fetch fails', async () => {
    vi.mocked(api.fetchVolunteerStats).mockRejectedValue(new Error('500'));
    renderDashboard();

    await screen.findByRole('alert');
    /* One section failing must not take the shift card or the hours meter with
       it — that is why the section owns its own fetch. */
    expect(screen.getByText('Park Cleanup · Morning')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('keeps the insight section when the leaderboard fails', async () => {
    vi.mocked(api.fetchLeaderboard).mockRejectedValue(new Error('500'));
    renderDashboard();
    expect(await screen.findByRole('heading', { name: /your service so far/i })).toBeInTheDocument();
  });

  it('welcomes a volunteer with nothing booked', async () => {
    renderDashboard({ applications: [], events: [] });
    await waitFor(() => expect(screen.queryByText(/Your next shift/i)).toBeNull());
  });
});

/**
 * Ruling 3 (2026-09-30), the owner's P2-21: "Volunteers should have the button
 * like how organizers have the create new event button … a log external hours
 * button exactly like the same button." It sits beside "My logged hours", as
 * the primary action of the service-history header — and the account menu no
 * longer carries "My hours", so this header is where a student's record starts.
 */
describe('the service-history header', () => {
  it('offers "Log external hours" as its primary action, beside "My logged hours"', () => {
    renderDashboard();
    const log = screen.getByRole('link', { name: /Log external hours/i });
    expect(log).toHaveAttribute('href', '/hours/external');
    expect(log.className).toMatch(/btn-primary/);
    expect(screen.getByRole('link', { name: /My logged hours/i })).toHaveAttribute('href', '/hours');
  });
});

