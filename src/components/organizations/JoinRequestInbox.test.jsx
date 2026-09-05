import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import JoinRequestInbox from './JoinRequestInbox';
import { api } from '../../utils/api';

/**
 * The queue a manager answers.
 *
 * ── What is worth testing here, and what is not ──
 *
 * Not who may read it: that is `canManage` on the server, proved in
 * `server/routes.organizationJoinRequests.test.js`. What this covers is the two
 * things the manager experiences.
 *
 * **Both verbs are visible and both name the person.** A screen-reader user
 * tabbing through eight rows of "Accept / Decline" cannot tell which row they
 * are on, so the accessible name carries the name.
 *
 * **A refusal reaches them.** The likeliest one is that a co-manager answered it
 * first, and a manager who is not told will press the button again and conclude
 * the product is broken.
 */

vi.mock('../../utils/api');

const REQUESTS = [
  {
    requestId: 'orq-1', id: 'user-1', name: 'Leo Chen', username: 'leochen',
    avatar: '🧑‍💻', profilePictureUrl: null, role: 'student', location: null,
    submittedAt: '2026-09-01T09:00:00.000Z', kind: 'user', distinction: null, avatarColor: null,
  },
  {
    requestId: 'orq-2', id: 'user-2', name: 'Priya Patel', username: 'priyapatel',
    avatar: '👩‍⚕️', profilePictureUrl: null, role: 'student', location: null,
    submittedAt: '2026-09-02T09:00:00.000Z', kind: 'user', distinction: null, avatarColor: null,
  },
];

const show = async ({ requests = REQUESTS, policy = 'request', addToast = vi.fn() } = {}) => {
  api.fetchOrganizationJoinRequests.mockResolvedValue({ requests, pendingRequests: requests.length });
  const utils = render(
    <MemoryRouter>
      <JoinRequestInbox
        orgKey="chess-club"
        organizationName="Chess Club"
        policy={policy}
        addToast={addToast}
        onDecided={vi.fn()}
      />
    </MemoryRouter>,
  );
  await waitFor(() => expect(api.fetchOrganizationJoinRequests).toHaveBeenCalledWith('chess-club'));
  return utils;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.decideOrganizationJoinRequest.mockResolvedValue({ decision: 'accept', pendingRequests: 0 });
});

describe('the queue', () => {
  it('lists who is waiting, and when they asked', async () => {
    await show();
    expect(await screen.findByText('Leo Chen')).toBeInTheDocument();
    expect(screen.getByText('Priya Patel')).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
  });

  it('links each row to that person’s profile', async () => {
    await show();
    expect(await screen.findByRole('link', { name: /Leo Chen/ }))
      .toHaveAttribute('href', '/users/@leochen');
  });

  it('names the person on both decisions, so the rows are distinguishable', async () => {
    await show();
    expect(await screen.findByRole('button', { name: /Accept Leo Chen into Chess Club/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decline Leo Chen's request to join/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accept Priya Patel into Chess Club/ })).toBeInTheDocument();
  });
});

describe('deciding', () => {
  it('accepts in one press, with no confirmation', async () => {
    const addToast = vi.fn();
    await show({ addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Accept Leo Chen/ }));

    await waitFor(() => expect(api.decideOrganizationJoinRequest)
      .toHaveBeenCalledWith('chess-club', 'orq-1', 'accept'));
    expect(addToast).toHaveBeenCalledWith('Leo Chen is now a member of Chess Club.', 'success');
  });

  it('declines in one press', async () => {
    const addToast = vi.fn();
    await show({ addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Decline Priya Patel/ }));

    await waitFor(() => expect(api.decideOrganizationJoinRequest)
      .toHaveBeenCalledWith('chess-club', 'orq-2', 'reject'));
    /* `info`, not `success`: declining somebody is not a happy outcome to
       celebrate at them. */
    expect(addToast).toHaveBeenCalledWith("Priya Patel's request was declined.", 'info');
  });

  /**
   * The race a shared queue actually produces.
   *
   * Two managers open the list and both press Accept. The server answers the
   * loser 409, and this has to say so AND reload — a message alone would leave
   * the stale row on screen for them to press again.
   */
  it('reports a request somebody else already answered, and reloads', async () => {
    const addToast = vi.fn();
    await show({ addToast });
    api.decideOrganizationJoinRequest.mockRejectedValue(
      new Error('Somebody has already answered that request.'),
    );

    fireEvent.click(await screen.findByRole('button', { name: /Accept Leo Chen/ }));

    await waitFor(() => expect(addToast)
      .toHaveBeenCalledWith('Somebody has already answered that request.', 'error'));
    await waitFor(() => expect(api.fetchOrganizationJoinRequests).toHaveBeenCalledTimes(2));
  });

  it('disables that row while it is in flight', async () => {
    let settle;
    api.decideOrganizationJoinRequest.mockReturnValue(new Promise(r => { settle = r; }));
    await show();

    fireEvent.click(await screen.findByRole('button', { name: /Accept Leo Chen/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Accept Leo Chen/ })).toBeDisabled());
    /* The other row stays usable: one press must not freeze the whole queue. */
    expect(screen.getByRole('button', { name: /Accept Priya Patel/ })).not.toBeDisabled();
    settle({});
  });
});

describe('when there is nothing to answer', () => {
  /**
   * Emptiness is a real answer for a club that approves members — "nobody is
   * waiting" is what a manager came to find out.
   */
  it('says so for a club that approves members', async () => {
    await show({ requests: [], policy: 'request' });
    expect(await screen.findByText('Nobody is waiting')).toBeInTheDocument();
  });

  /**
   * And it is not an answer for a club that does not: an `open` club has no
   * queue and never will, so a permanently empty inbox on every visit is
   * furniture.
   */
  it.each(['open', 'invite'])('renders nothing at all for an %s club', async (policy) => {
    const { container } = await show({ requests: [], policy });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('still shows the queue for an open club that has one from before the switch', async () => {
    /* A club moved from `request` to `open` can have requests already waiting.
       Hiding them would leave students pending for ever with nobody able to
       answer. */
    await show({ requests: REQUESTS, policy: 'open' });
    expect(await screen.findByText('Leo Chen')).toBeInTheDocument();
  });
});

describe('when the queue cannot be loaded', () => {
  it('says why, rather than looking empty', async () => {
    api.fetchOrganizationJoinRequests.mockRejectedValue(new Error('the server is down'));
    render(
      <MemoryRouter>
        <JoinRequestInbox
          orgKey="chess-club" organizationName="Chess Club" policy="request"
          addToast={vi.fn()} onDecided={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('the server is down');
  });
});
