/**
 * The signup consent control: it renders when there is a notice to point at,
 * it disappears entirely when there is not, and it actually gates.
 *
 * ── Why this file exists ──
 *
 * `VITE_PRIVACY_URL` has been wired into this form since before v1.2c and
 * nothing exercised it. Both halves of its behaviour were therefore unprotected,
 * and they fail in opposite, equally bad directions:
 *
 *   - Set but not rendering → the app collects a minor's name, email, grade and
 *     school with no disclosure and no consent record, which is the launch
 *     blocker the flag exists to remove.
 *   - Rendering but not gating → a checkbox that can be skipped, which is worse
 *     than none: it produces the appearance of consent without the substance,
 *     and it is the appearance that would be relied on later.
 *
 * The third test is the one that matters most, and it is not about rendering at
 * all: with a notice configured, the form must refuse to advance until the box
 * is ticked.
 *
 * The config module is mocked rather than setting `import.meta.env` at runtime,
 * because Vite inlines those values at build time — assigning one in a test
 * changes something the component never reads, and the test would pass against
 * whatever the default happened to be.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const config = vi.hoisted(() => ({ PRIVACY_URL: '', DEMO_MODE: false }));
vi.mock('../config', () => config);

vi.mock('../utils/api', () => ({
  api: {
    signup: vi.fn(),
    checkUsername: vi.fn().mockResolvedValue({ available: true }),
    checkEmail: vi.fn().mockResolvedValue({ available: true }),
    providers: vi.fn().mockResolvedValue({ providers: [] }),
  },
}));

let Signup;
async function renderSignup(privacyUrl) {
  config.PRIVACY_URL = privacyUrl;
  vi.resetModules();
  Signup = (await import('./Signup')).default;
  render(
    <MemoryRouter initialEntries={['/signup']}>
      <Signup onSignupSuccess={vi.fn()} addToast={vi.fn()} />
    </MemoryRouter>
  );
}

/**
 * Fills step 1 so the only thing that can still block it is the checkbox.
 *
 * Waits for the debounced username-availability check to settle: until it does,
 * `detailsBlocker` returns "Checking whether that username is free…", so a
 * synchronous assertion here would be testing the spinner rather than consent.
 */
async function fillIdentity() {
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jordan Ramirez' } });
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'jordan_r' } });
  await screen.findByText(/that username is available/i, {}, { timeout: 3000 });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('with a privacy notice configured', () => {
  const URL = 'https://lincoln.k12.example/privacy';

  it('renders the acknowledgement, linking to the configured notice', async () => {
    await renderSignup(URL);

    const link = screen.getByRole('link', { name: /privacy notice/i });
    expect(link).toHaveAttribute('href', URL);
    expect(screen.getByRole('checkbox', { name: /privacy notice/i })).toBeInTheDocument();
  });

  /**
   * `target="_blank"` without `rel="noopener"` hands the opened page a live
   * `window.opener` back to the signup form. On the one screen where somebody
   * is typing a password, that is worth an assertion of its own.
   */
  it('opens the notice safely in a new tab', async () => {
    await renderSignup(URL);
    const link = screen.getByRole('link', { name: /privacy notice/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('accepts the built-in notice at /privacy as the destination', async () => {
    await renderSignup('/privacy');
    expect(screen.getByRole('link', { name: /privacy notice/i })).toHaveAttribute('href', '/privacy');
  });

  /**
   * The substance. Everything above is presentation; this is whether the
   * consent control does anything.
   */
  it('refuses to advance until the box is ticked, and says why', async () => {
    await renderSignup(URL);
    await fillIdentity();

    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/confirm you have read the privacy notice/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /privacy notice/i }));

    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.queryByText(/confirm you have read the privacy notice/i)).not.toBeInTheDocument();
  });
});

describe('with no privacy notice configured', () => {
  /**
   * The deliberate fail-closed default: no URL means no control at all, rather
   * than a checkbox linking nowhere. A consent checkbox pointing at nothing is
   * worse than an absent one — it manufactures the appearance of a reviewed
   * policy. See the comment on PRIVACY_URL in src/config.js.
   */
  it('renders no acknowledgement and no dead link', async () => {
    await renderSignup('');

    expect(screen.queryByRole('link', { name: /privacy notice/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /privacy notice/i })).not.toBeInTheDocument();
  });

  it('does not block signup on a consent that cannot be given', async () => {
    await renderSignup('');
    await fillIdentity();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled()
    );
  });
});
