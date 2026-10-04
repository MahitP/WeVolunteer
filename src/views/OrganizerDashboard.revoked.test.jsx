import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizerDashboard from './OrganizerDashboard';

vi.mock('../utils/api', () => ({
  api: new Proxy({}, { get: () => vi.fn().mockResolvedValue(null) }),
}));

/**
 * An organizer whose approval was withdrawn (final audit, Phase 6 review).
 *
 * Unverified again after a revocation, they were shown the new-organizer card:
 * "awaiting approval … We will let you know when yours is approved". Revoked
 * accounts are kept out of the review queue on purpose, so that never happens.
 */
const draw = (user) => render(
  <MemoryRouter>
    <OrganizerDashboard currentUser={user} events={[]} applications={[]} refreshEvents={vi.fn()}
      addToast={vi.fn()} onViewDetails={vi.fn()} onViewVolunteerProfile={vi.fn()} setActiveTab={vi.fn()} />
  </MemoryRouter>,
);

const base = { id: 'u-o', name: 'Jordan Whitfield', email: 'j@example.org', role: 'organizer', grants: [], withheld: [] };

describe('the dashboard of an organizer who is not approved', () => {
  it('says the approval was withdrawn, and promises no review', () => {
    draw({ ...base, verified: false, approvalRevoked: true });
    expect(screen.getByRole('heading', { name: /approval to post events was withdrawn/i })).toBeInTheDocument();
    expect(screen.queryByText(/awaiting approval/i)).toBeNull();
    expect(screen.queryByText(/let you know when yours is approved/i)).toBeNull();
    expect(screen.getByRole('link', { name: /Report a problem/ })).toHaveAttribute('href', '/report-issue');
  });

  it('still tells a new organizer they are awaiting review', () => {
    draw({ ...base, verified: false, approvalRevoked: false });
    expect(screen.getByRole('heading', { name: /awaiting approval/i })).toBeInTheDocument();
  });
});
