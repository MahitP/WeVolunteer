import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { api } from './utils/api';

/**
 * Audit findings C1 and C2 — auth-flow routes must resolve in every session
 * state.
 *
 * `/oauth/callback` and `/reset-password` used to be registered only in the
 * signed-out route table, so the authenticated shell's `*` catch-all swallowed
 * both:
 *
 *   • Pressing "Connect" in Settings sent the user to Google and brought them
 *     back to a path that redirected to the dashboard. The authorization code
 *     was never exchanged, nothing was linked, and nothing said so — which also
 *     made the server's entire `auto_linked` branch unreachable in practice.
 *   • A user already signed in on their phone who tapped the password-reset
 *     link in their email landed on the dashboard.
 *
 * Both shipped past a fully green suite because nothing mounted App and asserted
 * which routes resolve for an authenticated user. That is what this file does.
 */

vi.mock('./utils/api');
vi.mock('./services/socket', () => ({
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn()
}));

const VERIFIED_STUDENT = {
  id: 'user-1',
  name: 'Leo Chen',
  email: 'leo@example.org',
  username: 'leochen',
  role: 'student',
  verified: true,
  emailVerified: true,
  hasPassword: true,
  avatar: '🧑‍💻',
  skills: []
};

/** Signed in, confirmed — the state in which both routes used to be swallowed. */
function signedIn() {
  api.getMe.mockResolvedValue(VERIFIED_STUDENT);
  api.fetchEvents.mockResolvedValue([]);
  api.fetchApplications.mockResolvedValue([]);
  api.fetchFavorites.mockResolvedValue([]);
  api.fetchNotifications.mockResolvedValue({ unreadCount: 0, notifications: [] });
}

/** No session at all. */
function signedOut() {
  api.getMe.mockResolvedValue(null);
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <App />
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  // completeOAuth is left pending so the callback screen stays on its
  // "Completing sign-in…" state and the assertion is about routing, not about
  // what the server said.
  api.completeOAuth.mockReturnValue(new Promise(() => {}));
  api.fetchOAuthProviders.mockResolvedValue([]);
});

describe('C1 — /oauth/callback resolves for an authenticated user', () => {
  it('renders the callback screen instead of redirecting to the dashboard', async () => {
    signedIn();

    // A real return from a provider: code and state in the query string.
    renderAt('/oauth/callback?code=abc&state=x.eyJwcm92aWRlciI6Imdvb2dsZSJ9.y');

    expect(await screen.findByText(/Completing sign-in/i)).toBeInTheDocument();
  });

  it('actually exchanges the authorization code', async () => {
    signedIn();

    renderAt('/oauth/callback?code=abc&state=x.eyJwcm92aWRlciI6Imdvb2dsZSJ9.y');

    // The regression was silent precisely because this never happened.
    await waitFor(() => expect(api.completeOAuth).toHaveBeenCalled());
    expect(api.completeOAuth).toHaveBeenCalledWith('google', 'abc', expect.any(String));
  });

  it('still resolves for a signed-out user', async () => {
    signedOut();

    renderAt('/oauth/callback?code=abc&state=x.eyJwcm92aWRlciI6Imdvb2dsZSJ9.y');

    expect(await screen.findByText(/Completing sign-in/i)).toBeInTheDocument();
  });
});

describe('C2 — /reset-password resolves for an authenticated user', () => {
  it('renders the reset form instead of redirecting to the dashboard', async () => {
    signedIn();

    renderAt('/reset-password?token=abc123');

    expect(await screen.findByRole('heading', { name: /Choose a new password/i })).toBeInTheDocument();
  });

  it('still resolves for a signed-out user', async () => {
    signedOut();

    renderAt('/reset-password?token=abc123');

    expect(await screen.findByRole('heading', { name: /Choose a new password/i })).toBeInTheDocument();
  });

  it('reports a truncated link rather than showing a form that cannot work', async () => {
    signedIn();

    renderAt('/reset-password');

    expect(await screen.findByRole('heading', { name: /reset link is incomplete/i })).toBeInTheDocument();
  });

  /**
   * The ?reset=<token> shape is what the email actually contains — the link
   * points at the app root, and App rewrites it to /reset-password. That
   * rewrite existed before the fix but led straight into the swallowed route.
   */
  it('accepts the ?reset= link shape the email sends', async () => {
    signedIn();

    renderAt('/?reset=abc123');

    expect(await screen.findByRole('heading', { name: /Choose a new password/i })).toBeInTheDocument();
  });

  /**
   * The SIGNED-OUT arm, which is the one an emailed reset link actually hits.
   *
   * Somebody following a reset link is, by definition, locked out — so this is
   * the path that matters, and it was untested: the case above signs the user
   * IN first and therefore never reaches the signed-out catch-all where the
   * rewrite lives.
   *
   * Found by mutation: replacing `searchParams.has('reset')` with `false` broke
   * password recovery for every locked-out user and the whole client suite
   * stayed green. v1.2c Task 8 rewrote the else arm of that same ternary to
   * render a 404, which is exactly the edit that could have taken this branch
   * with it.
   */
  it('rewrites ?reset= for a SIGNED-OUT visitor, who is the one following the email', async () => {
    signedOut();

    renderAt('/?reset=abc123');

    expect(await screen.findByRole('heading', { name: /Choose a new password/i })).toBeInTheDocument();
  });

  it('shows a signed-out visitor 404 for an unknown path carrying no reset token', async () => {
    signedOut();

    renderAt('/nope');

    // The other arm of the same ternary — asserted here so the two cannot be
    // collapsed into one another without a test noticing.
    expect(await screen.findByRole('heading', { name: /on the board/i })).toBeInTheDocument();
  });
});
