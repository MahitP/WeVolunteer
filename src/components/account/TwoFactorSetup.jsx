import React, { useState, useEffect, useRef } from 'react';
import { Shield, Mail, Key, FileDown, ImageDown } from 'lucide-react';
import { api } from '../../utils/api';
import ConfirmDialog from '../common/ConfirmDialog';
import { useStepUp } from '../auth/useStepUp';
import { STEP_UP, REAUTH_CHALLENGE_HEADER, reauthHeader } from '../../utils/stepUp';
import { downloadRecoveryCodesTxt, downloadRecoveryCodesPng } from '../../utils/recoveryCodeExport';

/**
 * Turning two-factor authentication on and off.
 *
 * Rendered in two places that look the same and are not: Settings → Security,
 * where it is one card among several, and `TwoFactorRequiredWall`, where it is
 * the ONLY thing an administrator can interact with until they enrol. The wall
 * is the path most users take, because `REQUIRE_ADMIN_2FA` defaults on.
 *
 * ── The enrolment flow, and why it is shaped like this ──
 *
 * The server splits authenticator enrolment across two gated actions:
 * `POST /api/2fa/generate` (produce the secret and QR) behind
 * `requireAAL2('2fa.generate')`, and `POST /api/2fa/enable` (confirm the first
 * code) behind `requireAAL2('2fa.enable')`. Both gates are correct and stay:
 * adding a second factor is a credential change, and a stolen session must not
 * be enough to plant one.
 *
 * What was wrong was the ORDER the client asked in. Each handler called
 * `run(action, …)`, which attempts the request, is refused, and only then puts
 * the verification dialog up. For `2fa.enable` that meant the password prompt
 * appeared AFTER the user had typed a six-digit code that is valid for thirty
 * seconds. By the time they had found their password the code was stale, the
 * server answered "Invalid token" for a code that had been correct, and the
 * retry opened a brand-new challenge — so every attempt cost another password
 * entry. That is the "asks for my password, then gets stuck" this was reported
 * as.
 *
 * So enrolment now verifies ONCE, up front, for both actions
 * (`verifyOnceFor`), and holds the `2fa.enable` grant while the user scans the
 * QR code and types the first code. Two consequences are load-bearing:
 *
 *   1. The code is entered and submitted within one TOTP window.
 *   2. A wrong code does NOT cost a verification. `spendChallenge` runs as the
 *      first statement inside the handler's transaction and `verifyTotp` throws
 *      after it, so the rollback un-spends the grant — the same grant is still
 *      good for the next attempt. `grantHeaders` re-presents it, so the user
 *      retypes six digits and nothing else.
 *
 * If the held grant has expired after all, the request is refused with
 * `reauth_required`, `run` puts the dialog up in the ordinary way, and the flow
 * completes. Degrading to the old number of prompts is fine; starting there was
 * not.
 *
 * ── Why the recovery codes gate `onSetupComplete` ──
 *
 * `onSetupComplete` is `refresh` from the session provider. On the wall, a
 * refresh clears `currentUser.tfaRequired`, and `App.jsx` then renders the
 * application shell instead of the wall — which unmounts this component. It used
 * to be called immediately after `setRecoveryCodes(...)`, so the ten codes
 * appeared for one frame and then the whole screen was replaced. They are stored
 * bcrypt-hashed and are the only way back into an account whose authenticator is
 * lost, so those users were dropped into the app holding nothing.
 *
 * It is therefore called from the acknowledgement button and nowhere else. The
 * wall staying up for one more click is the point of the click.
 */

/** A blank status, so the first render never reads `methods` off undefined. */
const EMPTY_STATUS = {
  methods: { totp: false, email: false },
  /* Empty rather than absent, so `.includes` on the first render is safe. */
  availableMethods: [],
  recoveryCodesRemaining: 0,
  roleRequires2FA: false
};

/**
 * The verification header for one request: whatever the step-up helper handed
 * us, or the grant we are already holding.
 *
 * `run` calls its `attempt` with `{}` first and with a real header only after a
 * refusal. Substituting the held grant on that first call is what makes the
 * common path a single request with no prompt, while leaving `run`'s retry in
 * charge if the held grant turns out to be dead. Checking for the header by name
 * rather than for a non-empty object keeps it honest if `attempt` is ever given
 * other headers to carry.
 */
function grantHeaders(supplied, held) {
  if (supplied && Object.prototype.hasOwnProperty.call(supplied, REAUTH_CHALLENGE_HEADER)) {
    return supplied;
  }
  return reauthHeader(held);
}

const SIX_DIGITS = /^\d{6}$/;

export default function TwoFactorSetup({ currentUser, addToast, onSetupComplete }) {
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);

  /** The enrolment in progress: `{ qr, secret, enableGrant }`, or null. */
  const [enrol, setEnrol] = useState(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(null);

  /** Turning the authenticator off: `{ grant, code, error }`, or null. */
  const [disable, setDisable] = useState(null);

  /**
   * Codes the user has been shown and not yet acknowledged.
   *
   * `{ codes, replacedPrevious, complete }` — `complete` is true when
   * acknowledging should also report the setup as finished, which is what keeps
   * the unmount described above until after the click.
   */
  const [recovery, setRecovery] = useState(null);

  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  /**
   * Only asked when turning email off will NOT stop email working.
   *
   * Since v1.3.1 a confirmed address is accepted as a second factor once the
   * account holds any factor at all, so for an account that also has an
   * authenticator, `tfa_email_enabled = 0` demotes email from the default and
   * changes nothing the sign-in step reads. The button still said "Turn off".
   * The card explains the situation accurately once the state has changed — but
   * that is after the press, and a security control has to be honest before it.
   */
  const [confirmDisableEmail, setConfirmDisableEmail] = useState(false);

  const { run, verifyOnceFor, modal } = useStepUp();

  /**
   * Live so an in-flight request cannot write to an unmounted component.
   *
   * Every one of these flows ends in `fetchStatus()`, and the wall unmounts as
   * soon as the session refresh lands — so the last `setStatus` of a successful
   * enrolment can easily arrive after this component has gone.
   */
  const liveRef = useRef(true);
  /**
   * Set to true on MOUNT, not only false on unmount.
   *
   * ── The bug this fixes ──
   *
   * It was `useEffect(() => () => { liveRef.current = false; }, [])` — cleanup
   * only. A ref survives a remount, and React StrictMode (which `main.jsx` wraps
   * the whole application in) deliberately mounts, unmounts and remounts every
   * component once in development. So the cleanup ran, wrote `false`, and nothing
   * ever wrote `true` again: `liveRef.current` was false for the entire life of
   * the component.
   *
   * Every state write in this file is guarded by it. The consequence was that
   * authenticator enrolment was silently dead in development — pressing "Use
   * authenticator app" asked for the password, verified it, called
   * `POST /api/2fa/generate`, received the QR code with HTTP 200, and then
   * returned at `if (!liveRef.current) return;` without rendering anything. No
   * error, no toast, no console message; the dialog just closed and the screen
   * did not move. That is exactly how "the authenticator setup is broken" was
   * reported, and why it could not be reproduced against the API, which was
   * answering correctly the whole time.
   *
   * It is a development-only symptom — StrictMode does not double-invoke in a
   * production build — which is worse rather than better: the flow was broken in
   * the only environment anybody was testing it in, and looked fine in the one
   * nobody could easily check.
   */
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  const fetchStatus = async () => {
    try {
      const data = await api.apiFetch('/api/2fa/status');
      if (!liveRef.current) return;
      // Merged rather than assigned: a response missing `methods` would
      // otherwise crash every branch below on the next render.
      setStatus({ ...EMPTY_STATUS, ...data, methods: { ...EMPTY_STATUS.methods, ...data?.methods } });
    } catch {
      addToast('Could not load your two-factor settings.', 'error');
    }
  };

  useEffect(() => { fetchStatus(); }, []);

  /* ── Authenticator app ──────────────────────────────────────────────────── */

  const startAuthenticator = async () => {
    if (busy) return;
    setBusy(true);
    setCodeError(null);
    try {
      /**
       * `2fa.generate` first, so its label ("set up two-factor authentication")
       * is the sentence the dialog shows — it describes the whole operation,
       * where `2fa.enable`'s describes only the second half.
       */
      const grants = await verifyOnceFor([
        { action: STEP_UP.GENERATE_2FA },
        { action: STEP_UP.ENABLE_2FA }
      ]);
      if (!grants) return; // dismissed; not an error, and not a toast

      const data = await run(STEP_UP.GENERATE_2FA, {}, headers =>
        api.apiFetch('/api/2fa/generate', {
          method: 'POST',
          headers: grantHeaders(headers, grants[STEP_UP.GENERATE_2FA])
        }));
      if (data === undefined) return; // dismissed at the fallback prompt

      if (!liveRef.current) return;
      setEnrol({
        qr: data.qr,
        secret: data.secret,
        enableGrant: grants[STEP_UP.ENABLE_2FA] ?? null
      });
      setCode('');
    } catch (err) {
      addToast(err.message || 'Could not start authenticator setup.', 'error');
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  const confirmAuthenticator = async (e) => {
    e.preventDefault();
    if (busy || !enrol) return;

    const entered = code.trim();
    if (!SIX_DIGITS.test(entered)) {
      setCodeError('Enter the six digits your authenticator app is showing right now.');
      return;
    }

    setBusy(true);
    setCodeError(null);
    try {
      const data = await run(STEP_UP.ENABLE_2FA, {}, headers =>
        api.apiFetch('/api/2fa/enable', {
          method: 'POST',
          headers: grantHeaders(headers, enrol.enableGrant),
          body: JSON.stringify({ token: entered })
        }));
      if (data === undefined) return; // dismissed at the fallback prompt

      if (!liveRef.current) return;
      setEnrol(null);
      setCode('');
      await fetchStatus();
      addToast('Authenticator app turned on.', 'success');

      if (data.recoveryCodes?.length) {
        setRecovery({ codes: data.recoveryCodes, replacedPrevious: true, complete: true });
      } else if (onSetupComplete) {
        // No codes to show, so nothing to keep this screen up for.
        onSetupComplete();
      }
    } catch (err) {
      /**
       * Inline, next to the field, and the dialog is NOT reopened.
       *
       * A wrong code is the ordinary mistake here and the grant survives it, so
       * the only thing the user has to do is read the next code from their app.
       * A toast would have scrolled away by then.
       */
      setCodeError(err.message === 'Invalid token'
        ? 'That code was not accepted. Codes change every 30 seconds — enter the one showing now.'
        : (err.message || 'Could not turn on the authenticator app.'));
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  const cancelEnrolment = () => {
    /**
     * Nothing to undo server-side, deliberately.
     *
     * `/api/2fa/generate` stores the pending secret but leaves `tfa_enabled` at
     * 0, so an abandoned enrolment is inert: no code is ever demanded against
     * that secret, and starting again simply overwrites it. Dropping the held
     * `2fa.enable` grant is enough — it expires on its own five minutes later
     * and is bound to one action from one session, so it authorises nothing in
     * the meantime.
     */
    setEnrol(null);
    setCode('');
    setCodeError(null);
  };

  const startDisableAuthenticator = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const grants = await verifyOnceFor([{ action: STEP_UP.DISABLE_2FA }]);
      if (!grants) return;
      if (!liveRef.current) return;
      // The password comes BEFORE the code for the same reason it does in
      // enrolment: a code typed first would be stale by the time it was sent.
      setDisable({ grant: grants[STEP_UP.DISABLE_2FA], code: '', error: null });
    } catch (err) {
      addToast(err.message || 'Could not start turning off the authenticator app.', 'error');
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  const confirmDisableAuthenticator = async (e) => {
    e.preventDefault();
    if (busy || !disable) return;

    const entered = disable.code.trim();
    if (!SIX_DIGITS.test(entered)) {
      setDisable(d => ({ ...d, error: 'Enter the six digits your authenticator app is showing right now.' }));
      return;
    }

    setBusy(true);
    setDisable(d => ({ ...d, error: null }));
    try {
      const data = await run(STEP_UP.DISABLE_2FA, {}, headers =>
        api.apiFetch('/api/2fa/disable', {
          method: 'POST',
          headers: grantHeaders(headers, disable.grant),
          body: JSON.stringify({ token: entered })
        }));
      if (data === undefined) return;

      if (!liveRef.current) return;
      setDisable(null);
      await fetchStatus();
      addToast('Two-factor authentication turned off.', 'info');
    } catch (err) {
      setDisable(d => (d ? { ...d, error: err.message || 'Could not turn off the authenticator app.' } : d));
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  /* ── Email codes ────────────────────────────────────────────────────────── */

  const enableEmail = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const data = await run(STEP_UP.ENABLE_2FA, {}, headers =>
        api.apiFetch('/api/2fa/email/enable', { method: 'POST', headers }));
      if (data === undefined) return;

      if (!liveRef.current) return;
      await fetchStatus();
      addToast('Email codes turned on.', 'success');

      if (data.recoveryCodes?.length) {
        // Email enrolment ADDS to nothing: the server issues codes only when the
        // account had none, so this set replaces no earlier one.
        setRecovery({ codes: data.recoveryCodes, replacedPrevious: false, complete: true });
      } else if (onSetupComplete) {
        onSetupComplete();
      }
    } catch (err) {
      addToast(err.message || 'Could not turn on email codes.', 'error');
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  const disableEmail = async () => {
    setConfirmDisableEmail(false);
    if (busy) return;
    setBusy(true);
    try {
      const data = await run(STEP_UP.DISABLE_2FA, {}, headers =>
        api.apiFetch('/api/2fa/email/disable', { method: 'POST', headers }));
      if (data === undefined) return;

      if (!liveRef.current) return;
      await fetchStatus();
      /* Deliberately not "turned off" when a factor remains: an emailed code
         still signs this account in, and a toast saying otherwise is the lie
         the confirmation below exists to prevent. */
      addToast(
        totp ? 'Email codes are no longer your default.' : 'Email codes turned off.',
        'info'
      );
    } catch (err) {
      addToast(err.message || 'Could not turn off email codes.', 'error');
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  /* ── Recovery codes ─────────────────────────────────────────────────────── */

  const regenerateRecoveryCodes = async () => {
    setConfirmRegenerate(false);
    if (busy) return;
    setBusy(true);
    try {
      /**
       * `2fa.recovery.regenerate` — this operation's own action.
       *
       * It was `2fa.generate` once, which could not work at all: `withStepUp`
       * compares the action it was given against the one the refusal names and
       * throws when they disagree, so every attempt put a developer-facing
       * sentence about mismatched actions into a toast. The repair pointed it
       * at `2fa.enable`, which the route was gated on.
       *
       * That worked and was still wrong, because it meant one grant covered
       * both enrolling a factor and DESTROYING the recovery code set — and
       * enrolment deliberately holds an unspent `2fa.enable` grant in state for
       * minutes while the user scans a QR code. The action registry now names
       * this operation separately, so the sentence the user reads in the dialog
       * is the thing their answer authorises.
       */
      const data = await run(STEP_UP.REGENERATE_RECOVERY_CODES, {}, headers =>
        api.apiFetch('/api/2fa/recovery-codes/regenerate', { method: 'POST', headers }));
      if (data === undefined) return;

      if (!liveRef.current) return;
      await fetchStatus();
      setRecovery({ codes: data.recoveryCodes, replacedPrevious: true, complete: false });
    } catch (err) {
      addToast(err.message || 'Could not create new recovery codes.', 'error');
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  const acknowledgeRecoveryCodes = () => {
    const shouldComplete = recovery?.complete;
    setRecovery(null);
    // Last, because on the 2FA wall this unmounts everything above.
    if (shouldComplete && onSetupComplete) onSetupComplete();
  };

  /* ── Render ─────────────────────────────────────────────────────────────── */

  const { totp, email } = status.methods;
  /* What the sign-in step will actually accept, as opposed to what was switched
     on. See the note beside the Email codes card below. */
  const emailAccepted = (status.availableMethods || []).includes('email');
  const locked = status.roleRequires2FA;

  return (
    <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
      {modal}

      <h3 style={{ marginBottom: 'var(--s2)' }}>Two-factor authentication</h3>
      <p className="dim small" style={{ marginBottom: 'var(--s4)' }}>
        A second step when you sign in, so a stolen password is not enough on its own.
        Changing it asks for your password first — that is what stops someone who has
        borrowed your signed-in browser from quietly adding or removing a factor.
      </p>

      {recovery ? (
        <div className="stack-md">
          <div className="alert alert-warn" role="alert">
            <strong>Save these recovery codes now.</strong>{' '}
            They are the only way back into your account if you lose your authenticator,
            and this is the only time they are shown.
            {recovery.replacedPrevious && (
              <> Any recovery codes you were given earlier <strong>no longer work</strong> — throw them away.</>
            )}
          </div>

          <ul
            className="card card-body grid grid-2"
            style={{ background: 'var(--surface-2)', fontFamily: 'monospace', listStyle: 'none' }}
            aria-label="Recovery codes"
          >
            {recovery.codes.map(c => <li key={c}>{c}</li>)}
          </ul>

          {/**
            * Two ways to save, because neither suits everybody. The text file is
            * the one that pastes into a password manager; the image goes to a
            * camera roll, which is where a student on a phone will actually find
            * it again. Both are generated entirely in the browser from state
            * already on screen — no request, and no code ever in a URL.
            */}
          <div className="row row-wrap recovery-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                try {
                  downloadRecoveryCodesTxt(recovery.codes);
                  addToast('Recovery codes saved as a text file.', 'success');
                } catch {
                  addToast('Could not save the file. Copy the codes down instead.', 'error');
                }
              }}
            >
              <FileDown size={15} aria-hidden="true" /> Save as .txt
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                try {
                  await downloadRecoveryCodesPng(recovery.codes);
                  addToast('Recovery codes saved as an image.', 'success');
                } catch (err) {
                  addToast(err.message || 'Could not save the image. Copy the codes down instead.', 'error');
                }
              }}
            >
              <ImageDown size={15} aria-hidden="true" /> Save as .png
            </button>
          </div>

          <div>
            <button className="btn btn-primary" onClick={acknowledgeRecoveryCodes}>
              I have saved these codes
            </button>
          </div>
        </div>
      ) : enrol ? (
        <form onSubmit={confirmAuthenticator} className="stack-md">
          <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s6)', flexWrap: 'wrap' }}>
            {/* `white`, not a token: a QR code needs a light quiet zone to be
                readable, and in dark mode every surface token is dark. This is
                the one place in the app where the colour is a function of the
                thing rather than of the theme. */}
            <div style={{ background: 'white', padding: 8, borderRadius: 8 }}>
              <img
                src={enrol.qr}
                alt={`QR code enrolling ${currentUser?.email || 'your account'} in an authenticator app`}
                width={150}
                height={150}
              />
            </div>

            <div className="stack-sm" style={{ flex: 1, minWidth: '14rem' }}>
              <span className="strong">1. Scan this with your authenticator app</span>
              <span className="dim small">
                Google Authenticator, Authy, 1Password and Microsoft Authenticator all work.
                Cannot scan it? Type this key in instead:
              </span>
              <code className="small" style={{ wordBreak: 'break-all' }}>{enrol.secret}</code>

              <div className="field" style={{ marginTop: 'var(--s2)' }}>
                <label htmlFor="tfa-enrol-code">2. Enter the six-digit code it shows</label>
                <input
                  id="tfa-enrol-code"
                  className="input"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  aria-invalid={codeError ? 'true' : undefined}
                  aria-describedby={codeError ? 'tfa-enrol-code-error' : undefined}
                  autoFocus
                />
              </div>

              {codeError && (
                <div className="alert alert-danger" role="alert" id="tfa-enrol-code-error">
                  {codeError}
                </div>
              )}

              <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? 'Checking…' : 'Turn on authenticator app'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={cancelEnrolment} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </form>
      ) : disable ? (
        <form onSubmit={confirmDisableAuthenticator} className="stack-sm">
          <div className="alert alert-warn" role="alert">
            Turning the authenticator app off also turns off email codes and deletes
            your recovery codes. Your password alone will be enough to sign in.
          </div>

          <div className="field">
            <label htmlFor="tfa-disable-code">Confirm with a code from your authenticator app</label>
            <input
              id="tfa-disable-code"
              className="input"
              value={disable.code}
              onChange={e => setDisable(d => ({ ...d, code: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              aria-invalid={disable.error ? 'true' : undefined}
              aria-describedby={disable.error ? 'tfa-disable-code-error' : undefined}
              autoFocus
            />
          </div>

          {disable.error && (
            <div className="alert alert-danger" role="alert" id="tfa-disable-code-error">
              {disable.error}
            </div>
          )}

          <div className="row" style={{ gap: 'var(--s2)' }}>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? 'Checking…' : 'Turn off two-factor authentication'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setDisable(null)} disabled={busy}>
              Keep it on
            </button>
          </div>
        </form>
      ) : (
        <div className="stack-md">
          <div style={{ paddingBottom: 'var(--s4)', borderBottom: '1px solid var(--border)' }}>
            <div className="row" style={{ marginBottom: 'var(--s2)' }}>
              <Shield size={18} aria-hidden="true" />
              <span className="strong">Authenticator app</span>
              {totp ? <span className="tag tag-ok">On</span> : null}
            </div>
            <p className="dim small" style={{ marginBottom: 'var(--s3)' }}>
              Codes from an app on your phone. Works with no signal and is the stronger
              of the two options.
            </p>
            {totp ? (
              locked ? (
                <p className="dim small">
                  Your role requires two-factor authentication, so this cannot be turned off.
                </p>
              ) : (
                <button className="btn btn-danger" onClick={startDisableAuthenticator} disabled={busy}>
                  Turn off
                </button>
              )
            ) : (
              <button className="btn btn-secondary" onClick={startAuthenticator} disabled={busy}>
                Use authenticator app
              </button>
            )}
          </div>

          <div style={{ paddingBottom: 'var(--s4)', borderBottom: '1px solid var(--border)' }}>
            <div className="row" style={{ marginBottom: 'var(--s2)' }}>
              <Mail size={18} aria-hidden="true" />
              <span className="strong">Email codes</span>
              {email ? <span className="tag tag-ok">On</span>
                : emailAccepted ? <span className="tag tag-info">Available</span> : null}
            </div>
            <p className="dim small" style={{ marginBottom: 'var(--s3)' }}>
              A code sent to your confirmed address. Weaker than an authenticator app —
              anyone who reaches your mailbox reaches your codes.
            </p>
            {/**
              * The honest statement of what sign-in will accept.
              *
              * Since v1.3.1 a confirmed address is accepted as a second factor
              * once the account has any factor at all — so for an authenticator
              * account this card used to show no "On" tag and offer "Use email
              * codes" while a mailed code would already have signed them in. The
              * status endpoint now returns `availableMethods`, the same
              * derivation the login route enforces, and this says so plainly
              * rather than letting somebody believe they had declined it.
              */}
            {!email && emailAccepted && (
              <p className="dim small" style={{ marginBottom: 'var(--s3)' }}>
                Your address is confirmed, so you can already choose <strong>Email code</strong>
                {' '}when you sign in — it is your way back in if you lose your authenticator.
                Turning it on below only makes it your default.
              </p>
            )}
            {email ? (
              locked && !totp ? (
                <p className="dim small">
                  Your role requires two-factor authentication, and this is your only
                  factor — set up an authenticator app first.
                </p>
              ) : (
                <button
                  className="btn btn-danger"
                  onClick={() => (totp ? setConfirmDisableEmail(true) : disableEmail())}
                  disabled={busy}
                >
                  {totp ? 'Stop using by default' : 'Turn off'}
                </button>
              )
            ) : (
              <button className="btn btn-secondary" onClick={enableEmail} disabled={busy}>
                Use email codes
              </button>
            )}
          </div>

          {(totp || email) && (
            <div>
              <div className="row" style={{ marginBottom: 'var(--s2)' }}>
                <Key size={18} aria-hidden="true" />
                <span className="strong">Recovery codes</span>
                <span className="dim small">{status.recoveryCodesRemaining} left</span>
              </div>
              <p className="dim small" style={{ marginBottom: 'var(--s3)' }}>
                Single-use codes for getting in if you lose your phone.
              </p>
              <button className="btn btn-secondary" onClick={() => setConfirmRegenerate(true)} disabled={busy}>
                Create new recovery codes
              </button>
            </div>
          )}
        </div>
      )}

      {confirmDisableEmail && (
        <ConfirmDialog
          title="Email codes will still work"
          confirmLabel="Stop using by default"
          busy={busy}
          onConfirm={disableEmail}
          onCancel={() => setConfirmDisableEmail(false)}
        >
          <p>
            Your email address is confirmed, so a mailed code can still sign you in —
            that is deliberate, and it is how you get back in if you lose your
            authenticator.
          </p>
          <p>
            This only stops email being the method offered first. To have a factor
            your mailbox cannot reach, use your recovery codes.
          </p>
        </ConfirmDialog>
      )}

      {confirmRegenerate && (
        <ConfirmDialog
          title="Replace your recovery codes?"
          confirmLabel="Create new codes"
          destructive
          busy={busy}
          onConfirm={regenerateRecoveryCodes}
          onCancel={() => setConfirmRegenerate(false)}
        >
          <p>
            The {status.recoveryCodesRemaining} codes you have now will stop working
            immediately. You will be shown the new set once.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
