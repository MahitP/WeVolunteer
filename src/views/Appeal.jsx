/**
 * The appeal form — the only screen a suspended student can reach.
 *
 * Three things on this page used to be untrue, and each was read by a locked-out
 * minor at the moment they were deciding whether the process was worth engaging
 * with at all:
 *
 *   - "Appeals are reviewed by a different moderator than the one who took the
 *     original action." Nothing enforced it. PR-3C does enforce it now, but not
 *     absolutely — a super administrator may override a non-personal conflict on
 *     the record — so the copy below says what the published Community
 *     Guidelines say rather than promising more than the code delivers.
 *   - "We will contact you via email once a decision has been reached." Nothing
 *     sent anything. It is now true, which is why the sentence stays.
 *   - "Period: Indefinite", hardcoded regardless of the facts. Removed; the
 *     schema models no duration, so the page no longer invents one.
 *
 * The page also used ~8 class names with no CSS rule behind them (`center-all`,
 * `panel`, `limit-width`, `text-secondary`, `spinner`, …), so it rendered as
 * unstyled stacked text. It now uses the `auth-*` vocabulary that ResetPassword
 * already uses — the other signed-out, token-addressed page in this product.
 */
import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, ShieldOff, CheckCircle2 } from 'lucide-react';
import { api } from '../utils/api';
import BrandMark from '../components/common/BrandMark';

const SUPPORT_EMAIL = 'wevolunteer.platform@gmail.com';
const MIN_STATEMENT = 20;

const formatDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
};

export default function Appeal() {
  const { token } = useParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  const [statement, setStatement] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submitted, setSubmitted] = useState(false);

  // Focus moves to the heading whenever the page changes meaning. Without it a
  // screen-reader user hears nothing at the exact moments this page swaps its
  // entire tree — loading to form, form to sent.
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, [loading, submitted, error]);

  useEffect(() => {
    let cancelled = false;
    api.fetchAppealByToken(token)
      .then((data) => { if (!cancelled) { setInfo(data); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [token]);

  const trimmed = statement.trim();
  const longEnough = trimmed.length >= MIN_STATEMENT;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!longEnough) {
      setSubmitError('Tell us a little more — even one sentence about what happened helps.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.submitAppealByToken(token, trimmed);
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err.message || 'We could not send that. Please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered" role="status" aria-live="polite">
          <BrandMark />
          <p className="auth-subtitle">Loading your appeal form…</p>
        </main>
      </div>
    );
  }

  /**
   * The dead-end screen, and the only one that matters when it fires.
   *
   * A student here cannot sign in, cannot reset a password into an account that
   * refuses sessions, and previously got the words "Link Invalid" over a raw
   * server string with nowhere to go. The server deliberately answers the same
   * 404 for unknown, expired and spent, so this copy covers all three without
   * letting the reader test which applies.
   */
  if (error) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered stack-md">
          <BrandMark />
          <span className="auth-icon auth-icon-danger"><ShieldOff size={24} /></span>
          <h1 className="auth-title" tabIndex={-1} ref={headingRef}>
            This link does not work any more
          </h1>
          <p className="auth-subtitle">
            Appeal links stop working after 30 days, and they only work once. If you already sent
            an appeal, we have it — you do not need to send another.
          </p>
          <div className="alert alert-warn">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>
              <span className="alert-title">You can still appeal by email.</span>
              {' '}Write to <strong>{SUPPORT_EMAIL}</strong> from the email address on your
              WeVolunteer account and tell us what happened. It reaches the same people, and we
              reply within 5 school days.
            </span>
          </div>
          <p className="auth-hint">
            If you are not sure which email your account uses, send it anyway and include your
            full name and your school.
          </p>
        </main>
      </div>
    );
  }

  const alreadyFiled = info?.alreadyFiled;
  const decided = info?.appeal?.decision;

  // Either they just sent it, or they are coming back to a link they already used.
  if (submitted || alreadyFiled) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered stack-md">
          <BrandMark />
          <span className="auth-icon"><CheckCircle2 size={24} /></span>
          <h1 className="auth-title" tabIndex={-1} ref={headingRef}>
            {decided ? 'We have looked at your appeal' : 'We have got it'}
          </h1>

          {decided ? (
            <>
              <p className="auth-subtitle">
                {info.appeal.decision === 'reversed'
                  ? 'We got this wrong, and we have put it right. Your account works again — you can sign in now.'
                  : 'We read what you wrote, and we are keeping the suspension in place.'}
              </p>
              <div className="alert alert-warn">
                <AlertTriangle size={18} aria-hidden="true" />
                <span>
                  <span className="alert-title">Why we decided that</span>
                  {' '}{info.appeal.reasoning}
                  {info.appeal.reviewerName && <> — reviewed by {info.appeal.reviewerName}.</>}
                </span>
              </div>
              {info.appeal.decision === 'stands' && (
                <p className="auth-hint">
                  If you think this is still wrong, email <strong>{SUPPORT_EMAIL}</strong> from the
                  address on your account.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="auth-subtitle">
                Thanks for writing that. An administrator will read it and reply to the email
                address on your account within 5 school days. We will tell you what we decided,
                why, and who reviewed it.
              </p>
              <p className="auth-hint">
                You still cannot sign in while we look at this. Your hours and certificates are
                safe. There is nothing else to do — you do not need to send it again.
              </p>
            </>
          )}
        </main>
      </div>
    );
  }

  const deadline = formatDate(info?.expiresAt);
  const suspendedOn = formatDate(info?.suspendedAt);

  return (
    <div className="auth">
      <main className="auth-form auth-form-narrow stack-md">
        <div className="auth-head">
          <BrandMark />
          <h1 className="auth-title" tabIndex={-1} ref={headingRef}>Ask us to look at this again</h1>
          <p className="auth-subtitle">
            Your WeVolunteer account is suspended, so you cannot sign in right now. If you think we
            got this wrong, or there is something we did not know, tell us here.
          </p>
        </div>

        <div className="alert alert-warn">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>
            <span className="alert-title">Why your account was suspended</span>
            {' '}
            {/* No invented fallback: a reason is mandatory server-side, so its
                absence means something is wrong and should say so rather than
                fabricate a charge against the student. */}
            {info?.suspensionReason || 'No reason was recorded. Please email us — that is a mistake on our side.'}
            {suspendedOn && <> This was decided on {suspendedOn}.</>}
            {' '}Your hours, your attendance and your certificates are safe. Nothing has been deleted.
          </span>
        </div>

        <form onSubmit={handleSubmit} className="stack-md" noValidate>
          {submitError && (
            <div className="alert alert-danger" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="appeal-statement"><strong>What happened</strong></label>
            <p className="field-hint" id="appeal-statement-help">
              Write it however you want. It helps if you say what you think happened in your own
              words, and anything we might not have known. You do not have to say you did not do
              it — if you did and you want to explain, that is a real appeal and we read those the
              same way.
            </p>
            <textarea
              id="appeal-statement"
              className="textarea"
              rows={7}
              value={statement}
              aria-describedby="appeal-statement-help appeal-statement-status"
              onChange={(e) => { setStatement(e.target.value); if (submitError) setSubmitError(null); }}
              placeholder="Start anywhere — you can just tell us what you remember."
              maxLength={5000}
            />
            {/* Announced, not colour-coded, and it names the rule the button is
                actually enforcing instead of counting toward a 5000 ceiling the
                student is nowhere near. */}
            <span className="field-hint" id="appeal-statement-status" role="status" aria-live="polite">
              {!longEnough && trimmed.length > 0 && 'A bit more, so we know what to look into.'}
              {trimmed.length > 4500 && `${trimmed.length} of 5000 characters.`}
            </span>
          </div>

          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send my appeal'}
          </button>
        </form>

        <p className="auth-footer">
          {deadline && <>You have until <strong>{deadline}</strong> to send this. </>}
          This link is just for you — please do not forward it. If it stops working, email{' '}
          <strong>{SUPPORT_EMAIL}</strong> from the address on your account.
        </p>

        {/*
          What the published Community Guidelines say, rather than the stronger
          promise this page used to make. PR-3C refuses a conflicted reviewer, but
          a super administrator may override a non-personal conflict on the
          record — so "always a different person" would still be more than the
          code guarantees.
        */}
        <p className="auth-hint">
          A WeVolunteer administrator reads every appeal. The person who suspended you cannot be
          the one who decides it. We are a small team, so we cannot always promise a completely
          independent reviewer — but we will always tell you who reviewed it.
        </p>
      </main>
    </div>
  );
}
