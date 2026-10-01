import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, LogIn, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../utils/api';
import { useSession } from '../session/SessionProvider';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { usePageMeta } from '../hooks/usePageMeta';

/**
 * Redeeming an administrator invitation.
 *
 * ── The incident this page closes ──
 *
 * `sendAdminInvitationEmail` has always pointed at
 * `${APP_URL}/accept-invitation?token=…`, and `/accept-invitation` was not a
 * declared route in any of the three tables. So every administrator invitation
 * this platform has ever sent ended on the unknown-URL takeover: "Page not
 * found", in the one email whose entire purpose is to hand somebody authority
 * over a service used by children.
 *
 * Nothing else in the chain was broken, which is what made it survive. The
 * inviter's half is complete — `PendingInvitations` creates, lists and revokes,
 * and `POST /api/admin/invitations` hashes the token and mails it. The
 * redeeming half is complete — `POST /api/auth/accept-invitation` checks the
 * address, the verification, the expiry and the single-use flag, promotes and
 * audits in one transaction, and answers every failure identically so it cannot
 * be used to discover whether an invitation exists. Only the screen between
 * them was missing, and no test could see the gap: `internalLinks.test.js`
 * scans `src/` for `href=`/`to=` attributes, and this link is a template
 * literal built in `server/email.js`.
 *
 * ── Why acceptance is a button and not an effect ──
 *
 * The obvious implementation is to POST on mount: the reader clicked a link
 * that says "accept", so the intent looks established. It is not. The email
 * says "nothing happens unless you accept", and this is a promotion to a role
 * that can read safety reports about minors and suspend accounts — a
 * single-use, seven-day token that a mail client's link prefetcher, a
 * corporate URL scanner or a shared-tab back button could otherwise burn
 * without a person ever deciding anything. The page states what the role can
 * do, then waits.
 *
 * ── Why there is nothing to show about the invitation itself ──
 *
 * No panel names the inviter, the reason or the expiry, and that is deliberate
 * rather than unfinished. There is no endpoint that describes an invitation,
 * because a preview endpoint is a probe: it would answer "yes, a live
 * invitation exists for this token" to anybody holding a guess, which is the
 * exact distinction `INVITE_REJECTED` exists to refuse. The token is opaque
 * here, as it is everywhere else on the client.
 *
 * ── Why a signed-out reader is asked to open the link again ──
 *
 * The endpoint needs a session, so somebody arriving with none has to sign in
 * first — and after signing in they land on the dashboard, away from the token.
 * The tempting fix is a `?returnTo=` parameter. `utils/pendingInvite.js` argues
 * against exactly that and its argument holds here: a general redirect
 * primitive means maintaining a path validator for ever and getting it right
 * every time, and this flow does not need one. The email already instructs
 * "sign in with THIS email address and open the link below", the link is
 * sitting in the reader's mailbox, and re-opening it costs one click. A page
 * that spends an open-redirect surface to save that click is a bad trade.
 *
 * ── Standalone, in PUBLIC_ROUTES ──
 *
 * Declared public because the reader's session state is unknown when they
 * arrive: an invitation goes to an address, not to a logged-in browser. It
 * therefore renders outside the shell and owns its own `h1`, which is why it is
 * in the `STANDALONE` allowlist in `headingLevels.test.js`.
 */
export default function AcceptInvitation() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const { currentUser, isCheckingSession, signOut } = useSession();

  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState('');

  useDocumentTitle('Administrator invitation');

  /* Carries a person: kept out of search indexes (FE-02). */
  usePageMeta({ noindex: true });

  /**
   * Focus lands on the heading whenever the page changes what it is saying.
   *
   * Accepting replaces the whole panel without a navigation, so a screen reader
   * would otherwise be left on a button that no longer exists and announce
   * nothing about the outcome. `outcome` and `error` are in the dependency list
   * for that reason: each one is a new page as far as the reader is concerned.
   */
  const headingRef = useRef(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [outcome, error, isCheckingSession, currentUser?.id]);

  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.acceptAdminInvitation(token);
      setOutcome(res);
    } catch (err) {
      /**
       * One message, whatever happened.
       *
       * The endpoint deliberately collapses "no such token", "expired",
       * "already used", "revoked" and "belongs to somebody else" into a single
       * `INVITE_REJECTED`, and it sends its own sentence. Re-deriving a friendlier
       * one per status here would rebuild the distinction the server spent effort
       * removing — and it is the server's copy that is kept in step with the
       * rule. A 500 is the one case worth separating: that is our fault, not a
       * verdict on the invitation.
       */
      setError(
        err.status === 500
          ? 'Something went wrong on our end. Try the link again in a moment.'
          : err.message || 'That invitation link is not valid.'
      );
    } finally {
      setBusy(false);
    }
  };

  if (isCheckingSession) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered" role="status" aria-live="polite">
          <p className="auth-subtitle">Checking your invitation…</p>
        </main>
      </div>
    );
  }

  /* No token at all: somebody opened `/accept-invitation` bare, or a mail client
     truncated the link. Answered with the same sentence a bad token gets, for
     the same reason — the page must not become a way to tell the two apart. */
  if (!token) {
    return (
      /**
       * `data-error-kind="404"` — for the accessibility sweep, not for styling.
       *
       * `a11y/harness/routes.mjs` derives its route list from the route table,
       * so this page is swept automatically. But `concreteFor` substitutes only
       * `:param` SEGMENTS, and what this page needs is a QUERY STRING — so the
       * sweep visits `/accept-invitation` bare, lands on this panel, and would
       * report it as coverage of the acceptance screen. That is the exact
       * failure `/verify/:code` was fixed for: worse than skipping a route,
       * because it produces numbers that look like coverage.
       *
       * `walk.mjs` treats a `data-error-kind` of `404` as "the path or its
       * fixture did not resolve, so what was measured is not the page this
       * route names" and reports the route UNMEASURED. Which is the truth here:
       * without a token this is not the acceptance screen. The marker is the
       * same one `CertificateView` uses, for the same reason.
       *
       * The honest fix is query-string fixtures in the harness, so the decision
       * branch is measured rather than merely admitted to be unmeasured. That
       * is harness work and is written up as a remaining gap.
       */
      <div className="auth" data-error-kind="404">
        <main className="auth-form auth-form-narrow auth-centered stack-md">
          <span className="auth-icon auth-icon-danger"><ShieldAlert size={24} /></span>
          <h1 className="auth-title" tabIndex={-1} ref={headingRef}>
            This invitation link is incomplete
          </h1>
          <p className="auth-subtitle">
            Open the link from your invitation email directly, rather than typing the address —
            the part after the question mark is what identifies the invitation.
          </p>
          <Link className="btn btn-secondary" to="/login">Go to sign in</Link>
        </main>
      </div>
    );
  }

  /**
   * Accepted. The session in this tab is already dead.
   *
   * `accept-invitation` bumps `token_version`, which is what the JWT carries, so
   * the cookie this page just used stopped being valid the moment the promotion
   * committed — that is the endpoint's own design, to force a clean session for
   * the new authority rather than leave one minted before it. The reader is
   * signed out explicitly rather than left to discover it on their next click,
   * which would present a deliberate re-authentication as the account breaking
   * seconds after being promoted.
   */
  if (outcome?.accepted) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered stack-md">
          <span className="auth-icon"><CheckCircle2 size={24} /></span>
          <h1 className="auth-title" tabIndex={-1} ref={headingRef}>
            You are now a WeVolunteer administrator
          </h1>
          {/**
            * The server's `message` is deliberately NOT rendered here.
            *
            * It reads "You are now a WeVolunteer administrator. Sign in again to
            * pick up your new access." — which is correct for an API consumer
            * and, under the heading, printed the heading's own sentence back a
            * second time. Measured in the browser: the panel said "You are now
            * a WeVolunteer administrator" twice, once as the `h1` and once
            * beneath it.
            *
            * So the heading keeps the outcome and this line keeps the only part
            * that is not already on screen — what to do next. The endpoint's
            * wording is still the source for the `role` it confirms; nothing is
            * being second-guessed, only de-duplicated.
            */}
          <p className="auth-subtitle">
            Sign in again to pick up your new access.
          </p>
          <div className="alert alert-warn">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>
              <span className="alert-title">Why you have to sign in again.</span>
              {' '}Your new access is carried by a fresh sign-in. The one you were using was
              issued before this account had any administrative permissions, so it has been
              retired on purpose.
            </span>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { signOut(); }}
          >
            Sign in again
          </button>
        </main>
      </div>
    );
  }

  /* Signed out. See the header: the token stays in the mailbox rather than in a
     redirect parameter. */
  if (!currentUser) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered stack-md">
          <span className="auth-icon"><LogIn size={24} /></span>
          <h1 className="auth-title" tabIndex={-1} ref={headingRef}>
            Sign in to accept this invitation
          </h1>
          <p className="auth-subtitle">
            An invitation belongs to one email address. Sign in with the address the
            invitation was sent to, then open the link from that email again.
          </p>
          <Link className="btn btn-primary" to="/login">Sign in</Link>
          <p className="auth-hint">
            No account on that address yet? <Link to="/signup">Create one</Link>, confirm the
            address, then open the invitation link again.
          </p>
        </main>
      </div>
    );
  }

  /* Signed in, not yet accepted: the decision. */
  return (
    <div className="auth">
      <main className="auth-form auth-form-narrow auth-centered stack-md">
        <span className="auth-icon"><ShieldCheck size={24} /></span>
        <h1 className="auth-title" tabIndex={-1} ref={headingRef}>
          You have been invited to help moderate WeVolunteer
        </h1>
        <p className="auth-subtitle">
          Accepting makes this account — {currentUser.email} — a platform administrator.
        </p>

        {/* The same facts the email leads with, because this is the screen where
            the decision is actually taken and the email may have been read days
            ago on a different device. */}
        <div className="alert alert-warn">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>
            <span className="alert-title">What an administrator can do.</span>
            {' '}Read the safety reports people file, including reports about children;
            warn and suspend accounts; and review appeals. It is a position of trust on a
            platform used mostly by under-18s, and every action you take is recorded
            against your name in the audit trail.
          </span>
        </div>

        {error && (
          <div className="alert alert-danger" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>
              <span className="alert-title">This invitation was not accepted.</span>
              {' '}{error}
            </span>
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary"
          onClick={accept}
          disabled={busy}
        >
          {busy ? 'Accepting…' : 'Accept and become an administrator'}
        </button>
        <p className="auth-hint">
          Not expecting this? Close this page — nothing happens unless you accept. You can
          also <Link to="/report-issue?category=account">tell us about it</Link>.
        </p>
      </main>
    </div>
  );
}
