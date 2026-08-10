import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';
import { api } from '../utils/api';

/**
 * Leaving the second-factor screen forgets the person who started it.
 *
 * ── The device this is about ──
 *
 * A school laptop cart. Student A signs in with their password, reaches the
 * second-factor step, presses "Send code to email", then presses Back and walks
 * off. Student B sits down and signs in with their own password.
 *
 * "Back to sign in" used to reset `mode` and `internalMode` and nothing else, so
 * `maskedEmail`, `emailCodeSent`, `emailCooldown` and `availableMethods` all
 * survived into B's session. B landed on a screen reading
 * "6-digit code sent to jo***@sbschools.org" — A's address — with the Send
 * button hidden behind A's countdown.
 *
 * The masked form is not much, but it is A's address disclosed to B, on a
 * platform whose users are minors, through no action of A's beyond walking
 * away. And the stuck cooldown is a working denial of service on B's own
 * sign-in.
 *
 * The pre-auth grant itself is a cookie the server governs; this file is about
 * what the SCREEN remembers, which should be nothing.
 */

vi.mock('../utils/api');

/**
 * A generous wait budget, because this screen runs a REAL one-second interval
 * for the resend cooldown.
 *
 * Testing Library's default is 1000ms, which is the same order as that timer —
 * so under a loaded full-suite run these queries could expire before React had
 * flushed, and the file passed alone and failed in the suite. The assertions are
 * unchanged and still exact; only the patience is. CLAUDE.md is explicit that a
 * flaky test is a defect rather than a re-run.
 */
const WAIT = { timeout: 5000 };

/**
 * The sign-in form renders the OAuth provider row, which fetches on mount. Under
 * the automock that returns undefined and the component throws on `.then`, so
 * this is stubbed for every test rather than in each one.
 */
function stubShell() {
  api.fetchOAuthProviders.mockResolvedValue([]);
  api.demoAccounts.mockResolvedValue([]);
}

const A = {
  email: 'ana@sbschools.org',
  masked: 'an***@sbschools.org',
};

/**
 * Signs in with a password and lands on the second-factor step.
 *
 * The first screen is a chooser (providers, then "Sign in with email"), so the
 * email form has to be opened before there is an identifier field. Reused for
 * the SECOND person in each test, which is the whole point of the file.
 */
async function passwordSignIn(email, { availableMethods }) {
  api.login.mockResolvedValue({ require2FA: true, availableMethods });

  const emailButton = screen.queryByRole('button', { name: /sign in with email/i });
  if (emailButton) fireEvent.click(emailButton);

  fireEvent.change(await screen.findByLabelText(/email or username/i, {}, WAIT), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
  fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

  await screen.findByRole('heading', { name: /verify your identity/i }, WAIT);

  /* When more than one factor is offered the screen shows a picker; the email
     tests need email selected before the Send button exists. */
  if (availableMethods.length > 1 && availableMethods.includes('email')) {
    const emailRadio = await screen.findByRole('radio', { name: /email/i }, WAIT);
    fireEvent.click(emailRadio);
  }

  /* `selected2FAMethod` is chosen in an effect, so the method's own controls
     render a tick after the heading. Waiting for one of them here means every
     caller can then read synchronously. */
  await waitFor(() => {
    expect(
      screen.queryByLabelText(/6-digit code/i)
      || screen.queryByLabelText(/recovery code/i)
      || screen.queryByText(/send code to email/i)
    ).toBeTruthy();
  }, WAIT);
}

async function signInTo2FA({ availableMethods }) {
  render(
    <MemoryRouter>
      <Login onLoginSuccess={vi.fn()} addToast={vi.fn()} />
    </MemoryRouter>
  );
  await passwordSignIn(A.email, { availableMethods });
}

/** Back on the sign-in screen — either the chooser or the email form. */
const backOnSignIn = () => waitFor(() => {
  expect(
    screen.queryByRole('button', { name: /sign in with email/i })
    || screen.queryByLabelText(/email or username/i)
  ).toBeTruthy();
}, WAIT);

beforeEach(() => {
  vi.clearAllMocks();
  stubShell();
});

describe('leaving the second-factor step', () => {
  it('forgets the masked address the previous person had a code sent to', async () => {
    await signInTo2FA({ availableMethods: ['email', 'recovery'] });

    api.send2FAEmailCode.mockResolvedValue({ sent: true, maskedEmail: A.masked });
    fireEvent.click(screen.getByRole('button', { name: /send code to email/i }));
    await screen.findByText(new RegExp(A.masked.replace(/\*/g, '\\*')), {}, WAIT);

    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));

    /* Back on the sign-in screen, and nothing of A's is still rendered. */
    await backOnSignIn();
    expect(screen.queryByText(new RegExp(A.masked.replace(/\*/g, '\\*')))).toBeNull();
  });

  /**
   * The countdown is the second half. Even with the address gone, a live
   * cooldown left behind would refuse the NEXT person their own code.
   */
  it('does not leave the next person inside the previous cooldown', async () => {
    await signInTo2FA({ availableMethods: ['email'] });

    api.send2FAEmailCode.mockResolvedValue({ sent: true, maskedEmail: A.masked });
    fireEvent.click(screen.getByRole('button', { name: /send code to email/i }));
    await screen.findByText(new RegExp(A.masked.replace(/\*/g, '\\*')), {}, WAIT);

    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    await backOnSignIn();

    /* Somebody else signs in, and is offered a code rather than a countdown. */
    await passwordSignIn('ben@sbschools.org', { availableMethods: ['email'] });
    /* `waitFor` rather than a bare assertion: the previous cooldown ran on a real
       1s interval, so a bare read could observe the frame before React had
       flushed the reset. The property under test is the settled state. */
    /**
     * Asserted on the control's own state rather than through a role query.
     *
     * The point is that B is offered a fresh send — not a countdown inherited
     * from A — so what matters is that the Send control exists and is not
     * disabled, and that no "Resend in Ns" is on screen.
     */
    const send = await screen.findByText(/send code to email/i, {}, WAIT);
    expect(send.closest('button').disabled).toBe(false);
    expect(screen.queryByText(/resend in \d+s/i)).toBeNull();
  });

  it('forgets the previous account\'s method list', async () => {
    await signInTo2FA({ availableMethods: ['totp', 'email', 'recovery'] });
    expect(await screen.findByRole('radiogroup', { name: /verification method/i }, WAIT)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    await backOnSignIn();

    /* The next account holds one factor, so there is nothing to choose — the
       picker only renders above one method. A stale list would offer B the
       methods A had. */
    await passwordSignIn('ben@sbschools.org', { availableMethods: ['totp'] });
    expect(screen.queryByRole('radiogroup', { name: /verification method/i })).toBeNull();
  });

  it('clears a half-typed code', async () => {
    await signInTo2FA({ availableMethods: ['totp'] });

    const field = await screen.findByLabelText(/6-digit code/i, {}, WAIT);
    fireEvent.change(field, { target: { value: '123456' } });
    expect(field.value).toBe('123456');

    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    await backOnSignIn();

    await passwordSignIn('ben@sbschools.org', { availableMethods: ['totp'] });
    expect((await screen.findByLabelText(/6-digit code/i, {}, WAIT)).value).toBe('');
  });
});

/**
 * A refused SEND does not mean there is no code to type.
 *
 * The cooldown 429 fires precisely because a live code was just sent. Hiding
 * the input on that path left somebody holding a perfectly good code on a screen
 * that offered only the button which had refused them.
 */
describe('a refused send still lets you use the code you have', () => {
  it('reveals the code field on a cooldown refusal, and says why', async () => {
    await signInTo2FA({ availableMethods: ['email'] });

    const err = new Error('Please wait 43 seconds before requesting another code.');
    err.status = 429;
    err.data = { retryAfter: 43 };
    api.send2FAEmailCode.mockRejectedValue(err);

    fireEvent.click(screen.getByRole('button', { name: /send code to email/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
    }, WAIT);
    expect(screen.getByText(/if the earlier code has arrived/i)).toBeTruthy();
  });

  it('does the same when delivery failed after the code was stored', async () => {
    await signInTo2FA({ availableMethods: ['email'] });

    const err = new Error('We could not send your code right now.');
    err.status = 502;
    err.data = { code: 'delivery_failed' };
    api.send2FAEmailCode.mockRejectedValue(err);

    fireEvent.click(screen.getByRole('button', { name: /send code to email/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
    }, WAIT);
  });
});
