import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import ProviderButtons from './ProviderButtons';
import { api } from '../../utils/api';
import { savePendingReauth } from '../../utils/stepUp';

/**
 * "Verify your identity" — the one dialog every sensitive action goes through.
 *
 * ── What it is for ──
 *
 * Five actions (deleting the account, changing the password, changing the email
 * address, connecting a sign-in provider, exporting all your data) cannot be
 * performed on the strength of a session alone. This is where the account holder
 * re-proves who they are. It does not decide anything: it turns an open challenge
 * into a granted one and hands the id back, and the server re-checks every
 * binding when the grant is spent.
 *
 * ── Why it renders only the methods the server sent ──
 *
 * `methods` comes from the challenge and is already narrowed to what THIS account
 * can actually satisfy — an account with no password never sees a password field,
 * an account with no linked provider is never sent to one. Deciding that here
 * would mean the client holding a second opinion about the account's credentials,
 * and the failure mode is a prompt the user cannot answer: a provider-only
 * account being asked, five times, for a password it does not have, and then
 * locked out of the challenge.
 *
 * An empty `methods` is refused by the server before a challenge is returned, so
 * this component's caller never receives one. It still handles the case, because
 * a modal with no controls and a five-minute countdown is the worst possible
 * thing to render if that ever changes.
 *
 * ── Why the countdown is real ──
 *
 * A grant expires five minutes after it is opened, and the failure it prevents is
 * someone typing a password into a dialog that has already died. The countdown
 * comes from `expiresAt` on the challenge rather than from a local timer started
 * at mount, so a tab that was backgrounded shows the truth rather than five
 * minutes from whenever it woke up.
 *
 * ── Where the provider leg comes back to ──
 *
 * Not here. A provider's redirect URI is fixed per deployment, so re-consent
 * returns to `/oauth/callback` exactly as an ordinary sign-in does — this dialog,
 * and the page under it, are long gone by then. `OAuthCallback` recognises a
 * pending re-verification, grants it, and sends the user back to where they
 * started; `stepUp.js` carries the record across in `sessionStorage`.
 *
 * An earlier draft resumed the flow in this component, reading `code` and
 * `state` off `window.location`. It could never have run: this component is
 * never mounted on the URL those parameters arrive at.
 */


function secondsLeft(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.round(ms / 1000));
}

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function VerifyIdentityModal({ challenge, onGranted, onCancel }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState(null);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(() => secondsLeft(challenge.expiresAt));

  const methods = challenge.methods ?? [];
  const canPassword = methods.includes('password');
  const canOAuth = methods.includes('oauth');
  const expired = remaining === 0;

  /* ── The countdown ──────────────────────────────────────────────────── */
  useEffect(() => {
    // Recomputed from `expiresAt` on every tick rather than decremented, so a
    // throttled background tab cannot drift into showing time that has gone.
    const tick = () => setRemaining(secondsLeft(challenge.expiresAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [challenge.expiresAt]);

  /* ── The password leg ───────────────────────────────────────────────── */
  const submitPassword = async (e) => {
    e.preventDefault();
    if (busy || expired) return;

    setBusy(true);
    setError(null);
    try {
      await api.grantReauthByPassword(challenge.challengeId, password);
      onGranted(challenge.challengeId);
    } catch (err) {
      /**
       * A wrong password leaves the dialog open.
       *
       * Closing it would throw away a challenge that still has attempts left and
       * make the user start again, and `attemptsRemaining` is the whole reason
       * the server reports it — someone who has two tries left needs to know
       * before they spend them.
       */
      setError(err?.data?.error || err?.message || 'That verification did not work.');
      setAttemptsRemaining(err?.data?.attemptsRemaining ?? null);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  /* ── The provider leg ───────────────────────────────────────────────── */
  /**
   * Everything the return journey needs, written down before we leave.
   *
   * After the redirect there is nothing in memory to say which challenge the
   * callback belongs to, which action it was for, or where the user was when they
   * asked. `returnTo` is captured from the live location rather than hardcoded to
   * `/settings`, so a verification started from anywhere comes back to the same
   * place — including the `?section=` the settings screen uses to pick a panel.
   */
  const startOAuth = (provider) => {
    savePendingReauth({
      provider,
      challengeId: challenge.challengeId,
      action: challenge.action,
      expiresAt: challenge.expiresAt,
      returnTo: `${window.location.pathname}${window.location.search}`
    });
    window.location.assign(api.reauthOAuthUrl(provider, challenge.challengeId));
  };

  const nothingToOffer = methods.length === 0;

  return (
    <Modal onClose={onCancel} label="Verify your identity" overlayClassName="modal-overlay-stacked">
      <ModalHead
        title="Verify your identity"
        description={challenge.label
          ? `Before we ${challenge.label.toLowerCase()}, please confirm it's you.`
          : "Please confirm it's you before continuing."}
        onClose={onCancel}
      />

      <div className="modal-body stack-md">
        <p className="lead row" style={{ gap: 'var(--s2)' }}>
          <ShieldCheck size={16} aria-hidden="true" />
          {expired
            ? 'This verification has timed out. Close this and try again.'
            : <>This verification expires in <strong>{formatCountdown(remaining)}</strong>.</>}
        </p>

        {nothingToOffer && (
          /**
           * The account can prove nothing: no password, no linked provider.
           * That is a recovery problem rather than a verification problem, and
           * the only honest answer is who to ask. Rendering an empty dialog
           * with a countdown would be worse than an error.
           */
          <div className="alert alert-danger" role="alert">
            This account has no way to verify your identity. Please contact your
            school administrator.
          </div>
        )}

        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
            {attemptsRemaining !== null && attemptsRemaining > 0 && (
              <> You have {attemptsRemaining} {attemptsRemaining === 1 ? 'try' : 'tries'} left.</>
            )}
          </div>
        )}

        {canPassword && (
          <form onSubmit={submitPassword} className="stack-sm">
            <div className="field">
              <label htmlFor="reauth-password">Your password</label>
              <input
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={busy || expired}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || expired || !password}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </form>
        )}

        {canPassword && canOAuth && <p className="lead">Or verify with your sign-in provider:</p>}

        {canOAuth && (
          /**
           * `showUnavailable={false}` — this row is not a sign-in choice.
           *
           * The server has already told us the account HAS a linked provider, so
           * an unconfigured one is not an option the user could take; offering a
           * greyed-out "coming soon" button in a dialog that is blocking an
           * action they asked for is noise at the worst moment.
           */
          <ProviderButtons
            onSelect={startOAuth}
            disabled={busy || expired}
            showUnavailable={false}
            labelFor={label => `Verify with ${label}`}
          />
        )}
      </div>

      <div className="modal-foot">
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </Modal>
  );
}
