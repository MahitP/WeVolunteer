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
  viewer: { isMember: true, memberRole: null, canManage: false, canPost: false, hours: 0, events: 0, history: [], ...viewer },
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

  it('offers a manager the control on a member’s row', async () => {
    await show({ memberRole: 'manager', canManage: true });
    const promote = screen.getByRole('button', { name: /Make Priya Patel a student organizer/i });
    expect(promote).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(promote);
    await waitFor(() => expect(api.setOrganizationMemberRole)
      .toHaveBeenCalledWith('chess-club', 'user-m', 'student_organizer'));
  });

  it('turns the same control into a demotion for somebody who holds the rank', async () => {
    await show({ memberRole: 'manager', canManage: true });
    const demote = screen.getByRole('button', { name: /Remove Leo Chen as a student organizer/i });
    expect(demote).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(demote);
    await waitFor(() => expect(api.setOrganizationMemberRole)
      .toHaveBeenCalledWith('chess-club', 'user-h', 'member'));
  });

  it('offers no rank control on a manager’s row', async () => {
    /* A manager already does everything the rank confers, so the toggle would
       be a demotion wearing the word promote. */
    await show({ memberRole: 'manager', canManage: true });
    expect(screen.queryByRole('button', { name: /Jordan Whitfield.*student organizer/i })).toBeNull();
  });

  it('reports a refusal instead of pretending it worked', async () => {
    const addToast = vi.fn();
    api.fetchOrganization.mockResolvedValue(payload({ memberRole: 'manager', canManage: true }));
    api.setOrganizationMemberRole.mockRejectedValue(new Error('This is the only manager.'));
    render(<MemoryRouter><OrganizationPage addToast={addToast} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Chess Club')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Make Priya Patel a student organizer/i }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('This is the only manager.', 'error'));
  });
});
