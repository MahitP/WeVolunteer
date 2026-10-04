import React, { useState } from 'react';
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
 * ── Why there is no countdown on the password field ──
 *
 * There used to be: "This verification expires in 4:58", ticking, with the field
 * and button disabled the moment it reached zero. A grant genuinely does expire
 * five minutes after it is opened, so the number was true — and it was still the
 * wrong thing to show.
 *
 * A five-minute deadline on ENTERING A PASSWORD is a deadline on going to find
 * one. People keep passwords in a manager, in another tab, in another room, on a
 * piece of paper; the ones who take longest are the ones who did not reuse
 * something memorable. Timing that is pure hostility, and it reads as a scam
 * prompt on top of it: an unexplained password box with a countdown is the exact
 * pattern people are taught to distrust. It was reported as such during 2FA
 * enrolment.
 *
 * The deadline is a property of the GRANT, not of the person's typing, so it is
 * handled where it belongs — invisibly. `onReopen` gets a fresh challenge for the
 * same action and arguments, and this dialog uses it in two places: before
 * submitting against a challenge whose time has passed, and once in response to a
 * server refusal that says the challenge is expired, consumed or gone. Nothing
 * about the security model changes: each challenge is still opened server-side,
 * bound to one action, one set of params and one session, verified against the
 * real password hash, and spent once. The user just does not have to race it.
 *
 * A timer still belongs on a SHORT-LIVED CODE — an emailed six digits, a TOTP
 * window — because there the deadline is on the credential itself and the person
 * cannot go and fetch a fresh one without being told to. Those live in
 * `Login.jsx` and `TwoFactorSetup.jsx`, not here.
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


/** Whether a challenge's five minutes have already run out. */
function isStale(expiresAt) {
  const at = new Date(expiresAt).getTime();
  return Number.isFinite(at) && at <= Date.now();
}

/**
 * The refusals that mean "that particular challenge is no longer usable" — as
 * opposed to "your password is wrong", which a new challenge would not fix.
 *
 * Reopening on `not_found` as well as `expired` is deliberate: the sweep removes
 * expired rows an hour later, so a dialog left open long enough sees the row
 * vanish rather than expire, and both are the same situation to the person in
 * front of it.
 */
const REOPENABLE = new Set(['expired', 'consumed', 'not_found', 'missing_challenge']);

export default function VerifyIdentityModal({
  challenge: initialChallenge,
  alsoGrant = [],
  onGranted,
  onCancel,
  onReopen
}) {
  /**
   * The challenge is state, not a prop read directly.
   *
   * Reopening replaces it in place, so the dialog stays up and the user never
   * learns that the thing behind their password prompt was swapped. `alsoGrant`
   * is deliberately NOT reopened: those are extras, and `useStepUp`'s caller
   * already falls back to an ordinary step-up for any that do not come back.
   */
  const [challenge, setChallenge] = useState(initialChallenge);
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

  const methods = challenge.methods ?? [];
  const canPassword = methods.includes('password');
  const canOAuth = methods.includes('oauth');

  /**
   * A live challenge to submit against, reopening first if this one has gone.
   *
   * Returns the id, or null when there is nothing to reopen with — an
   * `onReopen`-less caller, or a reopen that itself failed. Callers treat null as
   * "use what we have and let the server say", because a stale id producing an
   * honest refusal beats a dialog that refuses to submit anything.
   */
  const freshChallengeId = async () => {
    if (!isStale(challenge.expiresAt) || typeof onReopen !== 'function') {
      return challenge.challengeId;
    }
    try {
      const reopened = await onReopen();
      if (!reopened?.challengeId) return challenge.challengeId;
      setChallenge(reopened);
      setAttemptsRemaining(reopened.attemptsRemaining ?? null);
      return reopened.challengeId;
    } catch {
      return challenge.challengeId;
    }
  };

  /* ── The password leg ───────────────────────────────────────────────── */
  const submitPassword = async (e) => {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      let challengeId = await freshChallengeId();

      /**
       * One transparent retry, and exactly one.
       *
       * A grant can die between the last render and this request — five minutes
       * is five minutes, and the clock does not stop while the password manager
       * opens. Reopening once and resubmitting the SAME password turns that into
       * a slightly slower success instead of an error message about a deadline
       * the user was never shown. A second failure is reported: at that point
       * something other than the clock is wrong.
       */
      try {
        await api.grantReauthByPassword(challengeId, password);
      } catch (err) {
        const code = err?.data?.code;
        if (!REOPENABLE.has(code) || typeof onReopen !== 'function') throw err;

        const reopened = await onReopen();
        if (!reopened?.challengeId) throw err;
        setChallenge(reopened);
        setAttemptsRemaining(reopened.attemptsRemaining ?? null);
        challengeId = reopened.challengeId;
        await api.grantReauthByPassword(challengeId, password);
      }


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

      /* `challengeId`, not `challenge.challengeId`: after a reopen the granted
         challenge is not the one this dialog was handed, and spending the
         original would be refused as `not_found`. */
      onGranted(challengeId, extras);
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
  /**
   * The provider leg.
   *
   * ── Why this holds `busy` and catches, when it is about to navigate away ──
   *
   * It used to do neither, on the assumption that `window.location.assign` ends
   * the story. Two things happen before that line, and both can fail or stall:
   * `freshChallengeId()` is a network round trip, and `savePendingReauth` writes
   * to storage — which throws outright in Safari's private mode, where
   * `setItem` is not available.
   *
   * With no `busy` the button stayed live through the round trip, so a second
   * press opened a second challenge; and with no `catch`, a throw left the
   * dialog exactly as it was, with no error, no navigation and no explanation.
   * The user is left pressing a button that visibly does nothing — which is the
   * shape of "it got stuck" even though nothing is technically frozen.
   *
   * `busy` is deliberately NOT cleared on success: the page is navigating, and
   * re-enabling the button during that window is an invitation to press it
   * again.
   */
  const startOAuth = async (provider) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      /**
       * A fresh challenge first if this one has run out.
       *
       * The provider round trip is the longest leg in the flow — a consent
       * screen, possibly a sign-in, possibly a second factor at the provider —
       * so leaving with a challenge that has minutes left is how somebody comes
       * back to `expired` having done everything right. Reopening costs one
       * request and is bound to the same action and arguments.
       */
      const challengeId = await freshChallengeId();

      savePendingReauth({
        provider,
        challengeId,
        action: challenge.action,
        expiresAt: challenge.expiresAt,
        returnTo: `${window.location.pathname}${window.location.search}`
      });
      window.location.assign(api.reauthOAuthUrl(provider, challengeId));
    } catch (err) {
      setBusy(false);
      setError(
        err?.message
        || 'We could not start that sign-in. Try your password instead, or try again.'
      );
    }
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
  /**
   * The reason has to be true of every action, not of most of them.
   *
   * It used to say "Because that changes how you sign in", which is true of the
   * credential actions this dialog was first written for — password, email,
   * provider, second factor — and false of the eight that have joined since.
   * Exporting your data does not change how you sign in; neither does reading a
   * report's evidence, promoting an administrator, or publishing a new version
   * of the Terms of Service, where the sentence read as a non sequitur attached
   * to a password prompt. A stated reason that does not match what the user just
   * clicked is worse than no reason: it is the exact texture of a phishing
   * prompt, which is the reaction this sentence exists to prevent.
   *
   * What IS true of all sixteen is the thing step-up actually checks — that the
   * person at the keyboard is the account holder, and not somebody who found the
   * session already signed in.
   */
  const because = challenge.label
    ? `You asked to ${challenge.label}. Because that is something only you should `
      + 'be able to do, we need your password once more before it takes effect.'
    : 'This is something only you should be able to do, so we need your password '
      + 'once more before it takes effect.';

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

        {/*
          Reassurance, not a deadline.

          This line used to be the countdown. What the reader actually needs to
          know here is that the password is not going anywhere — the prompt looks
          like a phishing box precisely because nothing on it says who is asking
          or what happens to the answer.
        */}
        <p className="lead row" style={{ gap: 'var(--s2)' }}>
          <ShieldCheck size={16} aria-hidden="true" />
          Your password is checked against this account and is not stored or sent
          anywhere else.
        </p>

        {nothingToOffer && (
          /**
           * The account can prove nothing: no password, no linked provider.
           * That is a recovery problem rather than a verification problem, and
           * the only honest answer is who to ask. Rendering an empty dialog
           * would be worse than an error.
           */
          <div className="alert alert-danger" role="alert">
            This account has no way to verify your identity. Tell us through{' '}
            <a href="/report-issue">Report a problem</a> and we will help you get back in.
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
                disabled={busy}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !password}>
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
            disabled={busy}
            showUnavailable={false}
            labelFor={label => `Verify with ${label}`}
          />
        )}
      </div>

      {/**
        * Cancel is never disabled.
        *
        * It was `disabled={busy}`, which produced the one failure a verification
        * dialog must not have: a user who picked the provider option — the
        * longest leg, and the one that leaves the page — pressed Cancel and got
        * nothing back. The dialog was not frozen, and `Modal`'s own `onClose`
        * (Escape, and the X in the header) was never gated, so the way out
        * existed and the control that names it was the one control that refused.
        * Somebody who trusts the button rather than guessing at Escape concludes
        * the screen is stuck.
        *
        * There is nothing to protect here either. Cancelling spends nothing and
        * writes nothing — the challenge is simply left unused and expires on its
        * own. Blocking the exit bought no safety and cost the only obvious way
        * out.
        */}
      <div className="modal-foot">
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </Modal>,
    document.body
  );
}
