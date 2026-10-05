import React from 'react';
import { ShieldCheck, AlertTriangle, Check, FileText } from 'lucide-react';
import { api } from '../../utils/api';
import PolicyBody from './PolicyBody';
import { effectiveDateLabel } from '../../views/legal/legalDates';

/**
 * The Admin Responsibilities Policy, and the form that accepts it.
 *
 * ── Why this lives on the Admin page rather than on a page of its own ──
 *
 * It first shipped as a standalone screen that redirected to the dashboard after
 * accepting, which put the obligation somewhere the reader had no reason to be.
 * An administrator meets this the moment they try to do administration, so the
 * gate belongs where the capability is wanted: `/admin/moderation` renders this
 * instead of its tiles until an acceptance is on record. Everything else in the
 * product keeps working, which is the honest shape of the rule — the policy
 * governs administration, not membership.
 *
 * ── Why the document is in its own scroll region ──
 *
 * The policy is long. Rendered as an ordinary page it pushed the acknowledgements
 * far below the fold, so the act of accepting was separated from the text being
 * accepted by several screens of scrolling — which is how people accept without
 * reading. Bounded, the text and the boxes are visible together, and the reader
 * scrolls the document rather than the page.
 *
 * ── What is deliberately NOT here ──
 *
 * No capability check. `can()` consults `withheld` before the `super_admin`
 * wildcard, so this is the only gate in the product that reaches the platform
 * owner; requiring any of the fourteen capabilities it restores would be a lock
 * on its own key. Both endpoints behind it are gated on authentication alone.
 */

/**
 * The undertakings, drawn from the policy's own sections.
 *
 * Restated rather than parsed out of the Markdown: parsing would make the number
 * of boxes hostage to an editorial reflow of a list. These track "What you may
 * never do", "Reading a conversation" and "If you believe a child has been
 * harmed".
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

/** What the reader loses, in the words they would use rather than capability names. */
const PAUSED = [
  'Reports and the review history behind them',
  'Appeals',
  'Warning, suspending, or lifting a suspension',
  'Approving or declining organizers',
  'An applicant’s contact details, and every application',
  'Badges, school analytics, and roster exports',
];

export default function AdminPolicyGate({ currentUser, addToast, onAccepted }) {
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
  const tickedCount = UNDERTAKINGS.filter(u => ticked[u.id]).length;

  async function submit(event) {
    event.preventDefault();
    if (!allTicked || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.acceptAdminResponsibilities();
      addToast?.('Policy accepted. Your administrator tools are available.', 'success');
      /* Capabilities are derived per request, so they are live immediately. The
         session refresh is what lets the navigation and the client-side `can()`
         catch up with what the server already allows — and, on the Admin page,
         what swaps this gate for the tiles without a reload. */
      await onAccepted?.();
    } catch (err) {
      setError(err?.message || 'That could not be recorded. Please try again.');
      setSubmitting(false);
    }
  }

  if (error && !status) {
    return <p className="alert alert-warn" role="alert">{error}</p>;
  }

  if (!status) {
    return <p className="dim" role="status" aria-live="polite">Loading the policy…</p>;
  }

  if (!status.required || status.accepted) return null;

  return (
    <div className="stack-lg" aria-labelledby="apg-title">
      <div className="card card-pad stack-md">
        <div className="apg-head">
          <span className="apg-icon" aria-hidden="true"><ShieldCheck size={22} /></span>
          <div className="stack-xs">
            <h3 id="apg-title" className="apg-title">
              {currentUser?.name ? `${currentUser.name}, one` : 'One'} thing before you can administer
            </h3>
            <p className="dim">
              This account holds administrator access. The undertakings below are what you accept
              in exchange for being able to see and act on other people&rsquo;s records.
            </p>
          </div>
        </div>

        {/* Named plainly. Somebody whose tools have stopped deserves to know
            exactly what stopped rather than concluding the product is broken. */}
        <div className="apg-paused">
          <p className="strong small">
            <AlertTriangle size={15} aria-hidden="true" /> Paused until you accept
          </p>
          <ul className="apg-paused-list small">
            {PAUSED.map(p => <li key={p}>{p}</li>)}
          </ul>
          <p className="small dim apg-paused-note">
            You can still sign in, use your own account, browse the product, and read this page.
            Nothing is deleted, and accepting restores everything immediately.
          </p>
        </div>
      </div>

      <section className="card apg-doc" aria-labelledby="apg-doc-title">
        <div className="apg-doc-head">
          <h3 id="apg-doc-title" className="apg-doc-title">
            <FileText size={16} aria-hidden="true" /> {status.documents[0]?.title || 'Admin Responsibilities Policy'}
          </h3>
          <p className="small dim">
            Version {status.documents[0]?.version}
            {effectiveDateLabel(status.documents[0]?.effectiveAt) && ` · ${effectiveDateLabel(status.documents[0].effectiveAt)}`}
          </p>
        </div>
        {/* Bounded and scrollable, so the text and the boxes below stay on screen
            together. `tabIndex` because a scrollable region has to be reachable
            by keyboard, and the role/label make it an announced landmark. */}
        <div
          className="apg-doc-scroll policy-body"
          tabIndex={0}
          role="region"
          aria-label="The Admin Responsibilities Policy, scrollable"
        >
          {markdown && <PolicyBody markdown={markdown} />}
        </div>
      </section>

      <form className="stack-md" onSubmit={submit}>
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

        <div className="apg-actions">
          <button className="btn btn-primary" type="submit" disabled={!allTicked || submitting}>
            {submitting ? 'Recording…' : 'Accept and continue'}
          </button>
          {/* Never a dead button with no explanation, and a count rather than a
              bare "tick every box" so the reader knows how far along they are. */}
          <span className="auth-hint" role="status" aria-live="polite">
            {allTicked ? 'Ready to accept.' : `${tickedCount} of ${UNDERTAKINGS.length} confirmed.`}
          </span>
        </div>
        <p className="small dim">
          Your name, the date and time, and the version of this document are recorded
          automatically with your acceptance. They are not fields for you to fill in.
        </p>
      </form>
    </div>
  );
}
