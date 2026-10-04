/**
 * The signup consent controls: they always render, they gate, and the answer
 * they collect actually reaches the server.
 *
 * ── What this file used to assert, and why that changed ──
 *
 * The previous version tested a single "I have read the privacy notice"
 * checkbox wrapped in `{PRIVACY_URL && …}`, and its last case asserted that
 * with no URL configured the form "does not block signup on a consent that
 * cannot be given". That was the right test for the old design and is the wrong
 * test now, because the old design had two holes that between them made the
 * whole control decorative:
 *
 *   1. `PRIVACY_URL` defaulted to `''`, so a stock build rendered NO consent
 *      control at all — the "fail-closed default" failed open in practice, by
 *      collecting a minor's name, email, grade and school with no disclosure.
 *   2. `baseFields()` — the object actually POSTed — never included the answer.
 *      It was validated in the browser and dropped. The server never saw it and
 *      nothing stored it, so the platform could not show that any user had ever
 *      accepted anything.
 *
 * Both are fixed: `PRIVACY_URL` defaults to the built-in `/privacy`, the
 * conditional is gone, there are two controls (a contract and a disclosure,
 * which are different acts), and the server refuses a signup whose consent
 * block is absent or incomplete (server/consent.js).
 *
 * The most important test here is the last one. Everything else is presentation;
 * that one is whether the answer travels.
 *
 * The config module is mocked rather than setting `import.meta.env` at runtime,
 * because Vite inlines those values at build time — assigning one in a test
 * changes something the component never reads.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const config = vi.hoisted(() => ({ PRIVACY_URL: '/privacy', DEMO_MODE: false }));
vi.mock('../config', () => config);

const apiMock = vi.hoisted(() => ({
  signup: vi.fn().mockResolvedValue({ user: { id: 'u1', name: 'Jordan' } }),
  checkUsername: vi.fn().mockResolvedValue({ available: true }),
  checkEmail: vi.fn().mockResolvedValue({ available: true }),
  providers: vi.fn().mockResolvedValue({ providers: [] }),
  // Step 2 renders ProviderButtons, which probes for sign-in providers on mount.
  fetchOAuthProviders: vi.fn().mockResolvedValue([]),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

let Signup;
async function renderSignup(privacyUrl = '/privacy') {
  config.PRIVACY_URL = privacyUrl;
  vi.resetModules();
  Signup = (await import('./Signup')).default;
  render(
    <MemoryRouter initialEntries={['/signup']}>
      <Signup onSignupSuccess={vi.fn()} addToast={vi.fn()} />
    </MemoryRouter>
  );
}

const termsBox = () => screen.getByRole('checkbox', { name: /terms of service/i });
const privacyBox = () => screen.getByRole('checkbox', { name: /handles my information/i });

/**
 * Fills step 1 so the only thing that can still block it is consent.
 *
 * Waits for the debounced username-availability check to settle: until it does,
 * `detailsBlocker` returns "Checking whether that username is free…", so a
 * synchronous assertion would be testing the spinner rather than consent.
 */
async function fillIdentity() {
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jordan Ramirez' } });
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'jordan_r' } });
  // The age gate sits above consent in `detailsBlocker`, so an unfilled date of
  // birth would mask the consent messages these tests are about.
  fireEvent.change(screen.getByLabelText(/date of birth/i), { target: { value: '2007-06-15' } });
  await screen.findByText(/that username is available/i, {}, { timeout: 3000 });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe('the consent controls', () => {
  it('renders both controls — a contract and a disclosure are different acts', async () => {
    await renderSignup();
    expect(termsBox()).toBeInTheDocument();
    expect(privacyBox()).toBeInTheDocument();
  });

  it('uses the honest verb for each', async () => {
    await renderSignup();
    // You cannot "agree" to a privacy notice: it is a disclosure, and asking a
    // fourteen-year-old to agree implies they could disagree and still sign up.
    expect(screen.getByText(/I agree to the Terms of Service/i)).toBeInTheDocument();
    // The label uses a typographic apostrophe (&rsquo;), so match around it.
    expect(screen.getByText(/seen how WeVolunteer handles my information/i)).toBeInTheDocument();
  });

  it('names the Community Guidelines on the Terms control', async () => {
    // They are incorporated by reference and share the checkbox, but an
    // unnamed rulebook is unenforceable in practice.
    await renderSignup();
    expect(screen.getByText(/follow the Community Guidelines/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /read the guidelines/i })).toBeInTheDocument();
  });

  it('renders even with no VITE_PRIVACY_URL configured', async () => {
    // The regression that made all of this decorative: the control used to be
    // wrapped in `{PRIVACY_URL && …}` with an empty default, so a stock build
    // asked for nothing.
    await renderSignup('');
    expect(termsBox()).toBeInTheDocument();
    expect(privacyBox()).toBeInTheDocument();
  });

  it('points the privacy link at the built-in notice by default', async () => {
    await renderSignup('/privacy');
    expect(screen.getByRole('link', { name: /read the privacy policy/i }))
      .toHaveAttribute('href', '/privacy');
  });

  it('honours a configured external notice', async () => {
    const URL = 'https://lincoln.k12.example/privacy';
    await renderSignup(URL);
    expect(screen.getByRole('link', { name: /read the privacy policy/i })).toHaveAttribute('href', URL);
  });

  /**
   * `target="_blank"` without `rel="noopener"` hands the opened page a live
   * `window.opener` back to the signup form. On the one screen where somebody
   * is about to type a password, that is worth its own assertion — and opening
   * in a new tab is itself the point: losing a half-filled form because you
   * opened the Terms is how people learn not to open the Terms.
   */
  it('opens every policy link safely in a new tab', async () => {
    await renderSignup();
    for (const name of [/read the terms/i, /read the guidelines/i, /read the privacy policy/i]) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toMatch(/noopener/);
    }
  });

  it('tells an under-18 user to involve a guardian', async () => {
    await renderSignup();
    expect(screen.getByText(/parent or guardian/i)).toBeInTheDocument();
  });

  /**
   * The organizer option is a disclosure too: it says what stands between the
   * account and posting. It used to name "a school administrator". WeVolunteer
   * is independent of schools, and the approval is a WeVolunteer
   * administrator's (`verified`, checked by POST /api/events).
   */
  it('says who approves an organizer account, and what the approval gates', async () => {
    await renderSignup();
    expect(screen.getByText(/A WeVolunteer administrator approves your account before you can post events\./))
      .toBeInTheDocument();
    expect(screen.queryByText(/school administrator/i)).not.toBeInTheDocument();
  });
});

describe('the consent controls actually gate', () => {
  it('blocks until BOTH are ticked, and says which is missing', async () => {
    await renderSignup();
    await fillIdentity();

    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/agree to the Terms of Service to continue/i)).toBeInTheDocument();

    // One is not enough — the old single-checkbox design is exactly what this
    // guards against.
    fireEvent.click(termsBox());
    await waitFor(() =>
      expect(screen.getByText(/seen how we handle your information/i)).toBeInTheDocument()
    );
    expect(submit).toBeDisabled();

    fireEvent.click(privacyBox());
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it('blocks on the Terms alone when only privacy is ticked', async () => {
    await renderSignup();
    await fillIdentity();

    fireEvent.click(privacyBox());
    await waitFor(() =>
      expect(screen.getByText(/agree to the Terms of Service to continue/i)).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });
});

describe('the answer reaches the server', () => {
  /**
   * The test that matters most, and the one whose absence let the original
   * defect ship: the previous control was validated in the browser and then
   * dropped by `baseFields()`, so the server never received it and no table
   * stored it.
   *
   * Asserting on the payload — not on the checkbox — is the only form of this
   * test that would have caught that.
   */
  it('includes the consent block in the signup payload', async () => {
    await renderSignup();
    await fillIdentity();

    fireEvent.click(termsBox());
    fireEvent.click(privacyBox());

    const cont = screen.getByRole('button', { name: /continue/i });
    await waitFor(() => expect(cont).toBeEnabled());
    fireEvent.click(cont);

    // Step 2 asks HOW you will sign in before showing the email form.
    const useEmail = await screen.findByRole('button', { name: /email address and password/i }, { timeout: 3000 });
    fireEvent.click(useEmail);

    const email = await screen.findByLabelText(/email address/i, {}, { timeout: 3000 });
    fireEvent.change(email, { target: { value: 'jordan@example.org' } });
    fireEvent.change(screen.getByLabelText(/create a password/i), { target: { value: 'Str0ng!Passphrase9' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'Str0ng!Passphrase9' } });

    const create = screen.getByRole('button', { name: /create account/i });
    await waitFor(() => expect(create).toBeEnabled(), { timeout: 3000 });
    fireEvent.click(create);

    await waitFor(() => expect(apiMock.signup).toHaveBeenCalled(), { timeout: 3000 });

    const payload = apiMock.signup.mock.calls[0][0];
    expect(
      payload.consent,
      'the consent answer must travel with the signup request — validating it in the browser '
      + 'and dropping it before the POST is the exact defect this whole subsystem exists to fix'
    ).toEqual({ termsOfService: true, privacyPolicy: true });
  });
});
