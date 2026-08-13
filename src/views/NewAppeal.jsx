/**
 * Asking somebody to look at a decision again.
 *
 * ── Why this page exists, when an appeal form already did ──
 *
 * There were two ways to appeal and neither could be reached by a signed-in
 * student going about their day: `/appeal/:token` is the emailed link sent to a
 * suspended account, and `SuspendedWall` is the screen shown INSTEAD of the
 * product once you are locked out. Both assume the decision under appeal is a
 * suspension handed down by staff.
 *
 * An organization ban is neither. The person is not suspended — they keep using
 * the platform, they just cannot rejoin one club — so no wall is shown to them
 * and no email is sent. Without this page the "Make an appeal" button in their
 * notification pointed at nothing.
 *
 * It is deliberately the SAME appeal: `POST /api/appeals`, the same queue, the
 * same conflict-of-interest rule, the same record. This is a route into the
 * existing system, not a second one.
 *
 * ── What it does not do ──
 *
 * It does not decide whether you may appeal. The query string names what is
 * being appealed, and the server checks that the ban is real, is yours, and is
 * still active before it will accept anything — an arbitrary organization id
 * typed into the address bar is refused there, not here.
 */
import React, { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Scale, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api } from '../utils/api';
import { MIN_STATEMENT_LENGTH } from '../appeals';

/**
 * What each subject is called, and what the person is told before they write.
 *
 * Keyed by the server's own subject strings so the two cannot drift into
 * different vocabularies. An unrecognised subject falls back to the general
 * case rather than rendering a blank page.
 */
const SUBJECTS = {
  organization_ban: {
    title: 'Appeal a ban from an organization',
    lede: 'A manager of this organization banned you from it. Tell us what happened, '
      + 'and somebody who was not involved will read it.',
    prompt: 'Why should this ban be lifted?',
  },
  content_removal: {
    title: 'Appeal a removal',
    lede: 'Something you posted was removed. Tell us what happened, and somebody who '
      + 'was not involved will read it.',
    prompt: 'Why should this be restored?',
  },
  report_outcome: {
    title: 'Appeal a decision',
    lede: 'Tell us what happened, and somebody who was not involved will read it.',
    prompt: 'What would you like us to look at again?',
  },
};

/* No `addToast`: the outcome of sending an appeal is the whole page, and a
   toast that disappears after four seconds is the wrong way to tell somebody
   their defence was received. */
export default function NewAppeal() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const subject = SUBJECTS[params.get('subject')] ? params.get('subject') : 'report_outcome';
  const organizationId = params.get('organization');
  const copy = SUBJECTS[subject];

  const [statement, setStatement] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const short = statement.trim().length < MIN_STATEMENT_LENGTH;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSending(true);
    try {
      const res = await api.submitAppeal({ subject, statement, organizationId });
      /* A duplicate is answered 200 with the existing appeal, not an error —
         somebody who taps the notification twice has not done anything wrong,
         and telling them it failed would make them write it all again. */
      setSent(res?.duplicate ? 'duplicate' : 'new');
    } catch (err) {
      setError(err?.message || 'We could not send that. Please try again.');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="page stack-lg">
        <div className="card">
          <div className="card-body stack-md">
            <div className="auth-icon" aria-hidden="true"><CheckCircle2 size={26} /></div>
            <h1>{sent === 'duplicate' ? 'You have already appealed this' : 'Your appeal is with us'}</h1>
            <p className="muted">
              {sent === 'duplicate'
                ? 'We already have an open appeal from you about this, so we have not '
                  + 'started a second one. You do not need to send anything else.'
                : 'Somebody who was not involved in the decision will read it. We will let '
                  + 'you know once it has been looked at.'}
            </p>
            <div className="row">
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
                Back to your dashboard
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page stack-lg">
      <div className="page-head">
        <h1>{copy.title}</h1>
        <p className="muted">{copy.lede}</p>
      </div>

      <form className="card" onSubmit={submit}>
        <div className="card-body stack-md">
          <div className="field">
            <label htmlFor="appeal-statement">{copy.prompt}</label>
            <textarea
              id="appeal-statement"
              className="textarea"
              rows={7}
              maxLength={4000}
              value={statement}
              onChange={e => setStatement(e.target.value)}
              aria-describedby="appeal-statement-hint"
            />
            <span className="field-hint" id="appeal-statement-hint">
              A person reads this. At least {MIN_STATEMENT_LENGTH} characters
              {statement.trim().length > 0 && short
                ? ` — ${MIN_STATEMENT_LENGTH - statement.trim().length} to go.`
                : '.'}
            </span>
          </div>

          {error && (
            <div className="alert alert-danger" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <div><p>{error}</p></div>
            </div>
          )}
        </div>

        <div className="card-foot row-between">
          <Link className="btn btn-ghost" to="/">Cancel</Link>
          <button type="submit" className="btn btn-primary" disabled={sending || short}>
            <Scale size={16} aria-hidden="true" /> {sending ? 'Sending…' : 'Send appeal'}
          </button>
        </div>
      </form>
    </div>
  );
}
