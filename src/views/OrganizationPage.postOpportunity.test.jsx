import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizationPage from './OrganizationPage';
import { api } from '../utils/api';

vi.mock('../utils/api');
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ key: 'chess-club' }),
}));

/**
 * A club page that tells its manager to post, and gives them the way
 * (final audit, Phase 5, 2026-10-04).
 *
 * Walking the app as a club lead: the Opportunities card said "Post an
 * opportunity and it will appear here" and offered no control, and nothing
 * else on the page led to the event form. emptyStateActions.test.jsx states
 * the rule: an empty state need not offer an action, but must not promise
 * one it withholds.
 */

const payload = ({ canPost, events = [] }) => ({
  organization: {
    id: 'org-1', slug: 'chess-club', name: 'Chess Club', description: 'Play chess.',
    memberCount: 1, eventCount: events.length, allowReplies: true, tags: [],
    createdBy: { id: 'user-0', name: 'Member 00' },
  },
  members: [{ id: 'user-0', name: 'Member 00', username: 'm0', memberRole: canPost ? 'manager' : 'member' }],
  events,
  viewer: {
    isMember: true, memberRole: canPost ? 'manager' : 'member', canManage: canPost, canPost,
    affordance: 'member', joinPolicy: 'open', canInvite: canPost, shareLink: null,
    pendingRequests: 0, hours: 0, events: 0, history: [],
  },
  totals: null,
});

function draw(data) {
  api.fetchOrganization.mockResolvedValue(data);
  render(<MemoryRouter><OrganizationPage addToast={vi.fn()} /></MemoryRouter>);
}

describe('posting an opportunity from the club page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchOrganizationAnnouncements.mockResolvedValue({ announcements: [] });
    api.fetchOrganizationAppeals.mockResolvedValue({ appeals: [] });
    api.fetchOrganizationJoinRequests.mockResolvedValue({ requests: [], pendingRequests: 0 });
    api.fetchOrganizationInvitations.mockResolvedValue({ invitations: [] });
    api.fetchOrganizationBans?.mockResolvedValue?.({ bans: [] });
    api.searchDirectory.mockResolvedValue({ users: [], organizations: [] });
  });

  it('gives somebody who may post the button the empty card promises, for this club', async () => {
    draw(payload({ canPost: true }));
    const card = await screen.findByRole('region', { name: /^Events$/ });
    expect(within(card).getByRole('link', { name: /Post an event/i }))
      .toHaveAttribute('href', '/events/new?organization=org-1');
  });

  it('offers nothing to a member who may not post', async () => {
    draw(payload({ canPost: false }));
    const card = await screen.findByRole('region', { name: /^Events$/ });
    expect(within(card).queryByRole('link', { name: /Post an event/i })).toBeNull();
  });
});
