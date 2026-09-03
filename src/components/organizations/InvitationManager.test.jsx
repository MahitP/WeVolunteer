import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InvitationManager from './InvitationManager';
import { api } from '../../utils/api';

/**
 * Inviting named people, from a manager's side of the club.
 *
 * ── What this file is really asserting ──
 *
 * Not the authorization — who may invite is decided by `canManage` on the server
 * and proved in `server/routes.organizationInvitations.test.js`. This covers the
 * part no server test can: that the only way to name somebody is to SEARCH for
 * them, that there is no email field anywhere, and that the search does not
 * leave four requests racing on a manager typing "alex".
 */

vi.mock('../../utils/api');

const PERSON = {
  id: 'user-1', name: 'Alex Rivera', username: 'alexr',
  avatar: null, profilePictureUrl: null,
};
const OTHER = {
  id: 'user-2', name: 'Alex Chen', username: 'alexc',
  avatar: null, profilePictureUrl: null,
};

const INVITATION = {
  invitationId: 'oinv-1',
  id: 'user-9', name: 'Sam Patel', username: 'samp',
  avatar: null, profilePictureUrl: null,
  message: null,
  createdAt: '2026-09-01T09:00:00.000Z',
  expiresAt: '2026-09-15T09:00:00.000Z',
};

const show = async (invitations = [], props = {}) => {
  api.fetchOrganizationInvitations.mockResolvedValue({ invitations });
  const utils = render(
    <MemoryRouter>
      <InvitationManager
        orgKey="chess-club"
        organizationName="Chess Club"
        addToast={props.addToast ?? vi.fn()}
        onChanged={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
  await waitFor(() => expect(api.fetchOrganizationInvitations).toHaveBeenCalledWith('chess-club'));
  return utils;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  api.searchDirectory.mockResolvedValue({ users: [], organizations: [] });
  api.inviteToOrganization.mockResolvedValue({ invitation: INVITATION });
  api.revokeOrganizationInvitation.mockResolvedValue({ revoked: true });
});

describe('the outstanding list', () => {
  it('says plainly when nobody is waiting', async () => {
    await show([]);
    expect(await screen.findByText('Nobody is waiting on an invitation')).toBeInTheDocument();
  });

  it('names each person, when they were invited and when it lapses', async () => {
    await show([INVITATION]);
    expect(await screen.findByText('Sam Patel')).toBeInTheDocument();
    expect(screen.getByText(/@samp/)).toBeInTheDocument();
    expect(screen.getByText(/open until/)).toBeInTheDocument();
  });

  it('shows the note where one was written, as text', async () => {
    await show([{ ...INVITATION, message: 'We could use your help on Thursdays.' }]);
    expect(await screen.findByText('We could use your help on Thursdays.')).toBeInTheDocument();
  });

  it('counts them, so the card agrees with itself', async () => {
    await show([INVITATION, { ...INVITATION, invitationId: 'oinv-2', id: 'user-8', name: 'Jo Kim' }]);
    expect(await screen.findByText('2 waiting')).toBeInTheDocument();
  });

  it('reports a failed load rather than an empty card', async () => {
    api.fetchOrganizationInvitations.mockRejectedValue(new Error('the server is down'));
    render(
      <MemoryRouter>
        <InvitationManager orgKey="chess-club" organizationName="Chess Club" addToast={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('the server is down');
  });
});

describe('sending one', () => {
  /**
   * The whole reason there is a search box and not a text field.
   *
   * `email` is a privileged field that directory search cannot even match on.
   * A form that took an address and answered anything at all would be the first
   * place on this platform where a club manager could act on an address they
   * were never shown — and the users are minors.
   */
  it('has no email field, and says the omission is deliberate', async () => {
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));

    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no way to invite an email address, on purpose/)).toBeInTheDocument();
  });

  it('does not search on one character', async () => {
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    fireEvent.change(screen.getByLabelText(/Who would you like to invite/), { target: { value: 'a' } });

    await new Promise(resolve => setTimeout(resolve, 350));
    expect(api.searchDirectory).not.toHaveBeenCalled();
  });

  it('searches people only, so a club matching the name is not offered', async () => {
    api.searchDirectory.mockResolvedValue({ users: [PERSON], organizations: [] });
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    fireEvent.change(screen.getByLabelText(/Who would you like to invite/), { target: { value: 'alex' } });

    await waitFor(() => expect(api.searchDirectory).toHaveBeenCalledWith(
      'alex', expect.objectContaining({ type: 'users' }),
    ));
    expect(await screen.findByText('Alex Rivera')).toBeInTheDocument();
  });

  /**
   * Debounced and abortable.
   *
   * Typing "alex" would otherwise leave four requests racing, and the one that
   * answers last wins regardless of which query it belonged to — a manager
   * would see results for "al" under a box reading "alex".
   */
  it('sends one request for a burst of typing', async () => {
    api.searchDirectory.mockResolvedValue({ users: [PERSON], organizations: [] });
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    const field = screen.getByLabelText(/Who would you like to invite/);

    for (const value of ['al', 'ale', 'alex']) {
      fireEvent.change(field, { target: { value } });
    }

    await waitFor(() => expect(api.searchDirectory).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(api.searchDirectory).toHaveBeenCalledTimes(1);
    expect(api.searchDirectory).toHaveBeenCalledWith('alex', expect.anything());
  });

  it('passes an abort signal, so a stale answer cannot win', async () => {
    api.searchDirectory.mockResolvedValue({ users: [PERSON], organizations: [] });
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    fireEvent.change(screen.getByLabelText(/Who would you like to invite/), { target: { value: 'alex' } });

    await waitFor(() => expect(api.searchDirectory).toHaveBeenCalled());
    const [, options] = api.searchDirectory.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('says so when nobody matched', async () => {
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    fireEvent.change(screen.getByLabelText(/Who would you like to invite/), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nobody matched that.')).toBeInTheDocument();
  });

  /**
   * Choosing, then sending — two deliberate steps.
   *
   * A list of buttons that each invite immediately makes a mis-click an
   * invitation into somebody else's notifications.
   */
  it('requires a person to be chosen before Invite does anything', async () => {
    api.searchDirectory.mockResolvedValue({ users: [PERSON, OTHER], organizations: [] });
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    fireEvent.change(screen.getByLabelText(/Who would you like to invite/), { target: { value: 'alex' } });
    await screen.findByText('Alex Rivera');

    expect(screen.getByRole('button', { name: /^Invite$/ })).toBeDisabled();
    expect(api.inviteToOrganization).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: /Alex Rivera/ }));
    fireEvent.click(screen.getByRole('button', { name: /Invite Alex Rivera/ }));
    await waitFor(() => expect(api.inviteToOrganization)
      .toHaveBeenCalledWith('chess-club', 'user-1', undefined));
  });

  it('sends the note the manager wrote, trimmed', async () => {
    api.searchDirectory.mockResolvedValue({ users: [PERSON], organizations: [] });
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    fireEvent.change(screen.getByLabelText(/Who would you like to invite/), { target: { value: 'alex' } });
    await screen.findByText('Alex Rivera');
    fireEvent.click(screen.getByRole('radio', { name: /Alex Rivera/ }));

    fireEvent.change(screen.getByLabelText(/A note for Alex Rivera/), {
      target: { value: '  We meet on Thursdays.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Invite Alex Rivera/ }));

    await waitFor(() => expect(api.inviteToOrganization)
      .toHaveBeenCalledWith('chess-club', 'user-1', 'We meet on Thursdays.'));
  });

  it('refuses a note past the limit, and says how far past', async () => {
    api.searchDirectory.mockResolvedValue({ users: [PERSON], organizations: [] });
    await show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    fireEvent.change(screen.getByLabelText(/Who would you like to invite/), { target: { value: 'alex' } });
    await screen.findByText('Alex Rivera');
    fireEvent.click(screen.getByRole('radio', { name: /Alex Rivera/ }));

    fireEvent.change(screen.getByLabelText(/A note for Alex Rivera/), {
      target: { value: 'x'.repeat(311) },
    });
    expect(screen.getByText('11 characters too many.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invite Alex Rivera/ })).toBeDisabled();
  });

  it('surfaces a refusal rather than pretending it worked', async () => {
    api.searchDirectory.mockResolvedValue({ users: [PERSON], organizations: [] });
    api.inviteToOrganization.mockRejectedValue(new Error('Alex Rivera declined an invitation.'));
    const addToast = vi.fn();
    await show([], { addToast });

    fireEvent.click(await screen.findByRole('button', { name: /Invite somebody/ }));
    fireEvent.change(screen.getByLabelText(/Who would you like to invite/), { target: { value: 'alex' } });
    await screen.findByText('Alex Rivera');
    fireEvent.click(screen.getByRole('radio', { name: /Alex Rivera/ }));
    fireEvent.click(screen.getByRole('button', { name: /Invite Alex Rivera/ }));

    await waitFor(() => expect(addToast)
      .toHaveBeenCalledWith('Alex Rivera declined an invitation.', 'error'));
  });
});

describe('withdrawing one', () => {
  it('names the person on the control, so eight rows are distinguishable', async () => {
    await show([INVITATION]);
    expect(await screen.findByRole('button', { name: /Withdraw the invitation to Sam Patel/ }))
      .toBeInTheDocument();
  });

  it('withdraws it and reloads, so the row goes away', async () => {
    const addToast = vi.fn();
    await show([INVITATION], { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Withdraw the invitation to Sam Patel/ }));

    await waitFor(() => expect(api.revokeOrganizationInvitation)
      .toHaveBeenCalledWith('chess-club', 'oinv-1'));
    expect(addToast).toHaveBeenCalledWith('The invitation to Sam Patel was withdrawn.', 'info');
    /* Reloaded, which is what makes a message about a race actionable. */
    expect(api.fetchOrganizationInvitations).toHaveBeenCalledTimes(2);
  });

  /**
   * The likeliest refusal is that the person answered a moment ago.
   *
   * A manager who is not told will press again and conclude the product is
   * broken; reloading afterwards is what makes the message actionable.
   */
  it('surfaces a race and reloads', async () => {
    api.revokeOrganizationInvitation.mockRejectedValue(
      new Error('That invitation has already been answered.'),
    );
    const addToast = vi.fn();
    await show([INVITATION], { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Withdraw the invitation to Sam Patel/ }));

    await waitFor(() => expect(addToast)
      .toHaveBeenCalledWith('That invitation has already been answered.', 'error'));
    expect(api.fetchOrganizationInvitations).toHaveBeenCalledTimes(2);
  });

  it('links each person to their profile', async () => {
    await show([INVITATION]);
    const row = (await screen.findByText('Sam Patel')).closest('li');
    expect(within(row).getByRole('link')).toHaveAttribute('href', '/users/@samp');
  });
});
