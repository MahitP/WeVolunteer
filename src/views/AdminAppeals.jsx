/**
 * The appeals queue and review screen.
 *
 * Corrections carried by PR-3C, each of which was a live defect:
 *
 *   - The panel headed "Appeal Statement" rendered `appeal.reasoning`, which
 *     after any decision held the MODERATOR's text. A reviewer reopening a
 *     decided case read their colleague's ruling under a heading saying it was
 *     the student's words. The two texts are now separate columns and are
 *     rendered in separately titled panels.
 *   - "Lift Suspension (Decision Reversed)" did not lift the suspension. The
 *     reversal is now offered as an explicit second action, with its own audit
 *     row, rather than a paragraph asking the reviewer to remember.
 *   - `report.reason` has not existed since migration 012 renamed it to
 *     `description`, so the whole Linked Report panel rendered blank on the one
 *     screen where a suspension is judged.
 *   - `EmptyState` takes `action` as a NODE; this file passed `actionLabel` and
 *     `onAction`, which React drops silently — so every "Back to Queue" button
 *     after a decision never rendered and the reviewer was stranded.
 *   - Queue rows were `<li onClick>` with no role, tabIndex or key handler, so a
 *     keyboard-only reviewer could not open a single appeal.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { Scale, CheckCircle2, ShieldBan, AlertCircle, ShieldOff } from 'lucide-react';
import { useModal } from '../utils/useModal';

const SLA_DAYS = 5;

const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

/** Age against the published 5-business-day reply commitment. */
function SlaBadge({ createdAt }) {
  const days = daysSince(createdAt);
  if (days >= SLA_DAYS) {
    return <span className="status status-danger">Overdue — day {days}</span>;
  }
  if (days >= SLA_DAYS - 1) {
    return <span className="status status-pending">Day {days} of {SLA_DAYS}</span>;
  }
  return <span className="status status-muted">Day {days} of {SLA_DAYS}</span>;
}

export default function AdminAppeals() {
  const [appeals, setAppeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [pendingRemedies, setPendingRemedies] = useState([]);

  const fetchAppeals = useCallback(async () => {
    try {
      const { appeals: rows, pendingRemedies: remedies } = await api.fetchAdminAppeals();
      setAppeals(rows);
      /**
       * Appeals that were UPHELD and whose appellant is still suspended.
       *
       * The server has computed this since appeals shipped, with a long comment
       * explaining that a reviewer who decides "reversed" and then closes the tab
       * before pressing "Reinstate" leaves a student suspended on the strength of
       * an appeal they had WON. This screen destructured only `appeals` and threw
       * it away.
       *
       * The consequence is the worst state in the product: the appeal is
       * `resolved`, so it drops out of the default `open,reviewing` queue and no
       * screen mentions it again. Nobody is looking for the student, the student
       * has been told they were right, and they are still locked out.
       */
      setPendingRemedies(remedies || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load appeals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAppeals(); }, [fetchAppeals]);

  if (loading) return <div className="page"><LoadingSkeleton heights={[40, 200, 200]} /></div>;
  if (error) {
    return (
      <div className="page">
        <EmptyState icon={AlertCircle} title="Could not load the queue" message={error} />
      </div>
    );
  }

  if (selectedId) {
    return (
      <AppealDetail
        id={selectedId}
        onBack={() => { setSelectedId(null); fetchAppeals(); }}
      />
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Appeals</h1>
        <p className="muted">
          Oldest first. We tell appellants we reply within {SLA_DAYS} school days, so the oldest
          item is the promise.
        </p>
      </header>

      {/**
        * Above the queue, deliberately.
        *
        * Everything below is somebody waiting for an answer. This is somebody who
        * already HAS their answer, in their favour, and is still locked out — so
        * it is both more urgent and more embarrassing, and it must not be
        * something a moderator scrolls past on a busy day.
        */}
      {pendingRemedies.length > 0 && (
        <div className="alert alert-warn" role="alert">
          <div>
            <span className="alert-title">
              {pendingRemedies.length === 1
                ? 'One person won their appeal and is still suspended'
                : `${pendingRemedies.length} people won their appeals and are still suspended`}
            </span>
            <p className="small">
              The decision was recorded but the account was never reinstated. Open the
              account and lift the suspension.
            </p>
            <ul className="stack-sm">
              {pendingRemedies.map(r => (
                <li key={r.id} className="small">
                  <span className="strong">{r.user_name}</span>
                  {r.decided_at && <span className="dim"> — decided {new Date(r.decided_at).toLocaleString()}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {appeals.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="Inbox zero" message="No appeals are waiting." />
      ) : (
        <ul className="stack-md">
          {appeals.map(a => (
            <li key={a.id} className="card">
              {/*
                A real button, not a clickable <li>. The row carries the only
                route into an appeal, and a moderator triaging on a keyboard
                could not previously reach it at all.
              */}
              <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={() => setSelectedId(a.id)}
              >
                Review the appeal from {a.user_name}
              </button>
              <p className="muted">
                <SlaBadge createdAt={a.created_at} />
                {a.status === 'reviewing' && <span className="tag tag-warn">Being reviewed</span>}
                {/*
                  Conflicted appeals are MARKED, never hidden. On a two-person
                  team, filtering them out means nobody knows the appeal exists —
                  and a 403 the reviewer only meets after reading the case and
                  writing their reasoning is a design failure, not a control.
                */}
                {!a.canDecide && <span className="tag tag-warn">Not yours to decide</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Confirmation before a decision becomes permanent.
 *
 * Its own component so `useModal` — which supplies Escape, focus containment,
 * focus restore and scroll lock, and which `dialogSemantics.test.jsx` requires
 * of every overlay in this app — is called unconditionally.
 *
 * The reviewer's reasoning is quoted back deliberately. That text is sent to the
 * appellant word for word, and the field it was typed into used to say it was
 * "recorded in the audit log" — which reads as internal, and a reviewer who
 * believes that writes notes they would never send to a 15-year-old.
 */
function ConfirmDecision({ decision, name, reasoning, submitting, onCancel, onConfirm }) {
  const dialogRef = useModal(onCancel);
  const reversing = decision === 'reversed';

  return (
    <div className="modal-overlay">
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal-head">
          <h2 id="confirm-title">
            {reversing ? `Lift the suspension for ${name}?` : `Keep ${name} suspended?`}
          </h2>
        </div>
        <div className="modal-body stack-md">
          <p>
            {reversing
              ? `${name} will be emailed to say we got it wrong. You will then be asked to reinstate the account.`
              : `${name} stays locked out, and will be emailed your reasons.`}
          </p>
          <p className="muted">They will read this word for word:</p>
          <div className="alert alert-warn">
            <Scale size={18} aria-hidden="true" />
            <span>{reasoning}</span>
          </div>
          <p className="muted">
            Recorded in the audit log under your name. Changing it later needs an explicit reopen,
            which is also recorded — and whoever reopens it cannot be the one to decide it again.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
            Go back
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={submitting}>
            {submitting ? 'Recording…' : (reversing ? 'Yes, lift it' : 'Yes, keep it')}
          </button>
        </div>
      </div>
    </div>
  );
}

function AppealDetail({ id, onBack }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reasoning, setReasoning] = useState('');
  const [pending, setPending] = useState(null);     // the decision awaiting confirmation
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [remedyDone, setRemedyDone] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.fetchAdminAppeal(id)
      .then(setDetail)
      .catch(err => setError(err.message || 'Failed to load this appeal.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const decide = async (decision) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.decideAppeal(id, { decision, reasoning });
      setOutcome(res);
    } catch (err) {
      setSubmitError(err.message || 'Could not record that decision.');
    } finally {
      setSubmitting(false);
      setPending(null);
    }
  };

  const applyRemedy = async () => {
    setSubmitting(true);
    try {
      await api.unsuspendUser(
        outcome.remedy.userId,
        'Appeal upheld — suspension reversed on review.'
      );
      setRemedyDone(true);
    } catch (err) {
      setSubmitError(err.message || 'Could not reinstate that account.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="page"><LoadingSkeleton heights={[40, 400]} /></div>;
  if (error) {
    return (
      <div className="page">
        <EmptyState
          icon={AlertCircle}
          title="Could not load this appeal"
          message={error}
          action={<button className="btn btn-primary" onClick={onBack}>Back to the queue</button>}
        />
      </div>
    );
  }

  const { appeal, report, history, conflicts, canDecide } = detail;

  /* ── After a decision ──────────────────────────────────────────────────── */
  if (outcome) {
    return (
      <div className="page stack-md">
        <EmptyState
          icon={CheckCircle2}
          title={outcome.decision === 'reversed' ? 'Suspension reversed' : 'Suspension kept in place'}
          message={`${appeal.user_name} has been emailed the decision, your reasons and your name.`}
          action={<button className="btn btn-secondary" onClick={onBack}>Back to the queue</button>}
        />

        {/*
          The remedy is offered, not described. Reversal deliberately does not
          unsuspend inside the decision transaction — reinstatement is a second
          decision with its own refusals, its own audit row and its own notice —
          but leaving the reviewer a paragraph to remember is how a student who
          won their appeal stays locked out indefinitely.
        */}
        {outcome.remedy?.required && !remedyDone && (
          <div className="alert alert-warn">
            <ShieldOff size={18} aria-hidden="true" />
            <span>
              <span className="alert-title">One step left</span>
              {' '}{outcome.remedy.message} Until you do, they still cannot sign in.
              <button className="btn btn-primary" onClick={applyRemedy} disabled={submitting}>
                {submitting ? 'Reinstating…' : 'Reinstate this account now'}
              </button>
            </span>
          </div>
        )}
        {remedyDone && (
          <div className="alert" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>Account reinstated. They have been emailed and can sign in again.</span>
          </div>
        )}
        {submitError && (
          <div className="alert alert-danger" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <span>{submitError}</span>
          </div>
        )}
      </div>
    );
  }

  /* ── Review ────────────────────────────────────────────────────────────── */
  const longEnough = reasoning.trim().length >= 20;

  return (
    <div className="page stack-md">
      {pending && (
        <ConfirmDecision
          decision={pending}
          name={appeal.user_name}
          reasoning={reasoning}
          submitting={submitting}
          onCancel={() => setPending(null)}
          onConfirm={() => decide(pending)}
        />
      )}

      <header className="page-head">
        <button className="btn btn-secondary" onClick={onBack}>&larr; Back to the queue</button>
        <h1>Review an appeal</h1>
        <p className="muted">From {appeal.user_name} · <SlaBadge createdAt={appeal.created_at} /></p>
      </header>

      {!canDecide && (
        <div className="alert alert-warn" role="alert">
          <ShieldBan size={18} aria-hidden="true" />
          <span>
            <span className="alert-title">You cannot decide this one</span>
            {' '}You can read it, but somebody else has to decide it
            {conflicts?.length ? ` — ${conflicts.join(', ').replace(/_/g, ' ')}` : ''}. It stays in
            the queue and its {SLA_DAYS}-day clock is still running.
          </span>
        </div>
      )}

      <div className="grid-2">
        <section className="card stack-md">
          <h2>What was appealed</h2>
          <p>
            <strong>Suspended by:</strong> {appeal.suspended_by_name_snapshot || 'Not recorded'}<br />
            <strong>Reason given to them:</strong> {appeal.suspension_reason_snapshot || 'Not recorded'}
          </p>

          {report && (
            <>
              <h3>Linked report</h3>
              <p>
                <strong>Category:</strong> {report.category}<br />
                <strong>What was reported:</strong> {report.description || 'No description given'}<br />
                <strong>Reported by:</strong> {report.reporter_name_snapshot || 'Not recorded'}
              </p>
              {report.target_body_snapshot && (
                <>
                  <h3>The content itself</h3>
                  <p>{report.target_body_snapshot}</p>
                </>
              )}
            </>
          )}
        </section>

        <section className="card stack-md">
          <h2>What {appeal.user_name} said</h2>
          {appeal.statementMissing ? (
            <div className="alert alert-danger">
              <AlertCircle size={18} aria-hidden="true" />
              <span>
                <span className="alert-title">We do not have their statement.</span>
                {' '}It was overwritten by an earlier version of this tool. Do not decide this on
                the record alone — email them first.
              </span>
            </div>
          ) : (
            // Not italic: the accessibility report flags italics at small sizes,
            // and this is the one block on the screen that must be read carefully.
            <p>{appeal.statement}</p>
          )}
        </section>
      </div>

      {history?.length > 0 && (
        <section className="card">
          <h2>History</h2>
          <ul className="stack-xs">
            {history.map((h, i) => (
              <li key={i} className="muted">
                {new Date(h.created_at).toLocaleString()} — {h.action} by {h.actor_name}
                {h.note ? `: ${h.note}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card stack-md">
        <h2>Your decision</h2>

        {submitError && (
          <div className="alert alert-danger" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <span>{submitError}</span>
          </div>
        )}

        <div className="field">
          <label htmlFor="appeal-reasoning">
            <strong>Your reasons — {appeal.user_name} will read this</strong>
          </label>
          <p className="field-hint" id="appeal-reasoning-help">
            Explain your decision. It is sent to them word for word, so write it to them. At least
            20 characters.
          </p>
          <textarea
            id="appeal-reasoning"
            className="textarea"
            rows={5}
            value={reasoning}
            aria-describedby="appeal-reasoning-help appeal-reasoning-status"
            onChange={e => setReasoning(e.target.value)}
            disabled={!canDecide || submitting}
          />
          <span className="field-hint" id="appeal-reasoning-status" role="status" aria-live="polite">
            {!longEnough && reasoning.length > 0 && 'A bit more — this is what they receive.'}
          </span>
        </div>

        <div className="row">
          <button
            className="btn btn-secondary"
            disabled={!canDecide || !longEnough || submitting}
            onClick={() => setPending('stands')}
          >
            <ShieldBan size={16} aria-hidden="true" /> Keep the suspension
          </button>
          <button
            className="btn btn-primary"
            disabled={!canDecide || !longEnough || submitting}
            onClick={() => setPending('reversed')}
          >
            <Scale size={16} aria-hidden="true" /> Lift the suspension
          </button>
        </div>
        <p className="field-hint">
          Keep: they stay locked out and are emailed your reasons. Lift: you will be asked to
          reinstate the account straight after.
        </p>
      </section>
    </div>
  );
}
