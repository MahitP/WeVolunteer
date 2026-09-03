/**
 * The organization roster's rank controls.
 *
 * ── What this file is responsible for ──
 *
 * Not authorization. Every refusal is proved server-side in
 * `server/routes.studentOrganizer.test.js`, and a client test that mocked the
 * API could only prove the mock.
 *
 * What it covers is the instruction that no server test can: do not put a
 * control in front of somebody that will answer 403. A member looking at this
 * page must not be offered a promote button whose only possible outcome is a
 * refusal, and the rank somebody holds must be legible without pressing
 * anything.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizationPage from './OrganizationPage';
import { api } from '../utils/api';

vi.mock('../utils/api');
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ key: 'chess-club' }),
}));

const MEMBER = { id: 'user-m', name: 'Priya Patel', username: 'priya', memberRole: 'member' };
const HELPER = { id: 'user-h', name: 'Leo Chen', username: 'leo', memberRole: 'student_organizer' };
const BOSS = { id: 'user-b', name: 'Jordan Whitfield', username: 'jordan', memberRole: 'manager' };

const payload = (viewer) => ({
  organization: {
    id: 'org-1', slug: 'chess-club', name: 'Chess Club', description: 'Play chess.',
    memberCount: 3, eventCount: 0, allowReplies: true, tags: [],
    createdBy: { id: 'user-b', name: 'Jordan Whitfield' },
  },
  members: [BOSS, HELPER, MEMBER],
  events: [],
  viewer: {
    isMember: true, memberRole: null, canManage: false, canPost: false,
    affordance: 'member', joinPolicy: 'open', canInvite: false, shareLink: null,
    pendingRequests: null,
    hours: 0, events: 0, history: [], ...viewer,
  },
  totals: null,
});

const show = async (viewer) => {
  api.fetchOrganization.mockResolvedValue(payload(viewer));
  render(<MemoryRouter><OrganizationPage addToast={vi.fn()} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Chess Club')).toBeInTheDocument());
};

describe('organization roster ranks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.setOrganizationMemberRole.mockResolvedValue({});
    /* The page mounts two children that fetch on their own. Left unmocked, the
       auto-mock returns `undefined`, the `.then` throws inside a passive
       effect, and the WHOLE page unmounts — which reads as "the control is
       correctly absent" on three of the assertions below. Vacuous-pass by
       crash; mocked here so the tests measure the roster instead. */
    api.fetchOrganizationAnnouncements.mockResolvedValue({ announcements: [] });
    api.fetchOrganizationAppeals.mockResolvedValue({ appeals: [] });
    api.fetchOrganizationJoinRequests.mockResolvedValue({ requests: [], pendingRequests: 0 });
    /* The manage band also mounts the invitation panel, which fetches on mount.
       Left unmocked, the auto-mock returns `undefined`, `.then` throws inside a
       passive effect and the WHOLE page unmounts — which reads as "the control is
       correctly absent" on half of these assertions. Vacuous-pass by crash. */
    api.fetchOrganizationInvitations.mockResolvedValue({ invitations: [] });
    api.searchDirectory.mockResolvedValue({ users: [], organizations: [] });
  });

  it('names the rank somebody holds', async () => {
    await show({ memberRole: 'member' });
    expect(screen.getByText('Manager')).toBeInTheDocument();
    expect(screen.getByText('Student organizer')).toBeInTheDocument();
  });

  it('does not label ordinary members', async () => {
    /* "Member" on every row but two is noise; the absence of a tag says it. */
    await show({ memberRole: 'member' });
    expect(screen.queryByText('Member')).toBeNull();
  });

  it('offers no rank control to somebody who cannot manage', async () => {
    /**
     * The instruction this file exists for. `PATCH .../members/:id` answers 403
     * to a member, so a member must never see the button that sends it.
     */
    await show({ memberRole: 'member', canManage: false });
    expect(screen.queryByRole('button', { name: /student organizer/i })).toBeNull();
  });


/**
 * Opens a member's manage menu and returns the item matching `name`.
 *
 * The roster used to render each action as a bare icon button on the row, so a
 * test could reach for it directly. Two unlabelled glyphs side by side is what
 * made the control misread as "open this person's options" when it was in fact
 * an immediate role toggle, so the actions now live behind a named menu — and
 * these cases go through the same two steps a manager does.
 */
async function menuItem(memberName, name) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`Manage ${memberName}`, 'i') }));
  return screen.getByRole('menuitem', { name });
}

  it('offers a manager the control on a member’s row', async () => {
    await show({ memberRole: 'manager', canManage: true });
    /* The label states the action AND the current rank, so promote and demote
       are different sentences rather than one button in two states. */
    const promote = await menuItem('Priya Patel', /Promote to Student Organizer/i);

    fireEvent.click(promote);
    await waitFor(() => expect(api.setOrganizationMemberRole)
      .toHaveBeenCalledWith('chess-club', 'user-m', 'student_organizer'));
  });

  it('turns the same control into a demotion for somebody who holds the rank', async () => {
    await show({ memberRole: 'manager', canManage: true });
    const demote = await menuItem('Leo Chen', /Demote to Student/i);

    fireEvent.click(demote);
    await waitFor(() => expect(api.setOrganizationMemberRole)
      .toHaveBeenCalledWith('chess-club', 'user-h', 'member'));
  });

  it('offers no rank control on a manager’s row', async () => {
    /* A manager already does everything the rank confers, so the toggle would
       be a demotion wearing the word promote. */
    await show({ memberRole: 'manager', canManage: true });
    fireEvent.click(screen.getByRole('button', { name: /Manage Jordan Whitfield/i }));
    expect(screen.queryByRole('menuitem', { name: /Student Organizer/i })).toBeNull();
    /* The menu still exists for a manager — removing and banning one is a real
       thing a peer manager may do. Only the rank item is absent, because the
       server refuses to demote the last manager and demoting a peer belongs
       with a confirmation rather than in a row menu. */
    expect(screen.getByRole('menuitem', { name: /Remove from organization/i })).toBeInTheDocument();
  });

  it('reports a refusal instead of pretending it worked', async () => {
    const addToast = vi.fn();
    api.fetchOrganization.mockResolvedValue(payload({ memberRole: 'manager', canManage: true }));
    api.setOrganizationMemberRole.mockRejectedValue(new Error('This is the only manager.'));
    render(<MemoryRouter><OrganizationPage addToast={addToast} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Chess Club')).toBeInTheDocument());

    fireEvent.click(await menuItem('Priya Patel', /Promote to Student Organizer/i));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('This is the only manager.', 'error'));
  });
});
