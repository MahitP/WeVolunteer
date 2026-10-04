import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizationPage from './OrganizationPage';
import { api } from '../utils/api';

vi.mock('../utils/api');
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ key: 'chess-club' }),
}));

/**
 * A club seen by the person who runs it (owner ruling 25, 2026-10-04).
 *
 * Walking the app as a club lead: their own club said "You are a member", and
 * its rail opened on "Your service here", a volunteer's record of hours at
 * the club's events, shown to an adult organizer who cannot earn any.
 */

const ORGANIZER = { id: 'user-0', role: 'organizer', verified: true, grants: [], withheld: [] };
const STUDENT = { id: 'user-1', role: 'student', verified: true, grants: [], withheld: [] };

const payload = ({ manager }) => ({
  organization: {
    id: 'org-1', slug: 'chess-club', name: 'Chess Club', description: 'Play chess.',
    memberCount: 2, eventCount: 0, allowReplies: true, tags: [],
    createdBy: { id: 'user-0', name: 'Member 00' },
  },
  members: [
    { id: 'user-0', name: 'Member 00', username: 'm0', memberRole: 'manager' },
    { id: 'user-1', name: 'Member 01', username: 'm1', memberRole: 'member' },
  ],
  events: [],
  viewer: {
    isMember: true, memberRole: manager ? 'manager' : 'member', canManage: manager, canPost: manager,
    affordance: 'member', joinPolicy: 'open', canInvite: manager, shareLink: null,
    pendingRequests: 0, hours: 0, events: 0, history: [],
  },
  totals: null,
});

function draw(data, currentUser) {
  api.fetchOrganization.mockResolvedValue(data);
  render(<MemoryRouter><OrganizationPage addToast={vi.fn()} currentUser={currentUser} /></MemoryRouter>);
}

describe('a club seen by the person who runs it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchOrganizationAnnouncements.mockResolvedValue({ announcements: [] });
    api.fetchOrganizationAppeals.mockResolvedValue({ appeals: [] });
    api.fetchOrganizationJoinRequests.mockResolvedValue({ requests: [], pendingRequests: 0 });
    api.fetchOrganizationInvitations.mockResolvedValue({ invitations: [] });
    api.fetchOrganizationBans?.mockResolvedValue?.({ bans: [] });
    api.searchDirectory.mockResolvedValue({ users: [], organizations: [] });
  });

  it('says they manage it, and leaves out the volunteer\'s service card', async () => {
    draw(payload({ manager: true }), ORGANIZER);
    expect(await screen.findByText('You manage this organization')).toBeInTheDocument();
    expect(screen.queryByText('You are a member')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your service here' })).toBeNull();
  });

  it('is unchanged for a student member', async () => {
    draw(payload({ manager: false }), STUDENT);
    expect(await screen.findByText('You are a member')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your service here' })).toBeInTheDocument();
  });
});
