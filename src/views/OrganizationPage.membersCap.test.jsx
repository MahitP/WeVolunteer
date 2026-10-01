import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import OrganizationPage from './OrganizationPage';
import { api } from '../utils/api';

vi.mock('../utils/api');
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ key: 'chess-club' }),
}));

/** Where the router ended up, after any redirect the page made. */
function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

/* Fifteen members — more than the page shows before "Show all". */
const MEMBERS = Array.from({ length: 15 }, (_, i) => ({
  id: `user-${i}`, name: `Member ${String(i).padStart(2, '0')}`, username: `m${i}`,
  memberRole: i === 0 ? 'manager' : 'member',
}));

const payload = () => ({
  organization: {
    id: 'org-1', slug: 'chess-club', name: 'Chess Club', description: 'Play chess.',
    memberCount: 15, eventCount: 0, allowReplies: true, tags: [],
    createdBy: { id: 'user-0', name: 'Member 00' },
  },
  members: MEMBERS,
  events: [],
  viewer: {
    isMember: true, memberRole: 'manager', canManage: true, canPost: true,
    affordance: 'member', joinPolicy: 'open', canInvite: true, shareLink: null,
    pendingRequests: 0, hours: 0, events: 0, history: [],
  },
  totals: null,
});

/**
 * N11: a club page listed every member, one row each, before anything below
 * it — 39 rows on a phone in the rehearsal. The page shows the first few and
 * "Show all N members" opens the full roster on its own page, where a
 * manager's Manage menu works on every member.
 */
describe('the club roster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchOrganization.mockResolvedValue(payload());
    api.fetchOrganizationAnnouncements.mockResolvedValue({ announcements: [] });
    api.fetchOrganizationAppeals.mockResolvedValue({ appeals: [] });
    api.fetchOrganizationJoinRequests.mockResolvedValue({ requests: [], pendingRequests: 0 });
    api.fetchOrganizationInvitations.mockResolvedValue({ invitations: [] });
    api.fetchOrganizationBans?.mockResolvedValue?.({ bans: [] });
    api.searchDirectory.mockResolvedValue({ users: [], organizations: [] });
  });

  it('shows the first ten on the club page and links to the rest', async () => {
    render(<MemoryRouter><OrganizationPage addToast={vi.fn()} /></MemoryRouter>);
    const roster = await screen.findByRole('region', { name: /^Members$/ });
    expect(within(roster).getAllByText(/^Member \d\d$/)).toHaveLength(10);
    expect(within(roster).getByRole('link', { name: /Show all 15 members/i }))
      .toHaveAttribute('href', '/organizations/@chess-club/members');
  });

  it('shows every member, with Manage on each, on the members page', async () => {
    render(<MemoryRouter><OrganizationPage addToast={vi.fn()} currentUser={{ id: 'user-0' }} view="members" /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText(/^Member \d\d$/)).toHaveLength(15));
    expect(screen.getAllByRole('button', { name: /^Manage /i }).length).toBe(14); // everyone but yourself
    expect(screen.getByRole('link', { name: /Back to Chess Club/i })).toHaveAttribute('href', '/organizations/@chess-club');
  });

  /* The server sends a hundred members per request. A club bigger than that
     has the rest read on demand, so "Show all" still means all. */
  it('reads the rest of a long roster on demand', async () => {
    const big = payload();
    big.organization.memberCount = 15;
    big.members = MEMBERS.slice(0, 10);
    api.fetchOrganization
      .mockResolvedValueOnce(big)
      .mockResolvedValueOnce({ ...payload(), members: MEMBERS.slice(10) });
    render(<MemoryRouter><OrganizationPage addToast={vi.fn()} currentUser={{ id: 'user-0' }} view="members" /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText(/^Member \d\d$/)).toHaveLength(10));
    fireEvent.click(screen.getByRole('button', { name: /Show more members/i }));
    await waitFor(() => expect(screen.getAllByText(/^Member \d\d$/)).toHaveLength(15));
    expect(api.fetchOrganization).toHaveBeenLastCalledWith('chess-club', { membersFrom: 10 });
    expect(screen.queryByRole('button', { name: /Show more members/i })).toBeNull();
  });

  /* The page moves a non-canonical address (an id, a bare handle) to
     `/organizations/@handle`. On the members page it moved it to the club
     page, so "Show all" opened the roster and immediately left it. */
  it('stays on the members page when it tidies the address', async () => {
    render(
      <MemoryRouter initialEntries={['/organizations/chess-club/members']}>
        <OrganizationPage addToast={vi.fn()} currentUser={{ id: 'user-0' }} view="members" />
        <Where />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/organizations/@chess-club/members'));
    expect(screen.getAllByText(/^Member \d\d$/)).toHaveLength(15);
  });
});
