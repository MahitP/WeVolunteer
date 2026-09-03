import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizationInvite from './OrganizationInvite';
import { api } from '../utils/api';
import { peekPendingInvite } from '../utils/pendingInvite';

/**
 * What an invitation link opens.
 *
 * ── The three things this has to get right ──
 *
 * 1. **A stranger can read the club and cannot join it silently.** The primary
 *    action explains that joining needs an account, and nothing about the page
 *    makes anybody a member.
 * 2. **A signed-in reader is sent to the real page**, with the token stashed so
 *    their Join press carries it. That hand-off is the part a redirect gets
 *    wrong, so it is asserted on the stored value rather than on the navigation
 *    alone.
 * 3. **Every failure looks the same.** The server answers one 404 for a token
 *    that never existed, one that was replaced, one that was switched off and
 *    one whose club was archived. Four messages here would invent information
 *    the endpoint deliberately does not give.
 */

const TOKEN = 'a'.repeat(64);

vi.mock('../utils/api');
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ token: 'a'.repeat(64) }),
  useNavigate: () => mockNavigate,
}));

const mockNavigate = vi.fn();

/**
 * The session, mocked rather than provided.
 *
 * `OrganizationInvite` is rendered by `PUBLIC_ROUTES`, which App.jsx serves
 * BEFORE the session branches and without props — so the view reads the session
 * itself. Mocking the hook is what lets one file drive both readers.
 */
let session = { currentUser: null, isCheckingSession: false };
vi.mock('../session/SessionProvider', () => ({
  useSession: () => session,
}));

const ORG = {
  kind: 'organization',
  slug: 'chess-club',
  name: 'Chess Club',
  description: 'We play chess and we teach it.',
  tags: ['Tutoring'],
  avatar: '♟️',
  imageUrl: null,
  avatarColor: 'sage',
  memberCount: 42,
  eventCount: 11,
  joinPolicy: 'open',
  upcoming: [
    { title: 'Beach cleanup', startsAt: '2026-10-04T09:00:00.000Z', category: 'Environment' },
  ],
};

const show = async (organization = ORG) => {
  api.fetchOrganizationInvite.mockResolvedValue({ organization });
  const utils = render(<MemoryRouter><OrganizationInvite /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Chess Club' })).toBeInTheDocument());
  return utils;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  session = { currentUser: null, isCheckingSession: false };
});

describe('a visitor with no account', () => {
  it('sees the club, its counts and what is coming up', async () => {
    await show();
    expect(screen.getByText('42 members')).toBeInTheDocument();
    expect(screen.getByText('11 opportunities')).toBeInTheDocument();
    expect(screen.getByText('We play chess and we teach it.')).toBeInTheDocument();
    expect(screen.getByText('Beach cleanup')).toBeInTheDocument();
  });

  it('owns the page heading, because it renders outside the shell', async () => {
    await show();
    expect(screen.getByRole('heading', { level: 1, name: 'Chess Club' })).toBeInTheDocument();
  });

  it('is told what joining will do before being asked to sign in', async () => {
    await show();
    expect(screen.getByRole('button', { name: /^Join Chess Club$/ })).toBeInTheDocument();
    expect(screen.getByText('Anyone can join Chess Club.')).toBeInTheDocument();
  });

  it('says a club that approves members will approve them', async () => {
    await show({ ...ORG, joinPolicy: 'request' });
    expect(screen.getByRole('button', { name: /Request to join/ })).toBeInTheDocument();
    expect(screen.getByText('A manager of Chess Club will see your request and decide.'))
      .toBeInTheDocument();
  });

  it('explains that joining needs an account, rather than failing', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    const dialog = await screen.findByRole('dialog', { name: /Sign in to join Chess Club/ });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/needs a WeVolunteer account/)).toBeInTheDocument();
  });

  /**
   * The hand-off. Storing the SLUG and the token before leaving is what makes
   * signing up land on the club rather than on the dashboard — and it is a slug
   * and a token, never a URL, which is why there is nothing to validate on the
   * way back.
   */
  it('remembers the club before sending somebody to sign up', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Create an account/ }));

    expect(peekPendingInvite()).toMatchObject({ slug: 'chess-club', token: TOKEN });
    expect(mockNavigate).toHaveBeenCalledWith('/signup');
  });

  it('remembers it before sending somebody to log in, too', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /^Log in$/ }));

    expect(peekPendingInvite()).toMatchObject({ slug: 'chess-club', token: TOKEN });
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('renders a club with nothing scheduled without looking broken', async () => {
    await show({ ...ORG, upcoming: [], eventCount: 0 });
    expect(screen.getByText('Nothing scheduled yet')).toBeInTheDocument();
  });

  it('renders a club with no logo, no description and no tags', async () => {
    await show({
      ...ORG, description: '', tags: [], avatar: null, imageUrl: null, avatarColor: null,
      memberCount: 0, eventCount: 0, upcoming: [],
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Chess Club' })).toBeInTheDocument();
    expect(screen.getByText('0 members')).toBeInTheDocument();
  });
});

describe('a reader who is already signed in', () => {
  it('is sent to the real organization page, replacing this one in history', async () => {
    session = { currentUser: { id: 'user-1' }, isCheckingSession: false };
    api.fetchOrganizationInvite.mockResolvedValue({ organization: ORG });
    render(<MemoryRouter><OrganizationInvite /></MemoryRouter>);

    /* The CANONICAL address. A member arriving through an invitation link
       lands on `/organizations/@chess-club`, which is the address they would
       copy out of the location bar and send to somebody else. */
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(
      '/organizations/@chess-club', { replace: true },
    ));
  });

  it('takes the token with them, so their Join press can use it', async () => {
    session = { currentUser: { id: 'user-1' }, isCheckingSession: false };
    api.fetchOrganizationInvite.mockResolvedValue({ organization: ORG });
    render(<MemoryRouter><OrganizationInvite /></MemoryRouter>);

    await waitFor(() => expect(peekPendingInvite()).toMatchObject({ slug: 'chess-club', token: TOKEN }));
  });

  /**
   * Nothing happens until the session check settles.
   *
   * Acting on `currentUser === null` while it is still resolving would render
   * the public page for a frame and then move a signed-in reader, which reads as
   * a flicker and loses their place.
   */
  it('waits for the session check rather than flashing the public page', async () => {
    session = { currentUser: null, isCheckingSession: true };
    api.fetchOrganizationInvite.mockResolvedValue({ organization: ORG });
    render(<MemoryRouter><OrganizationInvite /></MemoryRouter>);

    await waitFor(() => expect(api.fetchOrganizationInvite).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Chess Club' })).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('a link that does not work', () => {
  /**
   * One message for every reason.
   *
   * The endpoint answers an identical 404 for a token that never existed, one
   * replaced, one switched off and one whose organization was archived —
   * distinguishing them would turn it into a probe for live links. This page
   * must not invent the distinction back.
   */
  it('says so once, without guessing why', async () => {
    api.fetchOrganizationInvite.mockRejectedValue(
      Object.assign(new Error('gone'), { status: 404 }),
    );
    render(<MemoryRouter><OrganizationInvite /></MemoryRouter>);

    await waitFor(() => expect(
      screen.getByText('This invitation link does not work'),
    ).toBeInTheDocument());
    expect(screen.getByText(/replaced or switched off/)).toBeInTheDocument();
    /* And a way onward, rather than a dead end for somebody with no account. */
    expect(screen.getByRole('link', { name: /Go to WeVolunteer/ })).toBeInTheDocument();
    /**
     * As the page's `h1`.
     *
     * This page renders outside the shell, so there is no heading above it, and
     * the failure branch is the state a stale link lands on — which makes it the
     * most likely thing a screen-reader user meets here. It had no level-one
     * heading at all until `a11y/sweep.aria.spec.js` measured this exact route:
     * the demo seed has no invitation link, so the fixture token always resolves
     * to this branch.
     */
    expect(screen.getByRole('heading', { level: 1, name: 'This invitation link does not work' }))
      .toBeInTheDocument();
  });

  it('reports a genuine outage as an outage', async () => {
    api.fetchOrganizationInvite.mockRejectedValue(
      Object.assign(new Error('Could not reach the server. Check your connection and try again.'), {
        status: 0, isNetworkError: true,
      }),
    );
    render(<MemoryRouter><OrganizationInvite /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Could not reach the server/)).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1, name: 'Could not open this invitation' }))
      .toBeInTheDocument();
  });

  it('never joins anybody to anything', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    await screen.findByRole('dialog');
    expect(api.joinOrganizationWithInvite).not.toHaveBeenCalled();
    expect(api.requestToJoinOrganization).not.toHaveBeenCalled();
  });
});
