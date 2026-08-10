import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import TwoFactorSetup from './TwoFactorSetup';
import { api } from '../../utils/api';
import { REAUTH_CHALLENGE_HEADER } from '../../utils/stepUp';

/**
 * Enrolling a second factor — the flow reported as "it asks for my password and
 * then gets stuck".
 *
 * Every test here is about a way the flow could strand somebody or destroy
 * something they cannot get back. The security property is enforced server-side
 * (`requireAAL2` + `spendChallenge`, re-checked when the grant is spent), so
 * nothing this component does can weaken it. What it CAN do is ask for the
 * password at a moment that makes a 30-second code expire, ask again for every
 * mistyped digit, or replace the screen showing ten unrecoverable recovery codes
 * before anyone has read them.
 */

const STATUS_OFF = {
  enabled: false,
  methods: { totp: false, email: false },
  recoveryCodesRemaining: 0,
  roleRequires2FA: false
};

const CODES = Array.from({ length: 10 }, (_, i) => `CODE${String(i).padStart(6, '0')}`);

/** Records every `/api/2fa/*` call so ordering and headers can be asserted. */
function mockServer({ status = STATUS_OFF, enable, generate } = {}) {
  const calls = [];
  vi.spyOn(api, 'apiFetch').mockImplementation(async (url, options = {}) => {
    calls.push({ url, options, headers: options.headers ?? {} });

    if (url === '/api/2fa/status') return status;

    const grant = (options.headers ?? {})[REAUTH_CHALLENGE_HEADER];

    if (url === '/api/2fa/generate') {
      if (generate) return generate({ grant });
      if (!grant) throw reauthRequired('2fa.generate');
      return { secret: 'JBSWY3DPEHPK3PXP', qr: 'data:image/png;base64,QR' };
    }

    if (url === '/api/2fa/enable') {
      if (!grant) throw reauthRequired('2fa.enable');
      if (enable) return enable({ grant, body: JSON.parse(options.body) });
      return { success: true, recoveryCodes: CODES };
    }

    if (url === '/api/2fa/disable') {
      if (!grant) throw reauthRequired('2fa.disable');
      return { success: true };
    }

    if (url === '/api/2fa/recovery-codes/regenerate') {
      if (!grant) throw reauthRequired('2fa.recovery.regenerate');
      return { success: true, recoveryCodes: CODES };
    }

    if (url === '/api/2fa/email/enable') {
      if (!grant) throw reauthRequired('2fa.enable');
      return { success: true, recoveryCodes: CODES };
    }

    throw new Error(`unmocked ${url}`);
  });
  return calls;
}

/** The shape `requireAAL2` refuses with. */
function reauthRequired(action) {
  const err = new Error('Identity verification required');
  err.status = 403;
  err.data = { error: 'Identity verification required', code: 'reauth_required', action };
  return err;
}

function mockChallenges({ methods = ['password'] } = {}) {
  const opened = [];
  vi.spyOn(api, 'openReauthChallenge').mockImplementation(async (action) => {
    const challenge = {
      challengeId: `reauth-${action}`,
      action,
      label: action === '2fa.generate'
        ? 'set up two-factor authentication'
        : 'enable two-factor authentication',
      methods,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      expiresInSeconds: 300
    };
    opened.push(challenge);
    return challenge;
  });
  return opened;
}

const setup = (props = {}) => {
  const addToast = vi.fn();
  const onSetupComplete = vi.fn();
  const utils = render(
    <TwoFactorSetup
      currentUser={{ id: 'u1', email: 'admin@school.org', role: 'admin' }}
      addToast={addToast}
      onSetupComplete={onSetupComplete}
      {...props}
    />
  );
  return { ...utils, addToast, onSetupComplete };
};

/** Answer the verification dialog with a password. */
async function answerPassword(password = 'correct horse') {
  const field = await screen.findByLabelText(/your password/i);
  fireEvent.change(field, { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  vi.spyOn(api, 'fetchOAuthProviders').mockResolvedValue([]);
  vi.spyOn(api, 'grantReauthByPassword').mockResolvedValue({ granted: true, method: 'password' });
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

/* ── Surviving a remount ────────────────────────────────────────────────── */

describe('under StrictMode', () => {
  /**
   * ── The bug ──
   *
   * `liveRef` guards every `setState` in this component so an in-flight request
   * cannot write to an unmounted tree. It was
   *
   *     const liveRef = useRef(true);
   *     useEffect(() => () => { liveRef.current = false; }, []);
   *
   * — cleanup only. A ref survives a remount, and StrictMode (which `main.jsx`
   * wraps the whole application in) deliberately mounts, unmounts and remounts
   * every component once in development. So the cleanup ran, wrote `false`, and
   * nothing ever wrote `true` again: the ref was false for the component's entire
   * life and every guarded write was skipped.
   *
   * The visible result was that authenticator enrolment did nothing in
   * development. Pressing "Use authenticator app" asked for the password,
   * verified it, called `POST /api/2fa/generate`, got HTTP 200 with the QR — and
   * then returned at `if (!liveRef.current) return;`. No error, no toast, no
   * console message. The dialog closed and the screen did not move, which is
   * exactly how "the authenticator setup is broken" was reported and why it could
   * not be reproduced against the API.
   *
   * Development-only, which is worse rather than better: broken in the only
   * environment anybody tests in, fine in the one nobody can easily check.
   *
   * Rendered inside `<StrictMode>` deliberately — a plain render passes with the
   * cleanup-only version, so this is the one shape that catches it.
   */
  it('still renders the QR after the double-mount', async () => {
    mockServer();
    mockChallenges();

    render(
      <StrictMode>
        <TwoFactorSetup
          currentUser={{ id: 'u1', email: 'admin@school.org', role: 'admin' }}
          addToast={vi.fn()}
          onSetupComplete={vi.fn()}
        />
      </StrictMode>
    );

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await answerPassword();

    /* The QR, the typed-key fallback and the confirmation field: everything the
       user needs, none of which appeared while the ref was stuck false. */
    await waitFor(() => expect(screen.getByAltText(/QR code/i)).toBeTruthy());
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    expect(screen.getByLabelText(/six-digit code/i)).toBeTruthy();
  });

  it('still reports the status it fetched on mount', async () => {
    /* `fetchStatus` writes through the same guard, so a stuck ref also left the
       card claiming every method was off however the account was really set up —
       including hiding the "Turn off" control from somebody who had 2FA on. */
    mockServer({
      status: {
        enabled: true,
        methods: { totp: true, email: false },
        recoveryCodesRemaining: 7,
        roleRequires2FA: false
      }
    });
    mockChallenges();

    render(
      <StrictMode>
        <TwoFactorSetup
          currentUser={{ id: 'u1', email: 'admin@school.org', role: 'admin' }}
          addToast={vi.fn()}
          onSetupComplete={vi.fn()}
        />
      </StrictMode>
    );

    await waitFor(() => expect(screen.getByText('7 left')).toBeTruthy());
    expect(screen.getByRole('button', { name: /turn off/i })).toBeTruthy();
  });
});

/* ── The password step ──────────────────────────────────────────────────── */

describe('the password step during authenticator enrolment', () => {
  /**
   * The reported defect, stated as a count.
   *
   * `2fa.generate` and `2fa.enable` are two gated actions, and each handler used
   * to call `run(...)` on its own — so the password was asked for twice, and the
   * second time landed AFTER the six-digit code had been typed. One prompt, at
   * the start, is the whole fix.
   */
  it('asks once, before the code is entered, for the whole enrolment', async () => {
    const calls = mockServer();
    mockChallenges();
    setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));

    await answerPassword();
    await screen.findByLabelText(/six-digit code/i);

    // One dialog, and it is gone once answered.
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.change(screen.getByLabelText(/six-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /turn on authenticator app/i }));

    await screen.findByText(/save these recovery codes/i);

    // No second dialog appeared at any point in the flow.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.grantReauthByPassword).toHaveBeenCalledTimes(2);

    // Neither request was ever sent without a grant, so neither was refused and
    // re-sent — that round trip is what used to trigger the second prompt.
    const gated = calls.filter(c => c.url === '/api/2fa/generate' || c.url === '/api/2fa/enable');
    expect(gated).toHaveLength(2);
    for (const call of gated) {
      expect(call.headers[REAUTH_CHALLENGE_HEADER], `${call.url} went out unverified`).toBeTruthy();
    }
  });

  it('grants both actions from the one password entry, each with its own challenge', async () => {
    mockServer();
    mockChallenges();
    setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await answerPassword('correct horse');

    await screen.findByLabelText(/six-digit code/i);

    expect(api.openReauthChallenge.mock.calls.map(c => c[0]))
      .toEqual(['2fa.generate', '2fa.enable']);
    expect(api.grantReauthByPassword.mock.calls).toEqual([
      ['reauth-2fa.generate', 'correct horse'],
      ['reauth-2fa.enable', 'correct horse']
    ]);
  });

  it('explains why the password is being asked for', async () => {
    mockServer();
    mockChallenges();
    setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/set up two-factor authentication/i);
    expect(dialog.textContent).toMatch(/we need your password/i);
  });

  /**
   * The rendering defect underneath the report.
   *
   * `.modal-overlay` is `position: fixed; inset: 0`, and the wall this dialog
   * opens on renders it inside `.auth` — which carries a fill-forwards animation
   * whose final keyframe is a transform, making it a containing block for fixed
   * descendants. The overlay then sized itself to `.auth` rather than the
   * viewport and centred the dialog below the fold, with body scrolling already
   * locked. `.modal-overlay-stacked` cannot fix that: a z-index does not escape
   * a containing block, and index.css documents the portal as that class's
   * precondition.
   *
   * jsdom performs no layout, so the assertion is structural: nothing in the
   * page can be an ancestor of the overlay.
   */
  it('renders outside the component tree, so no ancestor can trap the overlay', async () => {
    mockServer();
    mockChallenges();
    const { container } = setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await screen.findByRole('dialog');

    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.parentElement, 'the overlay must be portalled to document.body').toBe(document.body);
    expect(container.querySelector('.modal-overlay'), 'still inside the card').toBeNull();
  });

  /**
   * The Escape assertion is SYNCHRONOUS, and that is the point.
   *
   * It was `await waitFor(() => expect(queryByRole('dialog')).toBeNull())`, and
   * it failed roughly one full-suite run in two — never on its own (0/25), never
   * in the client project alone (3/3), only with all 289 files in flight.
   *
   * `waitFor` spends a 1000ms WALL-CLOCK budget, and under that much parallel
   * load its polling can be starved past the deadline. But nothing here is
   * asynchronous: `useModal`'s keydown handler calls `onClose` directly,
   * `settle` calls `setPrompt(null)`, and `fireEvent` is act-wrapped, so React
   * has flushed the unmount before the next line runs. A timeout was therefore
   * never evidence about the component — only about how busy the machine was.
   *
   * Asserting synchronously removes the clock from the test and makes it
   * STRICTER: a dialog that closes a tick late now fails immediately instead of
   * being waited into passing. That is the opposite of raising a timeout, which
   * would have hidden a real defect in the same place.
   */
  it('moves focus into the dialog and closes on Escape', async () => {
    mockServer();
    mockChallenges();
    setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));

    const field = await screen.findByLabelText(/your password/i);
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/* ── Retrying a wrong code ──────────────────────────────────────────────── */

describe('a code the server does not accept', () => {
  /**
   * The grant survives a wrong code — `spendChallenge` runs inside the handler's
   * transaction and the "Invalid token" throw rolls it back — so the only thing
   * the user should have to do is read the next code from their app.
   */
  it('shows an inline error and lets the user retry without verifying again', async () => {
    let attempts = 0;
    mockServer({
      enable: () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('Invalid token');
          err.status = 400;
          err.data = { error: 'Invalid token' };
          throw err;
        }
        return { success: true, recoveryCodes: CODES };
      }
    });
    mockChallenges();
    setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await answerPassword();

    const field = await screen.findByLabelText(/six-digit code/i);
    fireEvent.change(field, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: /turn on authenticator app/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/30 seconds/i);
    expect(field.getAttribute('aria-invalid')).toBe('true');

    // Still on the QR step, no dialog, nothing to redo but the six digits.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByAltText(/QR code/i)).toBeTruthy();

    fireEvent.change(field, { target: { value: '222222' } });
    fireEvent.click(screen.getByRole('button', { name: /turn on authenticator app/i }));

    await screen.findByText(/save these recovery codes/i);
    expect(api.grantReauthByPassword, 'the password must not be asked for again')
      .toHaveBeenCalledTimes(2);
  });

  it('refuses a code that is not six digits without contacting the server', async () => {
    const calls = mockServer();
    mockChallenges();
    setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await answerPassword();

    const field = await screen.findByLabelText(/six-digit code/i);
    fireEvent.change(field, { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: /turn on authenticator app/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/six digits/i);
    expect(calls.filter(c => c.url === '/api/2fa/enable')).toHaveLength(0);
  });
});

/* ── Cancelling ─────────────────────────────────────────────────────────── */

describe('cancelling', () => {
  it('leaves the menu intact and says nothing, when the dialog is dismissed', async () => {
    const calls = mockServer();
    mockChallenges();
    const { addToast, onSetupComplete } = setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: /use authenticator app/i })).toBeTruthy();

    // Declining is an outcome, not a failure.
    expect(addToast).not.toHaveBeenCalled();
    expect(onSetupComplete).not.toHaveBeenCalled();
    expect(calls.filter(c => c.url === '/api/2fa/generate')).toHaveLength(0);
  });

  it('returns to the menu from the QR step, and can start again', async () => {
    mockServer();
    mockChallenges();
    const { addToast } = setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await answerPassword();
    await screen.findByLabelText(/six-digit code/i);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(await screen.findByRole('button', { name: /use authenticator app/i })).toBeTruthy();
    expect(addToast).not.toHaveBeenCalled();

    // Starting again verifies again, which is correct: the first pair of grants
    // was abandoned, and a grant is bound to one action and spent once.
    fireEvent.click(screen.getByRole('button', { name: /use authenticator app/i }));
    await screen.findByRole('dialog');
  });
});

/* ── Recovery codes ─────────────────────────────────────────────────────── */

describe('recovery codes', () => {
  /**
   * The bug that cost the most.
   *
   * `onSetupComplete` is `refresh`; on the 2FA wall a refresh clears
   * `tfaRequired` and `App.jsx` swaps the wall for the application shell, which
   * unmounts this component. Calling it as soon as enrolment succeeded meant the
   * ten codes — bcrypt-hashed server-side, shown once, and the only way back into
   * an account whose phone is lost — were on screen for a single frame.
   */
  it('are shown, and do not report completion until they are acknowledged', async () => {
    mockServer();
    mockChallenges();
    const { onSetupComplete } = setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await answerPassword();
    fireEvent.change(await screen.findByLabelText(/six-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /turn on authenticator app/i }));

    await screen.findByText(/save these recovery codes/i);
    for (const c of CODES) expect(screen.getByText(c)).toBeTruthy();

    expect(onSetupComplete, 'the screen showing the codes must not be torn down yet')
      .not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /i have saved these codes/i }));
    expect(onSetupComplete).toHaveBeenCalledTimes(1);
  });

  it('says the previous set is dead, because enabling TOTP replaces it', async () => {
    mockServer();
    mockChallenges();
    setup();

    fireEvent.click(await screen.findByRole('button', { name: /use authenticator app/i }));
    await answerPassword();
    fireEvent.change(await screen.findByLabelText(/six-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /turn on authenticator app/i }));

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/no longer work/i);
  });

  /**
   * Regression: the action name was wrong, so this could never succeed.
   *
   * `/api/2fa/recovery-codes/regenerate` was gated on `2fa.enable`; the client
   * declared `2fa.generate`. `withStepUp` throws when the refusal names a
   * different action than the caller did — deliberately, because a challenge for
   * the wrong action produces a grant the endpoint will not accept — so every
   * attempt put a developer-facing sentence about mismatched actions into a
   * toast.
   *
   * The action it agrees on is now `2fa.recovery.regenerate` rather than
   * `2fa.enable`, and that is a security fix rather than a rename: sharing
   * `2fa.enable` made ONE grant cover both enrolling a factor and destroying
   * the recovery code set, and enrolment deliberately holds an unspent
   * `2fa.enable` grant for minutes while a QR code is scanned. The assertion
   * below is what stops the two being merged again for tidiness.
   */
  it('regenerating verifies the action the endpoint actually gates', async () => {
    mockServer({ status: { ...STATUS_OFF, enabled: true, methods: { totp: true, email: false }, recoveryCodesRemaining: 10 } });
    mockChallenges();
    const { addToast } = setup();

    fireEvent.click(await screen.findByRole('button', { name: /create new recovery codes/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create new codes/i }));

    await answerPassword();

    await screen.findByText(/save these recovery codes/i);
    expect(api.openReauthChallenge).toHaveBeenCalledWith('2fa.recovery.regenerate', {});
    expect(api.openReauthChallenge).not.toHaveBeenCalledWith('2fa.enable', {});
    expect(addToast).not.toHaveBeenCalled();
  });
});

/* ── Not offering what the server will refuse ───────────────────────────── */

describe('an account whose role requires a second factor', () => {
  /**
   * Both disable routes answer `role_requires_2fa`. Offering the control anyway
   * spends a verification on a request that cannot succeed — the rule
   * ENGINEERING_GUIDE states for the server, applied where the offer is made.
   */
  it('is not offered a way to turn it off', async () => {
    mockServer({
      status: {
        enabled: true,
        methods: { totp: true, email: true },
        recoveryCodesRemaining: 8,
        roleRequires2FA: true
      }
    });
    mockChallenges();
    setup();

    await screen.findByText(/your role requires two-factor authentication/i);
    expect(screen.queryByRole('button', { name: /turn off two-factor/i })).toBeNull();
  });

  it('may still turn it off when the policy does not apply, password before code', async () => {
    const calls = mockServer({
      status: {
        enabled: true,
        methods: { totp: true, email: false },
        recoveryCodesRemaining: 8,
        roleRequires2FA: false
      }
    });
    mockChallenges();
    const { addToast } = setup();

    fireEvent.click(await screen.findByRole('button', { name: /turn off/i }));

    /**
     * Password first, code second.
     *
     * The old handler prompted for a code with `window.prompt` and then hit the
     * step-up, so the code aged by however long the password took — the same
     * stale-code defect as enrolment, on a route that ALSO clears email 2FA and
     * deletes every recovery code.
     */
    await answerPassword();

    const field = await screen.findByLabelText(/code from your authenticator app/i);
    fireEvent.change(field, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /turn off two-factor authentication/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringMatching(/turned off/i), 'info'
    ));

    const disableCall = calls.find(c => c.url === '/api/2fa/disable');
    expect(disableCall.headers[REAUTH_CHALLENGE_HEADER]).toBe('reauth-2fa.disable');
    expect(JSON.parse(disableCall.options.body)).toEqual({ token: '654321' });
    expect(api.grantReauthByPassword).toHaveBeenCalledTimes(1);
  });
});
