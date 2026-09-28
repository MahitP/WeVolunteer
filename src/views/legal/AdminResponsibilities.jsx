import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, AlertTriangle, Check } from 'lucide-react';
import { api } from '../../utils/api';
import PolicyBody from '../../components/legal/PolicyBody';

/**
 * The Admin Responsibilities Policy acceptance screen.
 *
 * ── Why this screen exists ──
 *
 * The policy was published as a notice and enforced by nothing: both owner
 * accounts held every capability with no acceptance row against it, while the
 * Organizer Agreement had gated its far weaker role since it shipped. Since
 * 2026-09-27 it is an agreement — `server/adminResponsibilitiesPolicy.js`
 * withholds fourteen capabilities until an acceptance is on record.
 *
 * ── Why reaching it cannot require anything ──
 *
 * This is the twin of `OrganizerAgreement.jsx` and the reasoning carries over
 * with one difference that makes it sharper: `can()` checks `withheld` BEFORE
 * the `super_admin` wildcard, so this is the only gate in the product that
 * reaches the platform owner. If this page needed a capability the policy
 * withholds, the owner would have no way back into their own instance short of
 * the CLI. It is declared with no `requiredCap`, and both endpoints behind it
 * are gated on authentication alone.
 *
 * ── Why the boxes are not one box ──
 *
 * Same reasoning as the organizer screen. The question in a dispute is what this
 * person specifically undertook, and separate ticks answer it better than one.
 * The server refuses a submission that acknowledges nothing regardless — the
 * client is never the thing enforcing it.
 */

/**
 * The undertakings, drawn from the policy's own sections.
 *
 * Restated rather than parsed out of the Markdown, for the reason the organizer
 * screen gives: parsing would make the control count hostage to an editorial
 * reflow. These track §"What you may never do", §"Reading a conversation" and
 * §"If you believe a child has been harmed".
 */
const UNDERTAKINGS = [
  { id: 'read', label: 'I have read this policy.' },
  { id: 'task', label: 'I will open a student’s record only when a task in front of me requires it — never out of personal interest, and never for somebody I know.' },
  { id: 'no-copies', label: 'I will not copy student data into a spreadsheet, an email, or a personal device, or discuss an identifiable student where they would not expect it.' },
  { id: 'conversations', label: 'I will read a private conversation only when it has been reported, a safety concern requires it, or the authorities have lawfully asked.' },
  { id: 'audit', label: 'I understand every action I take is logged, that I may not edit or delete an audit record, and that I must record why when I change a record.' },
  { id: 'mandated-report', label: 'I understand New Jersey law requires me personally to report suspected child abuse to DCP&P at 1-877-NJ-ABUSE immediately — not to escalate internally first — and that I must not investigate it myself.' },
  { id: 'least-access', label: 'I will not give anybody more access than their job needs.' },
];

export default function AdminResponsibilities({ currentUser, addToast, onAccepted }) {
  const navigate = useNavigate();

  const [status, setStatus] = React.useState(null);
  const [markdown, setMarkdown] = React.useState(null);
  const [ticked, setTicked] = React.useState({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.fetchAdminResponsibilities(),
      api.fetchLegalDocument('admin-responsibilities-policy'),
    ])
      .then(([state, doc]) => {
        if (cancelled) return;
        setStatus(state);
        setMarkdown(doc.markdown);
      })
      .catch(() => {
        if (!cancelled) setError('This policy could not be loaded right now. Please try again shortly.');
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
      await api.acceptAdminResponsibilities();
      addToast?.('Policy accepted. Your administrator tools are now available.', 'success');
      /* Capabilities are derived per request, so they are live immediately — no
         re-sign-in. The session refresh is what lets the navigation and the
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
        <h2 className="page-title">Admin Responsibilities Policy</h2>
        <p className="alert alert-warn" role="alert">{error}</p>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="content stack-lg">
        <p className="dim" role="status" aria-live="polite">Loading the policy…</p>
      </main>
    );
  }

  if (!status.required) {
    return (
      <main className="content stack-lg">
        <h2 className="page-title">Admin Responsibilities Policy</h2>
        <p>
          This policy applies to administrator accounts. Yours is not one, so there is
          nothing for you to accept — you can read it in the{' '}
          <a className="auth-link" href="/legal/admin-responsibilities-policy">Legal Center</a>.
        </p>
      </main>
    );
  }

  if (status.accepted) {
    return (
      <main className="content stack-lg">
        <h2 className="page-title">Admin Responsibilities Policy</h2>
        <p className="alert alert-brand" role="status">
          <Check size={16} aria-hidden="true" /> You accepted this policy (version {status.documents[0]?.version}).
        </p>
        <p className="small dim">
          You can re-read it any time in the{' '}
          <a className="auth-link" href="/legal/admin-responsibilities-policy">Legal Center</a>. If it is
          ever updated, you will be asked to accept the new version before your administrator
          tools work again.
        </p>
      </main>
    );
  }

  return (
    <main className="content stack-lg" aria-labelledby="ar-title">
      <div className="stack-sm">
        <h2 id="ar-title" className="page-title">Before you can act as an administrator</h2>
        <p>
          {currentUser?.name ? `${currentUser.name}, your` : 'Your'} account holds administrator
          access. The undertakings below are what you accept in exchange for being able to see
          and act on other people&rsquo;s records.
        </p>
      </div>

      {/* Stated plainly and up front, for the reason the organizer screen gives:
          somebody whose tools have stopped deserves to know exactly why rather
          than concluding the product is broken. */}
      <div className="alert alert-warn stack-sm" role="status">
        <div className="alert-title">
          <AlertTriangle size={16} aria-hidden="true" /> Your administrator tools are paused until you accept
        </div>
        <p>
          Until then you cannot resolve reports, decide appeals, suspend or warn anyone, approve
          organizers, or see an applicant&rsquo;s contact details. You can still sign in, use your
          own account, and read this page. Nothing is deleted, and accepting restores everything
          immediately.
        </p>
      </div>

      <section className="stack-sm" aria-labelledby="ar-text">
        <h2 id="ar-text">The policy</h2>
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
