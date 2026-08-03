import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import VerifyIdentityModal from './VerifyIdentityModal';
import { api } from '../../utils/api';
import { REAUTH_CHALLENGE_HEADER } from '../../utils/stepUp';

/**
 * The dialog standing in front of five irreversible or data-revealing actions.
 *
 * Every test here is about a way the dialog could strand or mislead the person
 * using it, because that is the failure mode step-up has: the security property
 * is enforced server-side and re-checked when the grant is spent, so nothing this
 * component does can weaken it. What it CAN do is ask for a credential the
 * account does not have, close on a recoverable error and throw away a live
 * challenge, or count down from the wrong moment.
 */

const challenge = (over = {}) => ({
  challengeId: 'reauth-abc',
  action: 'account.delete',
  label: 'Delete your account',
  methods: ['password', 'oauth'],
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  expiresInSeconds: 300,
  ...over
});

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  // The provider row fetches its own list; an unmocked probe would leave every
  // OAuth assertion racing a real request.
  vi.spyOn(api, 'fetchOAuthProviders').mockResolvedValue([
    { id: 'google', label: 'Google', enabled: true, implemented: true },
    { id: 'microsoft', label: 'Microsoft', enabled: true, implemented: true },
    { id: 'apple', label: 'Apple', enabled: false, implemented: false }
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('VerifyIdentityModal — which methods it offers', () => {
  /**
   * The server narrows `methods` to what the account can actually satisfy, and
   * this component must not hold a second opinion. A provider-only account shown
   * a password box is asked five times for something it does not have and is
   * then locked out of the challenge.
   */
  it('shows no password field when the server did not offer that method', async () => {
    render(<VerifyIdentityModal challenge={challenge({ methods: ['oauth'] })} onGranted={() => {}} onCancel={() => {}} />);

    expect(screen.queryByLabelText(/your password/i)).toBeNull();
    await waitFor(() => expect(document.querySelector('.auth-providers')).toBeTruthy());
  });

  it('shows no provider buttons when the server did not offer that method', () => {
    render(<VerifyIdentityModal challenge={challenge({ methods: ['password'] })} onGranted={() => {}} onCancel={() => {}} />);

    expect(screen.getByLabelText(/your password/i)).toBeTruthy();
    expect(document.querySelector('.auth-providers')).toBeNull();
  });

  /**
   * The server refuses to return a methodless challenge, so this is unreachable
   * today. It is covered because the thing to render if that ever changes is a
   * recovery instruction — not an empty dialog with a five-minute countdown.
   */
  it('explains where to get help when the account can prove nothing', () => {
    render(<VerifyIdentityModal challenge={challenge({ methods: [] })} onGranted={() => {}} onCancel={() => {}} />);

    expect(screen.getByRole('alert').textContent).toMatch(/no way to verify/i);
    expect(screen.queryByLabelText(/your password/i)).toBeNull();
  });
});

describe('VerifyIdentityModal — the password leg', () => {
  it('hands the challenge id back on success', async () => {
    const onGranted = vi.fn();
    vi.spyOn(api, 'grantReauthByPassword').mockResolvedValue({ granted: true, method: 'password' });

    render(<VerifyIdentityModal challenge={challenge()} onGranted={onGranted} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'CorrectHorse1' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(onGranted).toHaveBeenCalledWith('reauth-abc'));
    expect(api.grantReauthByPassword).toHaveBeenCalledWith('reauth-abc', 'CorrectHorse1');
  });

  /**
   * The dialog must survive a wrong answer.
   *
   * Closing on failure would discard a challenge that still has attempts left and
   * force the user to start again — and it would hide `attemptsRemaining`, which
   * is the whole reason the server reports it. Somebody with two tries left needs
   * to know that before they spend them.
   */
  it('stays open on a wrong password and reports the attempts left', async () => {
    const onGranted = vi.fn();
    const onCancel = vi.fn();
    vi.spyOn(api, 'grantReauthByPassword').mockRejectedValue(
      Object.assign(new Error('That password is not correct.'), {
        status: 401,
        data: { error: 'That password is not correct.', code: 'invalid_password', attemptsRemaining: 3 }
      })
    );

    render(<VerifyIdentityModal challenge={challenge()} onGranted={onGranted} onCancel={onCancel} />);

    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not correct/i));
    expect(screen.getByRole('alert').textContent).toMatch(/3 tries left/i);
    expect(onGranted).not.toHaveBeenCalled();
    expect(onCancel, 'a failed attempt dismissed the dialog').not.toHaveBeenCalled();
    // Still usable for the next try.
    expect(screen.getByLabelText(/your password/i)).toBeTruthy();
  });

  it('says "try" rather than "tries" when one is left', async () => {
    vi.spyOn(api, 'grantReauthByPassword').mockRejectedValue(
      Object.assign(new Error('nope'), { status: 401, data: { error: 'nope', attemptsRemaining: 1 } })
    );

    render(<VerifyIdentityModal challenge={challenge()} onGranted={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/1 try left/i));
  });
});

describe('VerifyIdentityModal — the countdown', () => {
  it('shows the time remaining on the challenge, not a fixed five minutes', () => {
    // A challenge opened four minutes ago, as a tab restored from the background
    // would see. A timer started at mount would say 5:00 here.
    render(
      <VerifyIdentityModal
        challenge={challenge({ expiresAt: new Date(Date.now() + 61 * 1000).toISOString() })}
        onGranted={() => {}}
        onCancel={() => {}}
      />
    );

    expect(document.body.textContent).toMatch(/1:0\d/);
  });

  it('refuses to submit once it has expired, and says so', () => {
    render(
      <VerifyIdentityModal
        challenge={challenge({ expiresAt: new Date(Date.now() - 1000).toISOString() })}
        onGranted={() => {}}
        onCancel={() => {}}
      />
    );

    expect(document.body.textContent).toMatch(/timed out/i);
    expect(screen.getByLabelText(/your password/i).disabled).toBe(true);
  });
});

describe('VerifyIdentityModal — the provider leg', () => {
  /**
   * The redirect leaves the site, so everything the return journey needs has to
   * be written down first. Without `action` the callback cannot record which
   * grant was earned; without `returnTo` the user is dropped on the callback
   * screen instead of back at the thing they were doing.
   */
  it('records the challenge, action and return path before navigating away', async () => {
    const assign = vi.fn();
    const original = window.location;
    // jsdom's location is not writable; replacing the object is the standard
    // way to observe a navigation without performing one.
    delete window.location;
    window.location = { ...original, pathname: '/settings', search: '?section=security', assign };

    try {
      render(<VerifyIdentityModal challenge={challenge()} onGranted={() => {}} onCancel={() => {}} />);
      const google = await waitFor(() => {
        const b = [...document.querySelectorAll('.auth-providers button')]
          .find(el => /google/i.test(el.textContent));
        expect(b).toBeTruthy();
        return b;
      });

      fireEvent.click(google);

      const pending = JSON.parse(sessionStorage.getItem('wev_reauth_pending'));
      expect(pending).toMatchObject({
        provider: 'google',
        challengeId: 'reauth-abc',
        action: 'account.delete',
        returnTo: '/settings?section=security'
      });
      expect(assign).toHaveBeenCalledWith(
        '/api/auth/reauth/oauth/google?challengeId=reauth-abc'
      );
    } finally {
      window.location = original;
    }
  });
});

describe('the challenge header has one spelling', () => {
  /**
   * The client re-exports the server's constant rather than retyping it. A second
   * spelling would mean the client presenting a grant under a name the server
   * never reads: every request silently resolves to AAL1, every gated action
   * answers `reauth_required`, and the UI loops through this dialog for ever with
   * no error to show for it.
   */
  it('is the wire name the server looks for', () => {
    expect(REAUTH_CHALLENGE_HEADER).toBe('X-Reauth-Challenge');
  });
});
