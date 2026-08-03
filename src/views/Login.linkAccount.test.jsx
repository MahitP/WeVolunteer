import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';
import { api } from '../utils/api';

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
 * what is missing is the session. So the fix is to sign in, and to connect from
 * Settings afterwards, where the button carries a verification.
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
  vi.spyOn(api, 'fetchOAuthProviders').mockResolvedValue([
    { id: 'google', label: 'Google', enabled: true, implemented: true },
    { id: 'microsoft', label: 'Microsoft', enabled: true, implemented: true }
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('the provider-link screen signs in rather than linking', () => {
  it('signs in with the named account and never calls the link endpoint', async () => {
    const link = vi.spyOn(api, 'linkOAuthAccount');
    const login = vi.spyOn(api, 'login').mockResolvedValue({
      user: { id: 'u1', name: 'Priya Patel' },
      emailVerified: true
    });
    const { onLoginSuccess } = renderLinkScreen();

    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'CorrectHorse1' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());

    // The account is taken from linkData, not from a field the user could edit
    // into a different address than the one the screen is about.
    expect(login).toHaveBeenCalledWith(linkData.email, 'CorrectHorse1');
    expect(
      link,
      'called /api/oauth/link from a signed-out screen, which cannot succeed since Task 6'
    ).not.toHaveBeenCalled();
  });

  /**
   * The screen must not promise to connect the provider, because it does not.
   * Connecting is one step later, in Settings, and saying so is the difference
   * between a two-step flow and a dead end.
   */
  it('tells the user where connecting actually happens', async () => {
    vi.spyOn(api, 'login').mockResolvedValue({
      user: { id: 'u1', name: 'Priya Patel' },
      emailVerified: true
    });
    const addToast = vi.fn();
    renderLinkScreen(addToast);

    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'CorrectHorse1' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => {
      const said = addToast.mock.calls.map(c => String(c[0])).join(' | ');
      expect(said, `toasts were: ${said}`).toMatch(/connect Microsoft from Settings/i);
    });
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
