import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizerVolunteers from './OrganizerVolunteers';
import OrganizerDashboard from './OrganizerDashboard';

vi.mock('../utils/api', () => ({
  api: {
    fetchOrganizerStats: vi.fn().mockResolvedValue({ hoursAwarded: 0 }),
    fetchOrganizerAgreement: vi.fn().mockResolvedValue({ required: false }),
  },
}));

const ORGANIZER = { id: 'org-1', name: 'Jordan', role: 'organizer', verified: true, grants: [] };
const event = { id: 'evt-1', title: 'Park Cleanup', organizerId: 'org-1', status: 'open', category: 'Other',
  location: 'Park', applicationDeadline: '2026-11-01T12:00:00.000Z', startDatetime: '2026-11-05T13:00:00.000Z',
  endDatetime: '2026-11-05T17:00:00.000Z', maxSpots: 20, spotsRemaining: 10, slots: [] };
/* Eight volunteers, each with a different number of hours so order is checkable. */
const applications = Array.from({ length: 8 }, (_, i) => ({
  id: `ap-${i}`, userId: `stu-${i}`, eventId: 'evt-1', status: 'accepted',
  volunteer: { id: `stu-${i}`, name: `Volunteer ${i}`, username: `vol${i}`, grade: '11', volunteeredHours: i },
}));

/**
 * N6: "Your volunteers" on the organizer dashboard was uncapped — one row per
 * volunteer ever confirmed. Capped now, with the rest on their own page, the
 * owner's rule for long lists (FX-31).
 */
describe('the organizer roster', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows six on the dashboard and links to the rest', () => {
    render(<MemoryRouter><OrganizerDashboard currentUser={ORGANIZER} events={[event]} applications={applications}
      refreshEvents={vi.fn()} addToast={vi.fn()} onViewDetails={vi.fn()} onViewVolunteerProfile={vi.fn()} setActiveTab={vi.fn()} /></MemoryRouter>);
    expect(screen.getAllByText(/^Volunteer \d$/)).toHaveLength(6);
    expect(screen.getByRole('link', { name: /Show all 8 volunteers/i })).toHaveAttribute('href', '/volunteers');
  });

  it('lists every volunteer, most hours first, with a way back', () => {
    render(<MemoryRouter><OrganizerVolunteers currentUser={ORGANIZER} events={[event]} applications={applications}
      onViewVolunteerProfile={vi.fn()} addToast={vi.fn()} /></MemoryRouter>);
    const names = screen.getAllByText(/^Volunteer \d$/).map(n => n.textContent);
    expect(names).toEqual(['Volunteer 7', 'Volunteer 6', 'Volunteer 5', 'Volunteer 4', 'Volunteer 3', 'Volunteer 2', 'Volunteer 1', 'Volunteer 0']);
    expect(screen.getByRole('link', { name: /Back to dashboard/i })).toHaveAttribute('href', '/');
  });
});
