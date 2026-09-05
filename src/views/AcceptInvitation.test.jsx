import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AcceptInvitation from './AcceptInvitation';
import { api } from '../utils/api';

/**
 * Redeeming an administrator invitation.
 *
 * ── What this has to get right ──
 *
 * 1. **Nothing is accepted without a press.** The token is single-use and it
 *    promotes an account to a role that can read safety reports about children.
 *    A POST on mount would let a mail prefetcher, a corporate URL scanner or a
 *    back button burn it with nobody deciding anything — and the email promises
 *    "nothing happens unless you accept".
 * 2. **A signed-out reader is told what to do**, rather than getting the
 *    signed-out 404 that this whole page exists to replace.
 * 3. **Every failure looks the same.** The endpoint collapses "no such token",
 *    "expired", "already used", "revoked" and "belongs to somebody else" into
 *    one answer so it cannot be used to probe for a live invitation. The client
 *    must not reintroduce the distinction it removed.
 * 4. **Success signs the reader out.** Accepting bumps `token_version`, so the
 *    session the page just used is already dead; leaving them to discover that
 *    on their next click presents a deliberate re-authentication as the account
 *    breaking seconds after promotion.
 */

const TOKEN = 'b'.repeat(43);

vi.mock('../utils/api');

let session;
vi.mock('../session/SessionProvider', () => ({
  useSession: () => session,
}));

/* The page reads its token from the query string, because that is the URL the
   invitation email has always sent. */
const show = (search = `?token=${TOKEN}`) =>
  render(
    <MemoryRouter initialEntries={[`/accept-invitation${search}`]}>
      <AcceptInvitation />
    </MemoryRouter>
  );

const signedIn = () => {
  session = {
    currentUser: { id: 'user-1', email: 'newadmin@example.gov' },
    isCheckingSession: false,
    signOut: vi.fn(),
  };
  return session;
};

beforeEach(() => {
  vi.clearAllMocks();
  session = { currentUser: null, isCheckingSession: false, signOut: vi.fn() };
});

describe('AcceptInvitation', () => {
  it('waits for the session check rather than flashing the signed-out page', () => {
    session = { currentUser: null, isCheckingSession: true, signOut: vi.fn() };
    show();

    expect(screen.getByText('Checking your invitation…')).toBeInTheDocument();
    /* Acting on `currentUser === null` while it is still resolving would show a
       signed-in reader "Sign in to accept" for a frame and then replace it. */
    expect(screen.queryByRole('heading', { name: /Sign in to accept/i })).not.toBeInTheDocument();
  });

  it('asks a signed-out reader to sign in with the invited address', () => {
    show();

    expect(screen.getByRole('heading', { name: /Sign in to accept this invitation/i }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    /* The token stays in the mailbox rather than in a redirect parameter — see
       the header of the view, and utils/pendingInvite.js's argument against
       introducing a general `returnTo`. So the instruction has to say so. */
    expect(screen.getByText(/open the link from that email again/i)).toBeInTheDocument();
    expect(api.acceptAdminInvitation).not.toHaveBeenCalled();
  });

  it('never accepts on mount, however valid the token looks', () => {
    signedIn();
    show();

    /* The whole reason acceptance is a button. */
    expect(api.acceptAdminInvitation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Accept and become an administrator/i }))
      .toBeInTheDocument();
  });

  it('says what the role can do before asking for the decision', () => {
    signedIn();
    show();

    /* The email leads with this and may have been read days ago on another
       device; this is the screen where the decision is actually taken. */
    expect(screen.getByText(/reports about children/i)).toBeInTheDocument();
    expect(screen.getByText(/recorded\s+against your name in the audit trail/i)).toBeInTheDocument();
    /* Which account is being promoted — an invitation belongs to one address. */
    expect(screen.getByText(/newadmin@example\.gov/)).toBeInTheDocument();
  });

  it('sends the token in the request body when accepted', async () => {
    signedIn();
    api.acceptAdminInvitation.mockResolvedValue({ accepted: true, role: 'admin', message: 'Sign in again.' });
    show();

    fireEvent.click(screen.getByRole('button', { name: /Accept and become an administrator/i }));

    await waitFor(() => expect(api.acceptAdminInvitation).toHaveBeenCalledWith(TOKEN));
  });

  it('signs the reader out on success, because the session is already dead', async () => {
    const s = signedIn();
    api.acceptAdminInvitation.mockResolvedValue({
      accepted: true,
      role: 'admin',
      message: 'You are now a WeVolunteer administrator. Sign in again to pick up your new access.',
    });
    show();

    fireEvent.click(screen.getByRole('button', { name: /Accept and become an administrator/i }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /You are now a WeVolunteer administrator/i }))
        .toBeInTheDocument());
    /* The explanation matters as much as the action: a forced re-authentication
       with no reason given reads as a fault. */
    expect(screen.getByText(/Why you have to sign in again/i)).toBeInTheDocument();
    /* And the outcome is stated ONCE. The endpoint's `message` opens with the
       heading's own sentence, so rendering it verbatim beneath the heading
       printed "You are now a WeVolunteer administrator" twice — measured in the
       browser before this was changed. */
    expect(screen.getAllByText(/You are now a WeVolunteer administrator/i)).toHaveLength(1);
    expect(screen.getByText('Sign in again to pick up your new access.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(s.signOut).toHaveBeenCalled();
  });

  it('shows the server\'s single message for every rejection', async () => {
    signedIn();
    const refusal = 'That invitation link is not valid. It may have expired, been used already, '
      + 'or been sent to a different address.';

    for (const status of [400, 401, 403, 404]) {
      vi.clearAllMocks();
      const err = new Error(refusal);
      err.status = status;
      api.acceptAdminInvitation.mockRejectedValue(err);

      const { unmount } = show();
      fireEvent.click(screen.getByRole('button', { name: /Accept and become an administrator/i }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      /* One sentence, whatever the cause. Distinguishing them here would
         rebuild the probe the endpoint deliberately refuses to be. */
      expect(screen.getByRole('alert')).toHaveTextContent(refusal);
      /* And the reader is still not an administrator, so the offer stays. */
      expect(screen.getByRole('button', { name: /Accept and become an administrator/i }))
        .toBeInTheDocument();
      unmount();
    }
  });

  it('separates our fault from a verdict on the invitation', async () => {
    signedIn();
    const err = new Error('Could not accept that invitation.');
    err.status = 500;
    api.acceptAdminInvitation.mockRejectedValue(err);
    show();

    fireEvent.click(screen.getByRole('button', { name: /Accept and become an administrator/i }));

    /* A 500 is the one case worth distinguishing: it says nothing about whether
       the invitation is good, so telling somebody it is invalid would be wrong
       and would send them to ask for a new one they do not need. */
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/wrong on our end/i));
  });

  it('answers a link with no token the same way it answers a bad one', () => {
    signedIn();
    const { container } = show('');

    expect(screen.getByRole('heading', { name: /This invitation link is incomplete/i }))
      .toBeInTheDocument();
    expect(api.acceptAdminInvitation).not.toHaveBeenCalled();

    /**
     * And it tells the accessibility sweep it is not the real page.
     *
     * `a11y/harness/routes.mjs` derives routes from the route table but
     * `concreteFor` fills only `:param` segments, not query strings — so the
     * sweep visits this path bare and would report THIS panel as coverage of
     * the acceptance screen. `walk.mjs` reads `data-error-kind="404"` as
     * "unmeasured", which is the honest answer. Same marker `CertificateView`
     * uses, and the same failure `/verify/:code` was fixed for.
     */
    expect(container.querySelector('[data-error-kind="404"]')).toBeTruthy();
  });

  it('moves focus to the heading whenever the page changes what it says', async () => {
    signedIn();
    api.acceptAdminInvitation.mockResolvedValue({ accepted: true, role: 'admin', message: 'ok' });
    show();

    /* Accepting replaces the panel without a navigation, so a screen reader
       would otherwise be left on a button that no longer exists. */
    fireEvent.click(screen.getByRole('button', { name: /Accept and become an administrator/i }));

    await waitFor(() => {
      const heading = screen.getByRole('heading', { name: /You are now a WeVolunteer administrator/i });
      expect(heading).toHaveFocus();
    });
  });
});
