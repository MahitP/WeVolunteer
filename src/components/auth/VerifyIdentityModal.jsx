import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
 *
 * ── Why it is portalled to document.body ──
 *
 * This dialog opens from wherever the sensitive action lives, and two of those
 * places put it inside an ancestor that establishes a containing block for
 * `position: fixed`:
 *
 *   • `DeleteAccountModal` renders it INSIDE its own `.modal-overlay`, which
 *     sets `backdrop-filter: blur(8px)`.
 *   • `TwoFactorRequiredWall` renders it inside `.auth`, which carries
 *     `animation: authFadeIn … forwards` — a fill-forwards animation whose last
 *     keyframe is `transform: translateY(0)`, so the computed transform stays
 *     non-`none` for the life of the screen.
 *
 * Either one stops `.modal-overlay`'s `inset: 0` from meaning "the viewport"
 * and makes it mean "that ancestor's box". `.auth` is `min-height: 100dvh` and
 * grows with its content, so on the 2FA wall the overlay covered a box taller
 * than the screen and centred the dialog somewhere below the fold — while
 * `useModal` had already locked body scrolling, so there was no way to reach
 * it. The password step looked blank, dimmed and stuck, which is exactly how it
 * was reported.
 *
 * `.modal-overlay-stacked` was already on the overlay below, and that class's
 * own docstring in index.css states the portal as its precondition: it sets a
 * z-index, and a z-index cannot lift an element out of an ancestor's containing
 * block. The class was applied here without the portal it depends on, so it
 * only ever changed the backdrop's opacity. `EventModal`'s ConflictDialog is
 * the same pattern done correctly and is what this now matches.
 *
 * ── Why one password entry can answer more than one challenge ──
 *
 * `alsoGrant` lists further OPEN challenges to grant with the same answer. It
 * exists for an operation the server splits into two gated actions that the
 * person performing it experiences as one: enrolling an authenticator is
 * `2fa.generate` (produce the QR) followed by `2fa.enable` (confirm the first
 * code), and prompting twice meant the second prompt landed AFTER a 30-second
 * TOTP code had been typed — so the code went stale while the user looked up
 * their password, and enrolment failed on a correct code.
 *
 * Nothing about the security model is relaxed by it. Each challenge is opened
 * separately, bound to its own action, params and session, verified server-side
 * against the account's real password hash, and spent once inside the handler
 * that does the work. What is shared is the user's single deliberate answer to
 * a single question about a single operation — not a grant.
 *
 * An extra that cannot be granted is not fatal: it is left out of the result
 * and the caller falls back to an ordinary step-up for that action, which is
 * also what happens on the provider leg (a redirect can only come back to one
 * challenge).
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

export default function VerifyIdentityModal({ challenge, alsoGrant = [], onGranted, onCancel }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  /**
   * Seeded from the challenge, not from zero.
   *
   * The server reports the ACCOUNT's remaining guesses when it opens a
   * challenge, and starting at `null` here would discard that: a dialog reopened
   * after a page refresh would say nothing about a budget that is already spent,
   * and the user would learn it only by spending another try. `?? null` keeps the
   * old behaviour for any caller that hands over a challenge without the field.
   */
  const [attemptsRemaining, setAttemptsRemaining] = useState(
    challenge.attemptsRemaining ?? null
  );
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

      /**
       * The extras, after the primary has succeeded and never before it.
       *
       * A wrong password must cost exactly one failed attempt, not one per
       * challenge in the list — `reauthLimiter` allows five failures per
       * fifteen minutes, so answering the extras first would spend the budget
       * at two or three times the honest rate. It skips SUCCESSFUL requests, so
       * granting several with a correct password costs nothing.
       *
       * A refusal here is swallowed: the primary grant is real, the user has
       * proved who they are, and the caller's fallback is an ordinary step-up
       * for whichever action did not come back. Failing the whole dialog
       * because a secondary challenge had expired would throw away a
       * verification that was just earned.
       */
      const extras = {};
      for (const extra of alsoGrant) {
        try {
          await api.grantReauthByPassword(extra.challengeId, password);
          extras[extra.action] = extra.challengeId;
        } catch {
          /* Left out of `extras`; the caller verifies again if it needs to. */
        }
      }

      onGranted(challenge.challengeId, extras);
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

  /**
   * Why the prompt is here at all, in the words of the thing being done.
   *
   * "Verify your identity" on its own reads as an unexplained password wall,
   * and an unexplained password wall in the middle of a flow the user started
   * is indistinguishable from a phishing prompt — which is exactly the reaction
   * it drew when it appeared during 2FA enrolment. The label comes from the
   * action registry, so the sentence always names the operation the grant will
   * be spent on rather than a generic one.
   */
  const because = challenge.label
    ? `You asked to ${challenge.label}. Because that changes how you sign in, `
      + 'we need your password once more before it takes effect.'
    : 'This action changes your account security, so we need your password once '
      + 'more before it takes effect.';

  return createPortal(
    <Modal onClose={onCancel} label="Verify your identity" overlayClassName="modal-overlay-stacked">
      <ModalHead
        title="Verify your identity"
        description={challenge.label
          ? `Before we ${challenge.label.toLowerCase()}, please confirm it's you.`
          : "Please confirm it's you before continuing."}
        onClose={onCancel}
      />

      <div className="modal-body stack-md">
        <p className="lead" id="reauth-why">{because}</p>

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

        {/*
          * A budget already spent, said before another try is wasted on it.
          *
          * Only when there is no `error` — after a failed attempt the message
          * above already explains what happened, and two red boxes saying the
          * same thing is worse than one. This is the refresh case: a new dialog,
          * nothing typed yet, and no guesses left to type it with.
          */}
        {!error && attemptsRemaining === 0 && (
          <div className="alert alert-danger" role="alert">
            Too many incorrect attempts. Please wait a few minutes before trying
            to verify again.
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
                /* Focus starts in the field rather than on "Close". `useModal`
                   also moves focus into the dialog, but it filters candidates by
                   `offsetParent !== null` — which is always null in jsdom, so
                   that path is untestable and unverifiable here. This one is
                   both, and in a browser the two agree. */
                autoFocus
                aria-describedby="reauth-why"
                aria-invalid={error ? 'true' : undefined}
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
    </Modal>,
    document.body
  );
}
