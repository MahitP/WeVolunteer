import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, AlertTriangle, Check } from 'lucide-react';
import { api } from '../../utils/api';
import PolicyBody from '../../components/legal/PolicyBody';

/**
 * The Organizer Agreement acceptance screen.
 *
 * ── Why this screen has to exist, and why it cannot be skippable ──
 *
 * An organizer holds none of the capabilities that reach a student — seeing who
 * applied, marking attendance, messaging, creating events — until an acceptance
 * is on record. See `server/organizerAgreement.js`. That gate is enforced
 * server-side and derived per request, so this page is not the enforcement; it is
 * the only way out of the gated state.
 *
 * Which makes one thing load-bearing: an organizer must be able to REACH this
 * page while holding almost nothing. It is declared with no `requiredCap`, and
 * the two endpoints behind it are the two an organizer keeps. A consent screen
 * that requires the permissions it grants is a lockout, and a lockout is what
 * teaches people to click through without reading.
 *
 * ── Why the full text is on the page ──
 *
 * The alternative is a checkbox next to a link, which is how nobody reads
 * anything. This renders the whole agreement above the acknowledgements, so the
 * text and the act of accepting it are in one place. It is not long.
 *
 * ── Why seven checkboxes and not one ──
 *
 * The agreement itemises seven undertakings and §13 lists them as separate
 * boxes. One combined "I agree" would be less evidence, not more convenience: in
 * a dispute the question is what this person specifically undertook, and seven
 * ticks answer it far better than one. The server refuses a submission that
 * acknowledges nothing regardless — the client cannot be the thing enforcing it.
 */

/**
 * The seven undertakings, as §13 of the agreement lists them.
 *
 * Restated here rather than parsed out of the Markdown. Parsing would couple the
 * form's control count to a document's formatting, so an editorial reflow of a
 * list would silently change how many boxes a person has to tick — and a test
 * pins these against the published text instead, which catches a real divergence
 * without making the UI hostage to whitespace.
 */
const UNDERTAKINGS = [
  { id: 'read', label: 'I have read this agreement.' },
  { id: 'minors', label: 'I understand that most students on WeVolunteer are minors.' },
  { id: 'contact-use', label: 'I will use student contact details only to run my own events, and delete my copies within 30 days.' },
  { id: 'two-adults', label: 'I will never be alone with a single student, and at least two adults will be present at my events.' },
  { id: 'mandated-report', label: 'I understand that New Jersey law requires me to report suspected child abuse directly to DCP&P at 1-877-NJ-ABUSE.' },
  { id: 'hours', label: 'I will record volunteer hours accurately.' },
  { id: 'no-background-check', label: 'I understand WeVolunteer has not run a background check on me.' },
];

export default function OrganizerAgreement({ currentUser, addToast, onAccepted }) {
  const navigate = useNavigate();

  const [status, setStatus] = React.useState(null);
  const [markdown, setMarkdown] = React.useState(null);
  const [ticked, setTicked] = React.useState({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.fetchOrganizerAgreement(),
      api.fetchLegalDocument('organizer-agreement'),
    ])
      .then(([state, doc]) => {
        if (cancelled) return;
        setStatus(state);
        setMarkdown(doc.markdown);
      })
      .catch(() => {
        if (!cancelled) setError('This agreement could not be loaded right now. Please try again shortly.');
      });

    return () => { cancelled = true; };
  }, []);

  const allTicked = UNDERTAKINGS.every(u => ticked[u.id]);

  async function submit(event) {
    event.preventDefault();
    if (!allTicked || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.acceptOrganizerAgreement();
      addToast?.('Agreement accepted. Your organizer tools are now available.', 'success');
      // The capabilities are derived per request, so they are live immediately —
      // no re-sign-in. The session is refreshed so the navigation and the
      // client-side `can()` catch up with what the server already allows.
      await onAccepted?.();
      navigate('/');
    } catch (err) {
      setError(err?.message || 'That could not be recorded. Please try again.');
      setSubmitting(false);
    }
  }

  if (error && !status) {
    return (
      <main className="content stack-lg">
        <h1>Organizer Agreement</h1>
        <p className="alert alert-warn" role="alert">{error}</p>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="content stack-lg">
        <p className="dim" role="status" aria-live="polite">Loading the agreement…</p>
      </main>
    );
  }

  if (!status.required) {
    return (
      <main className="content stack-lg">
        <h1>Organizer Agreement</h1>
        <p>
          This agreement applies to organizer accounts. Yours is not one, so there is
          nothing for you to accept — you can read it in the{' '}
          <a className="auth-link" href="/legal/organizer-agreement">Legal Center</a>.
        </p>
      </main>
    );
  }

  if (status.accepted) {
    return (
      <main className="content stack-lg">
        <h1>Organizer Agreement</h1>
        <p className="alert alert-brand" role="status">
          <Check size={16} aria-hidden="true" /> You accepted this agreement (version {status.documents[0]?.version}).
        </p>
        <p className="small dim">
          You can re-read it any time in the{' '}
          <a className="auth-link" href="/legal/organizer-agreement">Legal Center</a>. If it is
          ever updated, you will be asked to accept the new version before your organizer
          tools work again.
        </p>
      </main>
    );
  }

  return (
    <main className="content stack-lg" aria-labelledby="oa-title">
      <div className="stack-sm">
        <h1 id="oa-title">Before you can run events</h1>
        <p>
          {currentUser?.name ? `${currentUser.name}, your` : 'Your'} organizer account has been
          approved. One thing remains: the undertakings below are what you accept in exchange
          for being able to see the students who apply to your events.
        </p>
      </div>

      {/* Stated plainly and up front. An organizer who cannot see their tools
          deserves to know exactly why rather than assuming the app is broken. */}
      <div className="alert alert-warn stack-sm" role="status">
        <div className="alert-title">
          <AlertTriangle size={16} aria-hidden="true" /> Your organizer tools are paused until you accept
        </div>
        <p>
          Until then you cannot create events, see who applied, mark attendance, or message
          students. Nothing about your account is at risk, and nothing is deleted — accepting
          restores all of it immediately.
        </p>
      </div>

      <section className="stack-sm" aria-labelledby="oa-text">
        <h2 id="oa-text">The agreement</h2>
        <p className="small dim">
          Version {status.documents[0]?.version}
          {status.documents[0]?.effectiveAt && ` · in effect since ${status.documents[0].effectiveAt}`}
        </p>
        {markdown && <PolicyBody markdown={markdown} />}
      </section>

      <form className="stack-lg" onSubmit={submit}>
        <fieldset className="oa-fieldset stack-sm">
          <legend className="oa-legend">
            <ShieldCheck size={18} aria-hidden="true" /> By accepting, you confirm
          </legend>

          {UNDERTAKINGS.map(u => (
            <label key={u.id} className="oa-undertaking">
              <input
                type="checkbox"
                checked={Boolean(ticked[u.id])}
                onChange={e => setTicked(prev => ({ ...prev, [u.id]: e.target.checked }))}
              />
              <span>{u.label}</span>
            </label>
          ))}
        </fieldset>

        {error && <p className="alert alert-danger" role="alert">{error}</p>}

        <div className="stack-sm">
          <button className="btn btn-primary" type="submit" disabled={!allTicked || submitting}>
            {submitting ? 'Recording…' : 'Accept and continue'}
          </button>
          {/* Never a dead button with no explanation. */}
          <span className="auth-hint" role="status" aria-live="polite">
            {allTicked ? '' : 'Tick every box above to continue.'}
          </span>
          <p className="small dim">
            Your name, organization, the date and time, and the version of this document are
            recorded automatically with your acceptance. They are not fields for you to fill in.
          </p>
        </div>
      </form>
    </main>
  );
}
