/**
 * What a banned student is offered, and what a manager can do about it.
 *
 * ── What this file is responsible for ──
 *
 * Not authorization. Every refusal is proved server-side in
 * `server/routes.organizationModeration.test.js` — including the one that
 * matters most, a student attempting to lift their own ban — and a client test
 * against a mocked API could only ever prove the mock.
 *
 * What it covers is the thing no server test can: do not put a control in front
 * of somebody whose only possible outcome is a refusal. A banned student was
 * shown an ordinary Join button. The server refused it, correctly, so the button
 * was not a hole — it was a lie, and the student had no way to learn what had
 * actually happened or what to do next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizationPage from './OrganizationPage';
import { api } from '../utils/api';

vi.mock('../utils/api');
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ key: 'chess-club' }),
}));

const MEMBER = { id: 'user-m', name: 'Priya Patel', username: 'priya', memberRole: 'member' };
const BOSS = { id: 'user-b', name: 'Jordan Whitfield', username: 'jordan', memberRole: 'manager' };

/**
 * The affordance the SERVER would compute for this viewer.
 *
 * The page renders `viewer.affordance` and derives nothing, so a fixture that
 * handed it a ban while the affordance still said `join` would be testing a
 * state the server cannot produce — and the assertions below would be measuring
 * the fixture rather than the page. Derived here, in the one place, so each case
 * can go on being about bans.
 */
const affordanceFor = (viewer) => {
  if (viewer?.affordance) return viewer.affordance;
  if (viewer?.ban) return 'banned';
  if (viewer?.isMember) return 'member';
  return 'join';
};

const payload = (viewer) => ({
  organization: {
    id: 'org-1', slug: 'chess-club', name: 'Chess Club', description: 'Play chess.',
    memberCount: 2, eventCount: 0, allowReplies: true, tags: [],
    createdBy: { id: 'user-b', name: 'Jordan Whitfield' },
  },
  members: [BOSS, MEMBER],
  events: [],
  viewer: {
    isMember: false, memberRole: null, canManage: false, canPost: false,
    joinPolicy: 'open', canInvite: false, shareLink: null, pendingRequests: null,
    hours: 0, events: 0, history: [], ban: null, ...viewer,
    /* After the spread: computed from what the case actually set. */
    affordance: affordanceFor(viewer),
  },
  totals: null,
});

const show = async (viewer) => {
  api.fetchOrganization.mockResolvedValue(payload(viewer));
  const utils = render(<MemoryRouter><OrganizationPage addToast={vi.fn()} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Chess Club')).toBeInTheDocument());
  return utils;
};

const BAN = { reason: 'Missed three shifts without telling anyone.', bannedAt: '2026-08-12T10:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  /**
   * The page mounts three children that fetch on their own. Left unmocked, the
   * auto-mock returns `undefined`, the `.then` throws inside a passive effect,
   * and the WHOLE page unmounts — which reads as "the control is correctly
   * absent" on half the assertions below. Vacuous-pass by crash; see the same
   * note in OrganizationPage.roster.test.jsx.
   */
  api.fetchOrganizationAnnouncements.mockResolvedValue({ announcements: [] });
  api.fetchOrganizationAppeals.mockResolvedValue({ appeals: [] });
  api.fetchOrganizationBans.mockResolvedValue({ bans: [] });
  api.fetchOrganizationJoinRequests.mockResolvedValue({ requests: [], pendingRequests: 0 });
  api.joinOrganizationWithInvite.mockResolvedValue({});
  api.liftOrganizationBan.mockResolvedValue({});
});

describe('what a banned student sees instead of Join', () => {
  it('offers Join to somebody who is not banned', async () => {
    await show({ ban: null });
    expect(screen.getByRole('button', { name: /^Join Chess Club$/ })).toBeInTheDocument();
  });

  it('takes the Join button away once they are banned', async () => {
    /* The defect this file exists for. */
    await show({ ban: { ...BAN, appeal: null } });
    expect(screen.queryByRole('button', { name: /^Join Chess Club$/ })).not.toBeInTheDocument();
  });

  it('offers an appeal instead, as a link to the appeal form for this club', async () => {
    await show({ ban: { ...BAN, appeal: null } });
    const appeal = screen.getByRole('link', { name: /Appeal/ });
    expect(appeal).toHaveAttribute('href', expect.stringContaining('subject=organization_ban'));
    expect(appeal).toHaveAttribute('href', expect.stringContaining('organization=org-1'));
  });

  it('says they are banned, and why', async () => {
    /* The reason is what any appeal is heard against. Somebody told they are
       banned and not told why has nothing to answer. */
    await show({ ban: { ...BAN, appeal: null } });
    expect(screen.getByText(/You are banned from Chess Club/)).toBeInTheDocument();
    expect(screen.getByText(/Missed three shifts without telling anyone\./)).toBeInTheDocument();
  });

  it('shows a disabled "Appeal sent" once an appeal is pending', async () => {
    await show({
      ban: { ...BAN, appeal: { status: 'open', pending: true, submittedAt: '2026-08-13T09:00:00.000Z', decision: null } },
    });
    const sent = screen.getByRole('button', { name: /Appeal sent/ });
    expect(sent).toBeDisabled();
    /* And no second route to filing another — the appeals route refuses
       duplicates, so offering one would only produce a rejection. */
    expect(screen.queryByRole('link', { name: /^Appeal$/ })).not.toBeInTheDocument();
  });

  it('goes back to Join once the ban is lifted', async () => {
    await show({ ban: null, isMember: false });
    expect(screen.getByRole('button', { name: /^Join Chess Club$/ })).toBeInTheDocument();
    expect(screen.queryByText(/You are banned/)).not.toBeInTheDocument();
  });

  it('does not tell the banned person which manager pressed the button', async () => {
    /**
     * It is the club's decision. Naming one manager to the person they excluded
     * invites the conversation to go around the process rather than through it.
     *
     * Scoped to the ban notice deliberately: "Jordan Whitfield" is on this page
     * anyway, as the founder and in the roster, so an unscoped query would fail
     * for a reason that has nothing to do with the ban.
     */
    await show({ ban: { ...BAN, appeal: null } });
    const notice = screen.getByRole('note');
    expect(notice).toHaveTextContent(/You are banned from Chess Club/);
    expect(notice).not.toHaveTextContent(/Jordan Whitfield/i);
    expect(notice).not.toHaveTextContent(/banned by/i);
  });
});

describe('the moderation area a manager sees', () => {
  const BANNED_ROW = {
    id: 'orgban-1',
    user: { id: 'user-x', name: 'Sam Rivera', username: 'sam', avatar: '🙂', profilePictureUrl: null },
    reason: 'Repeatedly abusive in the comments.',
    bannedAt: '2026-08-12T10:00:00.000Z',
    bannedBy: { id: 'user-b', name: 'Jordan Whitfield' },
    appeal: null,
  };

  it('is not rendered for an ordinary member', async () => {
    await show({ isMember: true, canManage: false });
    expect(screen.queryByText(/Banned members/)).not.toBeInTheDocument();
    expect(api.fetchOrganizationBans).not.toHaveBeenCalled();
  });

  it('says plainly when nobody is banned rather than disappearing', async () => {
    await show({ isMember: true, canManage: true, memberRole: 'manager' });
    await waitFor(() => expect(screen.getByText(/Banned members/)).toBeInTheDocument());
    expect(screen.getByText(/Nobody is banned from Chess Club\./)).toBeInTheDocument();
  });

  it('lists a banned person with the reason, the date and who issued it', async () => {
    api.fetchOrganizationBans.mockResolvedValue({ bans: [BANNED_ROW] });
    await show({ isMember: true, canManage: true, memberRole: 'manager' });

    await waitFor(() => expect(screen.getByText('Sam Rivera')).toBeInTheDocument());
    expect(screen.getByText(/Repeatedly abusive in the comments\./)).toBeInTheDocument();
    expect(screen.getByText(/by Jordan Whitfield/)).toBeInTheDocument();
  });

  it('offers Unban without requiring an appeal first', async () => {
    /* An appeal is one route out, not the only one. */
    api.fetchOrganizationBans.mockResolvedValue({ bans: [BANNED_ROW] });
    await show({ isMember: true, canManage: true, memberRole: 'manager' });
    await waitFor(() => expect(screen.getByText('Sam Rivera')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /Unban/ })).toBeInTheDocument();
  });

  it('confirms before unbanning, and says membership is not restored', async () => {
    api.fetchOrganizationBans.mockResolvedValue({ bans: [BANNED_ROW] });
    await show({ isMember: true, canManage: true, memberRole: 'manager' });
    await waitFor(() => expect(screen.getByText('Sam Rivera')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Unban/ }));

    expect(await screen.findByText(/Unban Sam Rivera\?/)).toBeInTheDocument();
    /* The manager who expects the roster to change and sees it not change will
       press the button again. */
    expect(screen.getByText(/not added back automatically/i)).toBeInTheDocument();
    /* Nothing sent yet — confirmation is a real gate, not a formality. */
    expect(api.liftOrganizationBan).not.toHaveBeenCalled();
  });

  it('lifts the ban through the scoped endpoint when confirmed', async () => {
    api.fetchOrganizationBans.mockResolvedValue({ bans: [BANNED_ROW] });
    await show({ isMember: true, canManage: true, memberRole: 'manager' });
    await waitFor(() => expect(screen.getByText('Sam Rivera')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Unban/ }));

    /* Scoped to the dialog: the row's own Unban button is still in the document
       behind it, so an unscoped `^Unban$` matches two controls. */
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Unban$/ }));

    await waitFor(() => expect(api.liftOrganizationBan).toHaveBeenCalledWith('chess-club', 'user-x'));
  });

  it('warns that an open appeal is not decided by unbanning here', async () => {
    /* The two routes are independent by design: lifting is not a decision on
       the appeal, and silently closing it would file a verdict nobody made. */
    api.fetchOrganizationBans.mockResolvedValue({
      bans: [{ ...BANNED_ROW, appeal: { status: 'open', pending: true, submittedAt: '2026-08-13T09:00:00.000Z', decision: null } }],
    });
    await show({ isMember: true, canManage: true, memberRole: 'manager' });
    await waitFor(() => expect(screen.getByText('Sam Rivera')).toBeInTheDocument());

    expect(screen.getByText(/Appeal waiting since/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Unban/ }));
    expect(await screen.findByText(/Their appeal stays open/)).toBeInTheDocument();
  });
});
