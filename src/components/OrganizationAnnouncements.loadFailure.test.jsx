import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import OrganizationAnnouncements from './OrganizationAnnouncements';

/**
 * "Nothing announced yet" is a claim about what the organization has posted.
 *
 * The load used to end in `.catch(() => setAnnouncements([]))`, and the empty
 * branch renders that sentence — so a member whose request failed was told the
 * club had posted nothing. Unlike the sibling cards this list starts as `[]`
 * rather than null, so leaving the state untouched was not enough; the failure
 * needed a state of its own.
 */
vi.mock('../utils/api', () => ({
  api: {
    fetchOrganizationAnnouncements: vi.fn(),
    postOrganizationAnnouncement: vi.fn(),
    deleteOrganizationAnnouncement: vi.fn(),
    fetchAnnouncementReplies: vi.fn(),
  },
}));

const { api } = await import('../utils/api');

const renderCard = (addToast) => render(
  <OrganizationAnnouncements orgKey="beach-cleanup" canManage={false} isMember addToast={addToast} />
);

beforeEach(() => vi.clearAllMocks());

describe('OrganizationAnnouncements load failure', () => {
  it('does not claim nothing was announced when the request failed', async () => {
    api.fetchOrganizationAnnouncements.mockRejectedValue(new Error('network down'));
    const addToast = vi.fn();

    renderCard(addToast);

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][1]).toBe('error');
    expect(screen.queryByText(/Nothing announced yet/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });

  it('does claim it when the organization really has posted nothing', async () => {
    api.fetchOrganizationAnnouncements.mockResolvedValue({ announcements: [] });
    const addToast = vi.fn();

    renderCard(addToast);

    expect(await screen.findByText(/Nothing announced yet/i)).toBeInTheDocument();
    expect(addToast).not.toHaveBeenCalled();
  });
});
