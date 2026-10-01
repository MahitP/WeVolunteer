import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrowseEvents from './BrowseEvents';

vi.mock('../utils/api', () => ({
  api: {
    fetchEventsFiltered: vi.fn().mockResolvedValue({ events: [], total: 7 }),
    fetchRecommendations: vi.fn().mockResolvedValue([
      { id: 'rec-1', title: 'Park cleanup', category: 'Other', score: 1,
        startDatetime: '2026-10-10T13:00:00.000Z', reasons: ['tutoring'] },
    ]),
    fetchOrganizations: vi.fn().mockResolvedValue({ organizations: [] }),
    searchDirectory: vi.fn().mockResolvedValue({ users: [], organizations: [] }),
  },
}));

vi.mock('../contexts/LocationContext', () => ({
  useLocationContext: () => ({ location: null, requestLocation: vi.fn() }),
}));

const STUDENT = { id: 'user-s', role: 'student', verified: true, withheld: [], volunteeredHours: 7 };

/**
 * The owner asked for the search bar to "live on top of the Opportunities
 * page". Measured on a phone it was at 973px, below the whole "Suggested for
 * you" strip and two lead lines that said the same count.
 */
describe('Discover puts the search first', () => {
  it('draws the search box above "Suggested for you"', async () => {
    render(<MemoryRouter><BrowseEvents currentUser={STUDENT} onViewDetails={() => {}} onEventsSeen={() => {}} /></MemoryRouter>);
    const heading = await screen.findByRole('heading', { name: /Suggested for you/i });
    const search = screen.getByRole('searchbox');
    expect(search.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('states the count once, for a student who can also see organizations', async () => {
    render(<MemoryRouter><BrowseEvents currentUser={STUDENT} onViewDetails={() => {}} onEventsSeen={() => {}} /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText(/opportunit(y|ies) posted/i)).toHaveLength(1));
  });
});
