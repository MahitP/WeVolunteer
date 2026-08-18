import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import BannedMembers from './BannedMembers';

/**
 * The organizer's view of who is excluded, and the way back.
 *
 * ── The bug these were written for ──
 *
 * The load handler read `setBans(prev => prev ?? [])`. On a FAILED FIRST LOAD
 * `prev` is null, so the fallback turned it into `[]` — and `[]` is the state
 * that renders "Nobody is banned from …". A manager checking whether somebody
 * was still excluded got a confident "no" produced by a request that never
 * arrived.
 *
 * The comment directly above that line already said an empty list and an
 * unreachable one must not look the same. The code did the opposite of its own
 * documentation, which is why the first test here is the failure path rather
 * than the happy one.
 */
vi.mock('../../utils/api', () => ({
  api: {
    fetchOrganizationBans: vi.fn(),
    liftOrganizationBan: vi.fn(),
  },
}));

const { api } = await import('../../utils/api');

const ban = (over = {}) => ({
  id: 'ban-1',
  reason: 'Repeatedly no-showed booked shifts',
  bannedAt: '2026-07-01T10:00:00Z',
  bannedBy: { name: 'Dana Reyes' },
  user: { id: 'u-7', name: 'Sam Okafor', avatar: null, profilePictureUrl: null },
  appeal: null,
  ...over,
});

const renderCard = (props = {}) => render(
  <BannedMembers orgKey="beach-cleanup" organizationName="Beach Cleanup" {...props} />
);

beforeEach(() => vi.clearAllMocks());

describe('BannedMembers', () => {
  it('says nothing at all when the first load fails', async () => {
    api.fetchOrganizationBans.mockRejectedValue(new Error('network down'));

    const { container } = renderCard();

    await waitFor(() => expect(api.fetchOrganizationBans).toHaveBeenCalled());
    /* The claim, not merely the card: "Nobody is banned" is a statement about
       moderation state, and the request that would have supported it failed. */
    expect(screen.queryByText(/Nobody is banned/i)).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('does say nobody is banned when the server actually says so', async () => {
    /* The counterpart, so the fix above cannot be "never render anything". */
    api.fetchOrganizationBans.mockResolvedValue({ bans: [] });

    renderCard();

    expect(await screen.findByText(/Nobody is banned from Beach Cleanup/i)).toBeInTheDocument();
  });

  it('shows who, why, when and by whom', async () => {
    api.fetchOrganizationBans.mockResolvedValue({ bans: [ban()] });

    renderCard();

    expect(await screen.findByText('Sam Okafor')).toBeInTheDocument();
    expect(screen.getByText(/Repeatedly no-showed booked shifts/)).toBeInTheDocument();
    expect(screen.getByText(/by Dana Reyes/)).toBeInTheDocument();
  });

  it('warns that an appeal is waiting, so a manager does not decide it twice', async () => {
    api.fetchOrganizationBans.mockResolvedValue({
      bans: [ban({ appeal: { pending: true, submittedAt: '2026-07-05T09:00:00Z' } })],
    });

    renderCard();

    expect(await screen.findByText(
      (_, el) => /Appeal waiting since/i.test(el?.textContent ?? '') && el?.tagName === 'P',
    )).toBeInTheDocument();
  });

  it('lifts the ban only after the confirmation is accepted, then reloads', async () => {
    api.fetchOrganizationBans.mockResolvedValue({ bans: [ban()] });
    api.liftOrganizationBan.mockResolvedValue({});
    const addToast = vi.fn();

    renderCard({ addToast });

    fireEvent.click(await screen.findByRole('button', { name: /Unban/i }));
    /* Opening the dialog must not itself be the action. */
    expect(api.liftOrganizationBan).not.toHaveBeenCalled();

    /* The row button and the dialog's confirm share a label — deliberately, it
       is the same verb. The dialog's is the one rendered last. */
    const confirms = await screen.findAllByRole('button', { name: /^Unban$/i });
    fireEvent.click(confirms[confirms.length - 1]);

    await waitFor(() => expect(api.liftOrganizationBan).toHaveBeenCalledWith('beach-cleanup', 'u-7'));
    /* Reloaded rather than patched in memory: the server decides what the list
       is now, and a lift that failed halfway must not leave a stale row gone. */
    await waitFor(() => expect(api.fetchOrganizationBans).toHaveBeenCalledTimes(2));
  });
});
