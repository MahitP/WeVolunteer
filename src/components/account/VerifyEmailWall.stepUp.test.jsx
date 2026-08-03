import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import VerifyEmailWall from './VerifyEmailWall';
import { api } from '../../utils/api';
import { REAUTH_CHALLENGE_HEADER } from '../../utils/stepUp';

/**
 * Correcting a mistyped address from behind the verification wall.
 *
 * ── Why this screen gets its own test file ──
 *
 * It is the only way out for an account whose email address has a typo in it.
 * `/api/auth/change-email` is on the server's email-gate allowlist *specifically*
 * so this screen can reach it, and v1.2b added the `/api/auth/reauth/` prefix to
 * the same allowlist so the verification is reachable too.
 *
 * v1.2b Task 6 replaced the endpoint's inline `bcrypt.compare` with
 * `requireAAL2('email.change')`, and this form was still passing a password into
 * the argument that is now the headers object. So the allowlist was rescuing a
 * user the client then locked out anyway — and the suite stayed green, because
 * nothing exercised this form. That absence was the defect.
 *
 * The trailing whitespace in the typed value is deliberate: it is what a real
 * person produces by copying an address out of an email, and it is what makes a
 * trim-in-one-place binding bug fire.
 */

const TYPED = '  Fixed.Address@Example.org  ';
const EXPECTED = 'Fixed.Address@Example.org';

const user = { id: 'u1', email: 'typo@exmaple.org', hasPassword: true, emailVerified: false };

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  vi.spyOn(api, 'fetchOAuthProviders').mockResolvedValue([
    { id: 'google', label: 'Google', enabled: true, implemented: true }
  ]);
});
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

const openFixForm = () => {
  const addToast = vi.fn();
  render(
    <VerifyEmailWall user={user} addToast={addToast} onSignOut={() => {}} onVerified={() => {}} />
  );
  fireEvent.click(screen.getByRole('button', { name: /that address is wrong/i }));
  return { addToast, input: screen.getByLabelText(/your email address/i) };
};

describe('VerifyEmailWall — correcting the address', () => {
  it('verifies, then sends the identical string it bound', async () => {
    const calls = [];
    vi.spyOn(api, 'openReauthChallenge').mockImplementation(async (action, params) => {
      calls.push({ call: 'challenge', action, params });
      return {
        challengeId: 'reauth-w1',
        action,
        label: 'Change your email address',
        methods: ['password'],
        expiresAt: new Date(Date.now() + 300000).toISOString()
      };
    });
    vi.spyOn(api, 'changeEmail').mockImplementation(async (newEmail, headers) => {
      calls.push({ call: 'change', newEmail, headers });
      if (!headers?.[REAUTH_CHALLENGE_HEADER]) {
        throw Object.assign(new Error('Identity verification required'), {
          status: 403, data: { code: 'reauth_required', action: 'email.change' }
        });
      }
      return { pending: EXPECTED };
    });
    vi.spyOn(api, 'grantReauthByPassword').mockResolvedValue({ granted: true, method: 'password' });

    const { addToast, input } = openFixForm();
    fireEvent.change(input, { target: { value: TYPED } });
    fireEvent.click(screen.getByRole('button', { name: /send the link here instead/i }));

    const pw = await waitFor(() => screen.getByLabelText(/your password/i));
    fireEvent.change(pw, { target: { value: 'CorrectHorse1' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(calls.filter(c => c.call === 'change')).toHaveLength(2));

    expect(calls.find(c => c.call === 'challenge').params).toEqual({ newEmail: EXPECTED });
    for (const c of calls.filter(c => c.call === 'change')) {
      expect(c.newEmail, 'the bound address and the sent address diverged').toBe(EXPECTED);
    }
    await waitFor(() =>
      expect(addToast.mock.calls.map(c => String(c[0])).join(' | ')).toMatch(/Confirmation link sent/i)
    );
  });

  /**
   * The regression that mattered. Passing a password where headers are expected
   * meant the request went out with a spread string for headers and no grant, so
   * the user was told "Could not change that address" and had no way out at all.
   */
  it('does not send a password as the second argument', async () => {
    const changeEmail = vi.spyOn(api, 'changeEmail').mockResolvedValue({ pending: EXPECTED });
    vi.spyOn(api, 'openReauthChallenge').mockResolvedValue({
      challengeId: 'reauth-w2', action: 'email.change', methods: ['password'],
      expiresAt: new Date(Date.now() + 300000).toISOString()
    });

    const { input } = openFixForm();
    fireEvent.change(input, { target: { value: TYPED } });
    fireEvent.click(screen.getByRole('button', { name: /send the link here instead/i }));

    await waitFor(() => expect(changeEmail).toHaveBeenCalled());
    const [, second] = changeEmail.mock.calls[0];
    expect(typeof second, 'a string here is the Task 6 signature bug').not.toBe('string');
  });

  it('no longer asks for a password inline — the dialog does that now', () => {
    openFixForm();
    expect(screen.queryByLabelText(/^your password$/i)).toBeNull();
  });

  it('can be submitted with only an address, so a provider-only account is not stuck', () => {
    render(
      <VerifyEmailWall
        user={{ ...user, hasPassword: false }}
        addToast={() => {}} onSignOut={() => {}} onVerified={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /that address is wrong/i }));
    fireEvent.change(screen.getByLabelText(/your email address/i), { target: { value: TYPED } });

    expect(screen.getByRole('button', { name: /send the link here instead/i }).disabled).toBe(false);
  });
});
