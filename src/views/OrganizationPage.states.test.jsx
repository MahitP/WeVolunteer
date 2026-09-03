import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizationPage from './OrganizationPage';
import { api } from '../utils/api';
import { rememberPendingInvite } from '../utils/pendingInvite';

/**
 * The one primary control, in each of the states the server can report.
 *
 * ── What this file is responsible for, and what it is not ──
 *
 * Not authorization. Every refusal is proved server-side in
 * `server/routes.organizationJoinPolicy.test.js`, and a client test that mocked
 * the API could only prove the mock.
 *
 * What it covers is the instruction no server test can: do not put a control in
 * front of somebody that the server will refuse, and do not leave somebody with
 * no control and no explanation. Seven affordances, and for each one the label
 * somebody actually reads and the endpoint the press actually calls.
 *
 * It also pins the two things the redesign is FOR. The primary action names the
 * club, so a reader knows what pressing it does. And the sentence under it says
 * what to do about the state they are in — which is the difference between a
 * badge reading "Invitation only" and a page that tells somebody to ask for the
 * link.
 */

vi.mock('../utils/api');
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ key: 'chess-club' }),
}));

const BOSS = { id: 'user-b', name: 'Jordan Whitfield', username: 'jordan', memberRole: 'manager' };
const MEMBER = { id: 'user-m', name: 'Priya Patel', username: 'priya', memberRole: 'member' };

const payload = ({ organization, viewer, members, ...rest } = {}) => ({
  organization: {
    id: 'org-1', slug: 'chess-club', name: 'Chess Club', description: 'Play chess.',
    memberCount: 2, eventCount: 0, allowReplies: true, tags: [],
    joinPolicy: 'open', invitePolicy: 'helpers',
    createdAt: '2024-09-01T00:00:00.000Z',
    createdBy: { id: 'user-b', name: 'Jordan Whitfield' },
    ...organization,
  },
  members: members ?? [BOSS, MEMBER],
  events: [],
  viewer: {
    isMember: false, memberRole: null, canManage: false, canPost: false,
    affordance: 'join', joinPolicy: 'open', canInvite: false, shareLink: null,
    pendingRequests: null, ban: null,
    hours: 0, events: 0, history: [],
    ...viewer,
  },
  totals: null,
  ...rest,
});

const show = async (over) => {
  api.fetchOrganization.mockResolvedValue(payload(over));
  const utils = render(<MemoryRouter><OrganizationPage addToast={vi.fn()} currentUser={{ id: 'user-x' }} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Chess Club')).toBeInTheDocument());
  return utils;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  /* The page mounts children that fetch on their own. Left unmocked, the
     auto-mock returns `undefined`, `.then` throws inside a passive effect, and
     the WHOLE page unmounts — which reads as "the control is correctly absent"
     on half of these assertions. Vacuous-pass by crash. */
  api.fetchOrganizationAnnouncements.mockResolvedValue({ announcements: [] });
  api.fetchOrganizationAppeals.mockResolvedValue({ appeals: [] });
  api.fetchOrganizationBans.mockResolvedValue({ bans: [] });
  api.fetchOrganizationJoinRequests.mockResolvedValue({ requests: [], pendingRequests: 0 });
  api.fetchOrganizationShareLinks.mockResolvedValue({
    links: [], canManage: false, canCreate: false, maxLinks: 10,
  });
  api.fetchOrganizationInvitations.mockResolvedValue({ invitations: [] });
  api.searchDirectory.mockResolvedValue({ users: [], organizations: [] });
  api.joinOrganizationWithInvite.mockResolvedValue({});
  api.requestToJoinOrganization.mockResolvedValue({ created: true });
  api.withdrawOrganizationJoinRequest.mockResolvedValue({});
  api.leaveOrganization.mockResolvedValue({});
});

describe('the primary action', () => {
  it('names the club on an open organization', async () => {
    await show();
    expect(screen.getByRole('button', { name: /^Join Chess Club$/ })).toBeInTheDocument();
    expect(screen.getByText('Anyone can join Chess Club.')).toBeInTheDocument();
  });

  it('joins through the endpoint that carries a token, with none to carry', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    await waitFor(() => expect(api.joinOrganizationWithInvite).toHaveBeenCalledWith('chess-club', undefined));
  });

  /**
   * Asking opens a composer rather than firing.
   *
   * The press used to send immediately. It now opens a dialog with an optional
   * note, because a manager deciding about a request had only a name and an
   * avatar to go on — which for a school club is frequently a choice between two
   * students with the same first name.
   */
  it('asks rather than joins on an organization that approves members', async () => {
    await show({ viewer: { affordance: 'request', joinPolicy: 'request' }, organization: { joinPolicy: 'request' } });
    expect(screen.queryByRole('button', { name: /^Join/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Request to join/ }));
    /* The dialog, not the request. Nothing has been sent yet. */
    await screen.findByRole('dialog', { name: /Request to join Chess Club/ });
    expect(api.requestToJoinOrganization).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Send request/ }));
    /* `undefined`, not an empty string: an empty note is stored as NULL, and a
       club that turned request-to-join on must not have created a form a shy
       thirteen-year-old cannot get past. */
    await waitFor(() => expect(api.requestToJoinOrganization).toHaveBeenCalledWith('chess-club', undefined));
  });

  it('sends the note the student wrote', async () => {
    await show({ viewer: { affordance: 'request', joinPolicy: 'request' }, organization: { joinPolicy: 'request' } });
    fireEvent.click(screen.getByRole('button', { name: /Request to join/ }));
    await screen.findByRole('dialog');

    fireEvent.change(screen.getByLabelText(/Anything you want them to know/), {
      target: { value: "  I'm in Ms Chen's class.  " },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send request/ }));

    /* Trimmed, because the surrounding whitespace is not part of what they
       wrote and the server would trim it anyway. */
    await waitFor(() => expect(api.requestToJoinOrganization)
      .toHaveBeenCalledWith('chess-club', "I'm in Ms Chen's class."));
  });

  it('refuses to send a note past the limit, and says how far past', async () => {
    await show({ viewer: { affordance: 'request', joinPolicy: 'request' }, organization: { joinPolicy: 'request' } });
    fireEvent.click(screen.getByRole('button', { name: /Request to join/ }));
    await screen.findByRole('dialog');

    fireEvent.change(screen.getByLabelText(/Anything you want them to know/), {
      target: { value: 'x'.repeat(312) },
    });
    expect(screen.getByText('12 characters too many.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send request/ })).toBeDisabled();
  });

  it('shows a pending request as sent, and offers taking it back rather than sending another', async () => {
    await show({
      viewer: {
        affordance: 'pending', joinPolicy: 'request',
        joinRequest: { submittedAt: '2026-09-01T09:00:00.000Z' },
      },
    });

    const sent = screen.getByRole('button', { name: /Request sent/ });
    expect(sent).toBeDisabled();
    /* No second route to filing another — the route reports the existing one, so
       offering a second button would only look like it did something. */
    expect(screen.queryByRole('button', { name: /Request to join/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /More actions for Chess Club/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Take back my request/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Take it back$/ }));
    await waitFor(() => expect(api.withdrawOrganizationJoinRequest).toHaveBeenCalledWith('chess-club'));
  });

  /**
   * The state the whole feature turns on.
   *
   * A closed door with a sign on it, not a wall: the control says what is
   * missing and the sentence says how to get it. A page that simply omitted the
   * action would read as the club being broken.
   */
  it('says an invitation is required, and how to get one', async () => {
    await show({
      viewer: { affordance: 'invite_required', joinPolicy: 'invite' },
      organization: { joinPolicy: 'invite' },
    });

    expect(screen.getByRole('button', { name: /Invitation required/ })).toBeDisabled();
    expect(screen.getByText(/Ask somebody in it for the link/)).toBeInTheDocument();
    expect(api.joinOrganizationWithInvite).not.toHaveBeenCalled();
  });

  /**
   * A reader who arrived through a link gets the ordinary Join, and the token
   * travels with the press.
   *
   * The server cannot know they hold one — the token is never sent to a GET, so
   * it reports `invite_required` — and this optimism grants nothing: the server
   * re-resolves the token on the press and refuses it if it has been replaced.
   */
  it('offers Join to somebody holding the link, and sends the token', async () => {
    const token = 'b'.repeat(64);
    rememberPendingInvite({ slug: 'chess-club', token });

    await show({
      viewer: { affordance: 'invite_required', joinPolicy: 'invite' },
      organization: { joinPolicy: 'invite' },
    });

    expect(screen.queryByRole('button', { name: /Invitation required/ })).not.toBeInTheDocument();
    /* And the sentence agrees with the button. This was the defect: the control
       said Join while the line beneath it told them to ask somebody for a link. */
    expect(screen.getByText('You have an invitation, so you can join now.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    await waitFor(() => expect(api.joinOrganizationWithInvite).toHaveBeenCalledWith('chess-club', token));
  });

  it('does not offer another club’s link on this club', async () => {
    rememberPendingInvite({ slug: 'robotics', token: 'c'.repeat(64) });
    await show({
      viewer: { affordance: 'invite_required', joinPolicy: 'invite' },
      organization: { joinPolicy: 'invite' },
    });
    expect(screen.getByRole('button', { name: /Invitation required/ })).toBeDisabled();
  });

  /**
   * A member's primary control is a STATE, not an action.
   *
   * Leaving used to occupy the position a newcomer's Join occupies, which made
   * the loudest control on a member's page the one that ends their membership.
   */
  it('shows a member their state, and moves leaving into the menu', async () => {
    await show({ viewer: { affordance: 'member', isMember: true, memberRole: 'member' } });

    expect(screen.getByText('You are a member')).toBeInTheDocument();
    /* Not a button anywhere on the page — only a menu item behind the trigger. */
    expect(screen.queryByRole('button', { name: /^Leave/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /More actions for Chess Club/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Leave Chess Club/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Leave$/ }));
    await waitFor(() => expect(api.leaveOrganization).toHaveBeenCalledWith('chess-club'));
  });

  /**
   * The confirmation says what coming back would cost, which depends on the
   * policy — a member of an invitation-only club needs the link again.
   */
  it('warns a member of an invitation-only club what leaving means', async () => {
    await show({
      viewer: { affordance: 'member', isMember: true, joinPolicy: 'invite' },
      organization: { joinPolicy: 'invite' },
    });
    fireEvent.click(screen.getByRole('button', { name: /More actions for Chess Club/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Leave Chess Club/ }));
    expect(screen.getByText(/would need its link to come back/)).toBeInTheDocument();
  });

  it('offers nothing at all on an archived organization', async () => {
    await show({
      viewer: { affordance: 'unavailable' },
      organization: { status: 'archived' },
    });
    expect(screen.queryByRole('button', { name: /Join|Request/ })).not.toBeInTheDocument();
    expect(screen.getByText('This organization is not taking new members.')).toBeInTheDocument();
  });
});

describe('sharing', () => {
  it('is offered only to somebody the server says may invite', async () => {
    await show({ viewer: { affordance: 'member', isMember: true, canInvite: false } });
    expect(screen.queryByRole('button', { name: /^Share$/ })).not.toBeInTheDocument();
  });

  it('opens the dialog for somebody who may', async () => {
    await show({
      viewer: {
        affordance: 'member', isMember: true, canInvite: true,
        shareLink: { exists: true, createdAt: '2026-09-01T09:00:00.000Z', label: 'General' },
      },
    });
    api.fetchOrganizationShareLinks.mockResolvedValue({
      links: [{
        id: 'oshl-1', path: `/organizations/invite/${'d'.repeat(64)}`, label: 'General',
        state: 'live', createdAt: '2026-09-01T09:00:00.000Z', expiresAt: null,
      }],
      canManage: false, canCreate: false, maxLinks: 10,
    });

    fireEvent.click(screen.getByRole('button', { name: /^Share$/ }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Share Chess Club/ })).toBeInTheDocument());
  });
});

describe('the management area', () => {
  it('is absent for a member', async () => {
    await show({ viewer: { affordance: 'member', isMember: true } });
    expect(screen.queryByRole('heading', { name: /Manage Chess Club/ })).not.toBeInTheDocument();
  });

  it('is a visibly separate section for a manager, and says so', async () => {
    await show({ viewer: { affordance: 'member', isMember: true, memberRole: 'manager', canManage: true } });
    expect(screen.getByRole('heading', { name: /Manage Chess Club/ })).toBeInTheDocument();
    expect(screen.getByText(/Only managers of this organization see this section/)).toBeInTheDocument();
  });

  it('offers a manager the settings screen without opening a menu', async () => {
    await show({ viewer: { affordance: 'member', isMember: true, memberRole: 'manager', canManage: true } });
    /* The CANONICAL address. A rename no longer moves a club's handle, so the
       handle is the address everywhere in the product — including the links
       inside it. */
    expect(screen.getByRole('link', { name: /Settings/ }))
      .toHaveAttribute('href', '/organizations/@chess-club/edit');
  });
});

describe('the roster', () => {
  /**
   * The server sends `members: []` to a non-member, so the page cannot render a
   * name it was not given. The card stays and says how many there are, because
   * a reader deciding whether to join needs to tell a club of forty from a club
   * of nobody.
   */
  it('shows a non-member the count and an explanation instead of names', async () => {
    await show({ members: [], organization: { memberCount: 42 } });
    /* The count lives in the card head; the empty state says the rule. Saying
       the number twice in one card was the duplication this replaced. */
    const roster = screen.getByRole('heading', { name: 'Members' }).closest('.card');
    expect(roster).toHaveTextContent('42');
    expect(screen.getByRole('heading', { name: 'The roster is private' })).toBeInTheDocument();
    expect(screen.getByText(/shown to its members/)).toBeInTheDocument();
    expect(screen.queryByText('Priya Patel')).not.toBeInTheDocument();
  });

  it('shows a member the names', async () => {
    await show({ viewer: { affordance: 'member', isMember: true } });
    expect(screen.getByText('Priya Patel')).toBeInTheDocument();
    /* Scoped to the roster ROW, because the founder's name is also in the About
       card — a separate, deliberate disclosure — and an unscoped query would
       pass on either. */
    const roster = screen.getByRole('heading', { name: 'Members' }).closest('.card');
    expect(roster).toHaveTextContent('Jordan Whitfield');
    expect(roster).toHaveTextContent('@jordan');
    expect(roster).toHaveTextContent('Manager');
  });

  it('says a genuinely empty club is empty', async () => {
    await show({ members: [], organization: { memberCount: 0 } });
    expect(screen.getByText('No members yet')).toBeInTheDocument();
  });
});

describe('the masthead', () => {
  it('carries the counts and the founding year in one line', async () => {
    await show({ organization: { memberCount: 42, eventCount: 11 } });
    expect(screen.getByText('Since 2024')).toBeInTheDocument();
    expect(screen.getByText('42 members')).toBeInTheDocument();
    expect(screen.getByText('11 opportunities')).toBeInTheDocument();
  });

  it('says "member" and "opportunity" in the singular', async () => {
    await show({ organization: { memberCount: 1, eventCount: 1 } });
    expect(screen.getByText('1 member')).toBeInTheDocument();
    expect(screen.getByText('1 opportunity')).toBeInTheDocument();
  });

  it('leaves the count out of the charter line when there are no opportunities', async () => {
    await show({ organization: { eventCount: 0 } });
    /* "Opportunities" is also a section heading, so this asserts the absence of
       the charter line's counted form rather than of the word. */
    expect(screen.queryByText(/^\d+ opportunit/)).not.toBeInTheDocument();
  });

  /**
   * A club with no logo, no emoji, no description and no tags still has to
   * render as a club rather than as an empty card.
   */
  it('renders a club with nothing but a name', async () => {
    await show({
      organization: {
        description: '', tags: [], avatar: null, imageUrl: null, avatarColor: null,
        memberCount: 0, eventCount: 0, createdAt: null,
      },
      members: [],
    });
    expect(screen.getByRole('heading', { name: 'Chess Club' })).toBeInTheDocument();
    expect(screen.queryByText(/^Since/)).not.toBeInTheDocument();
  });

  it('renders a very long name without dropping the action', async () => {
    const name = 'Example Valley High School Environmental Action and Sustainability Club';
    api.fetchOrganization.mockResolvedValue(payload({ organization: { name } }));
    render(<MemoryRouter><OrganizationPage addToast={vi.fn()} currentUser={{ id: 'user-x' }} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: new RegExp(`^Join ${name}$`) })).toBeInTheDocument();
  });
});

describe('loading and failing', () => {
  it('says nothing exists rather than showing an error for a missing club', async () => {
    api.fetchOrganization.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
    render(<MemoryRouter><OrganizationPage addToast={vi.fn()} currentUser={{ id: 'user-x' }} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('No organization here')).toBeInTheDocument());
  });

  it('offers a retry when the load failed for another reason', async () => {
    api.fetchOrganization.mockRejectedValue(Object.assign(new Error('the server is down'), { status: 500 }));
    render(<MemoryRouter><OrganizationPage addToast={vi.fn()} currentUser={{ id: 'user-x' }} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('the server is down')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});
