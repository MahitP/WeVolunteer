import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizationPublic from './OrganizationPublic';
import { api } from '../utils/api';
import { peekPendingInvite } from '../utils/pendingInvite';

/**
 * A club at its canonical public address, seen by somebody with no account.
 *
 * ── The three things this page has to get right ──
 *
 * 1. **Only the `@` form is a public address.** The bare legacy path reaches
 *    this view too — the route pattern is the same one the shell uses,
 *    separated by session rather than by path — and it must NOT be looked up.
 *    Looking it up would quietly make every club's page public, including the
 *    ones that never chose to be, and it would make the page an oracle for
 *    which clubs exist.
 * 2. **A handle confers nothing.** An invitation-only club shows no Join at
 *    all, because a handle is derived from a club's name and printed on
 *    posters. Offering a Join the server would refuse is worse here than
 *    anywhere else: the reader has no account yet, so the refusal would arrive
 *    after they made one.
 * 3. **One answer for every reason it is not there.** Unlisted, archived and
 *    absent are the same 404 on the server, and this page must not invent the
 *    distinction back.
 */

vi.mock('../utils/api');

let params = { key: '@chess-club' };
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => params,
}));

const ORG = {
  kind: 'organization',
  slug: 'chess-club',
  handle: '@chess-club',
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
  api.fetchPublicOrganization.mockResolvedValue({ organization });
  const utils = render(<MemoryRouter><OrganizationPublic /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Chess Club' })).toBeInTheDocument());
  return utils;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  params = { key: '@chess-club' };
});

describe('the club at its public address', () => {
  it('asks for the bare handle, because the @ is punctuation', async () => {
    await show();
    expect(api.fetchPublicOrganization).toHaveBeenCalledWith('chess-club');
  });

  it('owns the page heading, because it renders outside the shell', async () => {
    await show();
    expect(screen.getByRole('heading', { level: 1, name: 'Chess Club' })).toBeInTheDocument();
  });

  it('shows the counts and what is coming up', async () => {
    await show();
    expect(screen.getByText('42 members')).toBeInTheDocument();
    expect(screen.getByText('11 opportunities')).toBeInTheDocument();
    expect(screen.getByText('Beach cleanup')).toBeInTheDocument();
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
  });
});

describe('what pressing the button will do', () => {
  it('offers Join on a club anyone can join, and says so', async () => {
    await show();
    expect(screen.getByRole('button', { name: /^Join Chess Club$/ })).toBeInTheDocument();
    expect(screen.getByText('Anyone can join Chess Club.')).toBeInTheDocument();
  });

  it('offers a request on a club that approves members', async () => {
    await show({ ...ORG, joinPolicy: 'request' });
    expect(screen.getByRole('button', { name: /Request to join/ })).toBeInTheDocument();
    expect(screen.getByText('A manager reads every request and decides.')).toBeInTheDocument();
  });

  /**
   * The security assertion.
   *
   * A handle grants nothing, so an invitation-only club offers neither Join nor
   * Request — it says what is true, which is that the way in is a link somebody
   * has to give you.
   */
  it('offers nothing at all on an invitation-only club, and explains why', async () => {
    await show({ ...ORG, joinPolicy: 'invite' });
    expect(screen.queryByRole('button', { name: /Join/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Request/ })).not.toBeInTheDocument();
    expect(screen.getByText(/admits members by invitation/)).toBeInTheDocument();
  });

  it('explains that joining needs an account, rather than failing', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    expect(await screen.findByRole('dialog', { name: /Sign in to join Chess Club/ })).toBeInTheDocument();
  });

  /**
   * The hand-off, with no token.
   *
   * Somebody who arrived at the public address holds no invitation, so the
   * remembered record is the slug alone — which is what brings them back to the
   * right club after signing up, while the Join that follows is judged by
   * `join_policy` with nothing in hand.
   */
  it('remembers the club, and no token, before sending somebody to sign up', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Create an account/ }));

    const remembered = peekPendingInvite();
    expect(remembered).toMatchObject({ slug: 'chess-club' });
    expect(remembered.token ?? null).toBeNull();
  });

  it('never joins anybody to anything', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Join Chess Club$/ }));
    await screen.findByRole('dialog');
    expect(api.joinOrganizationWithInvite).not.toHaveBeenCalled();
    expect(api.requestToJoinOrganization).not.toHaveBeenCalled();
  });
});

describe('the bare legacy path, signed out', () => {
  /**
   * No lookup at all, which is the point.
   *
   * The asymmetry with the `@` form is the design: the handle is an address a
   * club chose to publish, the bare path is the authenticated page it has
   * always been. Not looking it up also means this is not an oracle — a real
   * club and a made-up one get the identical answer, with no request sent.
   */
  it('says the page needs an account without asking the server anything', async () => {
    params = { key: 'chess-club' };
    render(<MemoryRouter><OrganizationPublic /></MemoryRouter>);

    expect(await screen.findByRole('heading', { level: 1, name: 'This page needs an account' }))
      .toBeInTheDocument();
    expect(api.fetchPublicOrganization).not.toHaveBeenCalled();
  });

  it('answers a club that does not exist identically', async () => {
    params = { key: 'no-such-club-at-all' };
    render(<MemoryRouter><OrganizationPublic /></MemoryRouter>);
    expect(await screen.findByRole('heading', { level: 1, name: 'This page needs an account' }))
      .toBeInTheDocument();
    expect(api.fetchPublicOrganization).not.toHaveBeenCalled();
  });

  it('offers a way in rather than being a dead end', async () => {
    params = { key: 'chess-club' };
    render(<MemoryRouter><OrganizationPublic /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: /Log in/ })).toBeInTheDocument();
  });
});

describe('an address that does not open', () => {
  /**
   * One message for every reason.
   *
   * The server answers an identical 404 for a club that does not exist, one
   * that is archived, and one that chose not to be public — because handles are
   * guessable, so distinguishing them would make the endpoint a directory of
   * the clubs that opted out.
   */
  it('says so once, without guessing why', async () => {
    api.fetchPublicOrganization.mockRejectedValue(
      Object.assign(new Error('gone'), { status: 404 }),
    );
    render(<MemoryRouter><OrganizationPublic /></MemoryRouter>);

    expect(await screen.findByRole('heading', { level: 1, name: 'We could not find that organization' }))
      .toBeInTheDocument();
    /* Both possibilities named, neither asserted. */
    expect(screen.getByText(/may not have a public page/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to WeVolunteer/ })).toBeInTheDocument();
  });

  /**
   * An outage is not a verdict.
   *
   * Telling somebody a club does not exist when the wifi dropped sends them
   * back to whoever shared the address for a link that was fine — and on this
   * page that person has no account and no other way in.
   */
  it('reports a genuine outage as an outage, with a retry', async () => {
    api.fetchPublicOrganization.mockRejectedValue(
      Object.assign(new Error('Could not reach the server. Check your connection and try again.'), {
        status: 0, isNetworkError: true,
      }),
    );
    render(<MemoryRouter><OrganizationPublic /></MemoryRouter>);

    expect(await screen.findByRole('heading', { level: 1, name: 'Could not open this page' }))
      .toBeInTheDocument();
    expect(screen.getByText(/Could not reach the server/)).toBeInTheDocument();

    api.fetchPublicOrganization.mockResolvedValue({ organization: ORG });
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Chess Club' })).toBeInTheDocument());
  });
});
