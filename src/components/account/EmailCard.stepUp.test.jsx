import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import EmailCard from './EmailCard';
import { api } from '../../utils/api';
import { REAUTH_CHALLENGE_HEADER } from '../../utils/stepUp';

/**
 * The params binding, end to end, on the one action that has params.
 *
 * `email.change` binds `newEmail`, and the server folds the RAW body value into
 * the challenge's `params_hash`, then re-derives it from the actual request when
 * the grant is spent. So the string sent to `/reauth/challenge` and the string
 * sent to `/change-email` must be byte-identical.
 *
 * The failure mode if they are not is the worst kind: the user types their
 * address, verifies correctly, and the action is refused with `params_mismatch`.
 * Nothing in the interface can explain that, and it is indistinguishable from
 * step-up being broken. `docs/plans/task-6-report.md` flagged the raw-vs-
 * normalised binding as exactly this hazard, which is why `EmailCard` holds one
 * local and passes it to both calls, and why this test exists rather than a
 * comment asking the next person not to inline `.trim()`.
 *
 * The trailing whitespace in the typed value is the point: it is what a real
 * person produces by copying an address out of an email, and it is what makes a
 * trim-in-one-place bug fire.
 */

const TYPED = '  New.Address@Example.org  ';
const EXPECTED = 'New.Address@Example.org';

const currentUser = { id: 'u1', email: 'old@example.org', hasPassword: true };

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  vi.spyOn(api, 'fetchPendingEmailChange').mockResolvedValue({ pending: null });
  vi.spyOn(api, 'fetchOAuthProviders').mockResolvedValue([
    { id: 'google', label: 'Google', enabled: true, implemented: true }
  ]);
});
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

async function openForm() {
  render(<EmailCard currentUser={currentUser} addToast={() => {}} onProfileChange={() => {}} />);
  const change = await waitFor(() => screen.getByRole('button', { name: /change email|change address|change/i }));
  fireEvent.click(change);
  return waitFor(() => screen.getByLabelText(/new email/i));
}

describe('EmailCard binds the address it is actually going to send', () => {
  it('opens the challenge and sends the change with the identical string', async () => {
    const bodies = [];
    vi.spyOn(api, 'openReauthChallenge').mockImplementation(async (action, params) => {
      bodies.push({ call: 'challenge', action, params });
      return {
        challengeId: 'reauth-e1',
        action,
        label: 'Change your email address',
        methods: ['password'],
        expiresAt: new Date(Date.now() + 300000).toISOString()
      };
    });
    vi.spyOn(api, 'changeEmail').mockImplementation(async (newEmail, headers) => {
      bodies.push({ call: 'change', newEmail, headers });
      if (!headers?.[REAUTH_CHALLENGE_HEADER]) {
        throw Object.assign(new Error('Identity verification required'), {
          status: 403, data: { code: 'reauth_required', action: 'email.change' }
        });
      }
      return { pending: EXPECTED };
    });
    vi.spyOn(api, 'grantReauthByPassword').mockResolvedValue({ granted: true, method: 'password' });

    const input = await openForm();
    fireEvent.change(input, { target: { value: TYPED } });
    fireEvent.click(screen.getByRole('button', { name: /send confirmation link/i }));

    // The dialog appears because the first attempt was refused.
    const pw = await waitFor(() => screen.getByLabelText(/your password/i));
    fireEvent.change(pw, { target: { value: 'CorrectHorse1' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(bodies.filter(b => b.call === 'change')).toHaveLength(2));

    const challengeCall = bodies.find(b => b.call === 'challenge');
    const changeCalls = bodies.filter(b => b.call === 'change');

    expect(challengeCall.action).toBe('email.change');
    expect(challengeCall.params).toEqual({ newEmail: EXPECTED });

    // Both attempts — the one that was refused and the one that carried the
    // grant — must send the SAME value the challenge was bound to.
    for (const call of changeCalls) {
      expect(call.newEmail, 'the bound address and the sent address diverged').toBe(EXPECTED);
    }
    expect(changeCalls[0].headers).toEqual({});
    expect(changeCalls[1].headers).toEqual({ [REAUTH_CHALLENGE_HEADER]: 'reauth-e1' });
  });

  /**
   * The password field is gone from this form. It was the endpoint's proof of
   * identity and is now the dialog's, and a form that still asked for it would be
   * collecting a credential nothing checks.
   */
  it('no longer asks for the account password inline', async () => {
    await openForm();
    expect(screen.queryByLabelText(/^your password$/i)).toBeNull();
  });
});
