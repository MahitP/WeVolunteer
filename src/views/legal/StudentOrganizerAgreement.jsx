import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, AlertTriangle, Check } from 'lucide-react';
import { api } from '../../utils/api';
import PolicyBody from '../../components/legal/PolicyBody';

/**
 * The Student Organizer Agreement acceptance screen.
 *
 * ── Why it exists, and why it cannot be skippable ──
 *
 * Somebody promoted to help run a club holds four capabilities that reach other
 * students: posting as the organization, creating its events, managing who gets
 * a place, and writing credited hours. They are withheld until an acceptance is
 * on record (`server/studentOrganizerAgreement.js`), and that gate is derived
 * per request server-side. This page is not the enforcement; it is the only way
 * out of the withheld state.
 *
 * Which makes one thing load-bearing, exactly as on the organizer screen: it
 * must be reachable while holding almost nothing. Declared with no
 * `requiredCap`, and the two endpoints behind it are open to any authenticated
 * caller. A consent screen that requires the permissions it releases is a
 * lockout, and a lockout teaches people to click through without reading.
 *
 * ── Why the whole text is on the page ──
 *
 * The alternative is a checkbox beside a link, which is how nobody reads
 * anything. The document is deliberately short, and it is written for a
 * fifteen-year-old on a phone.
 */

/**
 * The seven undertakings, as §11 of the agreement lists them.
 *
 * Restated here rather than parsed out of the Markdown, matching the organizer
 * screen: parsing would tie the number of controls to a document's formatting,
 * so reflowing a list would silently change how many boxes somebody must tick.
 * A test pins these against the published text instead.
 */
const UNDERTAKINGS = [
  { id: 'read', label: 'I have read this agreement.' },
  { id: 'trusted', label: 'I understand I am trusted with other people’s information, and that many of them are minors.' },
  { id: 'purpose', label: 'I will use what I can see only to run my organization’s events.' },
  { id: 'no-sharing', label: 'I will not share anyone’s information with people who do not need it, and I will delete any copies I make once the event is over.' },
  { id: 'honest-hours', label: 'I will credit volunteer hours honestly.' },
  { id: 'scope', label: 'I understand what my role does and does not let me do, and I will not try to reach anything beyond it.' },
  { id: 'can-lose-it', label: 'I understand I can lose this rank if I misuse it.' },
];

export default function StudentOrganizerAgreement({ currentUser, addToast, onAccepted }) {
  const navigate = useNavigate();

  const [status, setStatus] = React.useState(null);
  const [markdown, setMarkdown] = React.useState(null);
  const [ticked, setTicked] = React.useState({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.fetchStudentOrganizerAgreement(),
      api.fetchLegalDocument('student-organizer-agreement'),
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
      await api.acceptStudentOrganizerAgreement();
      addToast?.('Agreement accepted. You can now help run your organization.', 'success');
      /* The capabilities are derived per request, so they are live immediately —
         no re-sign-in. The session is refreshed so the navigation and the
         client-side `can()` catch up with what the server already allows. */
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
        <h1>Student Organizer Agreement</h1>
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
        <h1>Student Organizer Agreement</h1>
        <p>
          This agreement applies to people who help run an organization. You do not at the
          moment, so there is nothing for you to accept — you can read it in the{' '}
          <a className="auth-link" href="/legal/student-organizer-agreement">Legal Center</a>.
        </p>
      </main>
    );
  }

  if (status.accepted) {
    return (
      <main className="content stack-lg">
        <h1>Student Organizer Agreement</h1>
        <p className="alert alert-brand" role="status">
          <Check size={16} aria-hidden="true" /> You accepted this agreement (version {status.documents[0]?.version}).
        </p>
        <p className="small dim">
          You can re-read it any time in the{' '}
          <a className="auth-link" href="/legal/student-organizer-agreement">Legal Center</a>. If
          it is ever updated, you will be asked to accept the new version before your
          organization tools work again.
        </p>
      </main>
    );
  }

  return (
    <main className="content stack-lg" aria-labelledby="soa-title">
      <div className="stack-sm">
        <h1 id="soa-title">Before you help run this organization</h1>
        <p>
          {currentUser?.name ? `${currentUser.name}, a` : 'A'} manager has trusted you to help
          run their organization. One thing remains: the undertakings below are what you
          accept in exchange for being able to see the people who apply to its events.
        </p>
      </div>

      {/* Stated plainly and up front. Somebody whose new controls do not appear
          deserves to know exactly why rather than assuming the app is broken. */}
      <div className="alert alert-warn stack-sm" role="status">
        <div className="alert-title">
          <AlertTriangle size={16} aria-hidden="true" /> Your organization tools are paused until you accept
        </div>
        <p>
          Until then you cannot post as the organization, create its events, manage who gets a
          place, or record attendance. Nothing about your account is at risk and nothing is
          deleted — accepting turns all of it on immediately. You can also simply not accept,
          and stay an ordinary member.
        </p>
      </div>

      <section className="stack-sm" aria-labelledby="soa-text">
        <h2 id="soa-text">The agreement</h2>
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
            Your name, the date and time, and the version of this document are recorded
            automatically with your acceptance. They are not fields for you to fill in.
          </p>
        </div>
      </form>
    </main>
  );
}
