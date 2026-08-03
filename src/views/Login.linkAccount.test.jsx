import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';
import { api } from '../utils/api';
import { REAUTH_CHALLENGE_HEADER } from '../utils/stepUp';

/**
 * The "an account already uses this address" screen.
 *
 * ── Why this file exists ──
 *
 * v1.2b Task 6 made `POST /api/oauth/link` authenticated and gated it on
 * `requireAAL2('oauth.link')`. This screen is on the SIGNED-OUT Login view and
 * was still calling that endpoint with a password, so after Task 6 it could not
 * succeed: `authenticateToken` refuses before the handler runs, and the catch
 * reported "Incorrect password." whatever the user typed. A dead end that
 * blamed the user for it.
 *
 * The whole client suite stayed green through that change, because nothing
 * exercised this screen's submit. That is the actual defect this file fixes —
 * the broken call was a symptom.
 *
 * `link_required` is returned when an account already holds the PROVIDER'S OWN
 * address and the caller is not signed in as that account. The addresses match;
 * what is missing is the session. So the screen signs in, and then spends a
 * step-up grant to redeem the link token it is still holding — which costs the
 * user one verification instead of a verification plus a second round trip
 * through the provider to reach the `auto_linked` branch and the same end state.
 *
 * The ordering assertion in the first test is the load-bearing one:
 * `onLoginSuccess()` unmounts this component, taking the dialog and the token
 * with it, so the link must finish first.
 */

const linkData = {
  email: 'priya.patel.nhs@outlook.com',
  provider: 'microsoft',
  linkToken: 'link-token-abc'
};

const renderLinkScreen = (addToast = vi.fn()) => {
  const onLoginSuccess = vi.fn();
  render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state: { linkData } }]}>
      <Login onLoginSuccess={onLoginSuccess} addToast={addToast} />
    </MemoryRouter>
  );
  return { onLoginSuccess, addToast };
};

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  vi.spyOn(api, 'fetchOAuthProviders').mockResolvedValue([
    { id: 'google', label: 'Google', enabled: true, implemented: true },
    { id: 'microsoft', label: 'Microsoft', enabled: true, implemented: true }
  ]);
});
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

const mockChallenge = () =>
  vi.spyOn(api, 'openReauthChallenge').mockResolvedValue({
    challengeId: 'reauth-l1',
    action: 'oauth.link',
    label: 'Connect a sign-in provider',
    methods: ['password'],
    expiresAt: new Date(Date.now() + 300000).toISOString()
  });

describe('the provider-link screen signs in, then links', () => {
  /**
   * The order is the correctness property. `onLoginSuccess()` unmounts this
   * component — App re-renders into the authenticated shell — and with it goes
   * the verification dialog and the token in `location.state`. So the link has
   * to be finished first.
   */
  it('signs in, spends a grant, links, and only then hands over', async () => {
    const order = [];
    vi.spyOn(api, 'login').mockImplementation(async () => {
      order.push('login');
      return { user: { id: 'u1', name: 'Priya Patel' }, emailVerified: true };
    });
    mockChallenge();
    vi.spyOn(api, 'grantReauthByPassword').mockResolvedValue({ granted: true, method: 'password' });
    const link = vi.spyOn(api, 'linkOAuthAccount').mockImplementation(async (token, headers) => {
      order.push('link');
      if (!headers?.[REAUTH_CHALLENGE_HEADER]) {
        throw Object.assign(new Error('Identity verification required'), {
          status: 403, data: { code: 'reauth_required', action: 'oauth.link' }
        });
      }
      return { linked: true };
    });

    const onLoginSuccess = vi.fn(() => order.push('handover'));
    render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state: { linkData } }]}>
        <Login onLoginSuccess={onLoginSuccess} addToast={vi.fn()} />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'CorrectHorse1' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    // The dialog appears because the first link attempt was refused.
    const pw = await waitFor(() => screen.getByLabelText(/your password/i));
    fireEvent.change(pw, { target: { value: 'CorrectHorse1' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());

    // The account comes from linkData, not from a field the user could edit into
    // a different address than the one the screen is about.
    expect(api.login).toHaveBeenCalledWith(linkData.email, 'CorrectHorse1');
    expect(api.openReauthChallenge).toHaveBeenCalledWith('oauth.link', { provider: 'microsoft' });
    expect(link.mock.calls.at(-1)[0]).toBe(linkData.linkToken);
    expect(link.mock.calls.at(-1)[1]).toEqual({ [REAUTH_CHALLENGE_HEADER]: 'reauth-l1' });

    /**
     * The whole sequence, asserted as a sequence rather than as a set.
     *
     * `handover` last is the property that matters: it unmounts this component,
     * so anything after it would never run. An earlier draft asserted
     * `order.indexOf('link') < order.length`, which is true of any array
     * containing 'link' and therefore checked nothing.
     */
    expect(order).toEqual(['login', 'link', 'link', 'handover']);
  });

  /**
   * Dismissing the verification leaves the user signed in, because they are —
   * the session is real. Reporting a failure for something that half worked, and
   * then dropping them into the app anyway, is the confusing outcome.
   */
  it('still signs in when the verification is dismissed, and says where to finish', async () => {
    vi.spyOn(api, 'login').mockResolvedValue({
      user: { id: 'u1', name: 'Priya Patel' }, emailVerified: true
    });
    mockChallenge();
    vi.spyOn(api, 'linkOAuthAccount').mockRejectedValue(
      Object.assign(new Error('Identity verification required'), {
        status: 403, data: { code: 'reauth_required', action: 'oauth.link' }
      })
    );

    const addToast = vi.fn();
    const { onLoginSuccess } = renderLinkScreen(addToast);
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'CorrectHorse1' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    // Cancel the dialog rather than answering it.
    const cancel = await waitFor(() => screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(cancel);

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());
    const said = addToast.mock.calls.map(c => String(c[0])).join(' | ');
    expect(said, `toasts were: ${said}`).toMatch(/connect Microsoft from Settings/i);
  });

  it('does not attempt the link at all when the password is wrong', async () => {
    const link = vi.spyOn(api, 'linkOAuthAccount');
    vi.spyOn(api, 'login').mockRejectedValue(
      Object.assign(new Error('That password is not correct.'), {
        status: 401, data: { error: 'That password is not correct.', code: 'wrong_password' }
      })
    );
    const { onLoginSuccess } = renderLinkScreen();

    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not correct/i));
    expect(link, 'tried to link without a session').not.toHaveBeenCalled();
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('surfaces a wrong password on the password field, not as a link failure', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(
      Object.assign(new Error('That password is not correct.'), {
        status: 401, data: { error: 'That password is not correct.', code: 'wrong_password' }
      })
    );
    const { onLoginSuccess } = renderLinkScreen();

    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not correct/i));
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('names the provider in the heading so the screen explains itself', () => {
    renderLinkScreen();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Microsoft/);
  });
});
