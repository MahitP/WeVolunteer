import React, { useState } from 'react';
import { AlertTriangle, UserX, MessageSquareWarning } from 'lucide-react';
import { api } from '../../utils/api';
import { can } from '../../authz';

/**
 * Actions against the PERSON a report is about.
 *
 * ── Why this is separate from resolving the report ──
 *
 * Closing a report and acting on somebody are different decisions with different
 * capabilities, and conflating them is how `warning_issued` ended up as a label
 * that told nobody: the resolution dropdown has offered "Warning issued to the
 * person reported" since v1.2, and choosing it only ever wrote a word on a closed
 * report. The person was never told.
 *
 * So the outcome is recorded where it belongs — on the report — and the act is
 * performed here, against an endpoint that notifies the person and writes an audit
 * row. A moderator can still do one without the other, deliberately: a report can
 * be dismissed with no action, and somebody can be warned about something that
 * came to light without a report at all.
 *
 * ── Why every control is capability-gated ──
 *
 * `user.warn` and `user.suspend` are separate capabilities so a triage helper can
 * exist who tells somebody to stop and cannot lock them out. Rendering a button
 * the server will 403 is the "UI shows a button the API rejects" drift that
 * `src/authz.js` exists to prevent. This is UX only — the server re-checks both.
 */

/** The floor the server enforces on both reasons, mirrored so the refusal is early. */
const MIN_REASON = 10;

export default function SubjectActions({ subject, user, onDone, addToast }) {
  const [open, setOpen] = useState(null);              // 'warn' | 'suspend' | null
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const mayWarn = can(user, 'user.warn');
  const maySuspend = can(user, 'user.suspend');

  /**
   * Nothing to act on, so nothing is offered.
   *
   * `subject` is null when the report is about content whose author is gone, or
   * about a thing rather than a person (an event, a certificate). The server
   * deliberately does not fall back to the reporter here — that fallback exists
   * for the audit trail's foreign key, and using it would offer a moderator a
   * "warn this person" button pointed at the child who filed the report.
   */
  if (!subject) return null;
  if (!mayWarn && !maySuspend) return null;

  const alreadySuspended = subject.accountStatus === 'suspended';

  const close = () => { setOpen(null); setReason(''); setUntil(''); setError(null); };

  const submit = async (e) => {
    e.preventDefault();
    if (reason.trim().length < MIN_REASON) {
      setError(`Say what this is about, in at least ${MIN_REASON} characters. `
        + 'These words are shown to the person.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (open === 'warn') {
        await api.warnUser(subject.id, reason.trim());
        addToast?.(`${subject.name} has been warned and told why.`, 'success');
      } else {
        /**
         * A date input gives `YYYY-MM-DD`, which `new Date()` reads as UTC
         * MIDNIGHT — i.e. the suspension would end at the start of the chosen day
         * rather than the end of it, cutting it a day short in most of the world.
         * Sent as the end of that day instead, so "until the 14th" includes it.
         */
        const untilIso = until
          ? new Date(`${until}T23:59:59`).toISOString()
          : null;
        await api.suspendUser(subject.id, { reason: reason.trim(), until: untilIso });
        addToast?.(
          untilIso
            ? `${subject.name} is suspended until ${new Date(untilIso).toLocaleDateString()}.`
            : `${subject.name} is suspended with no end date.`,
          'success',
        );
      }
      close();
      onDone?.();
    } catch (err) {
      // Kept open with the text intact. The refusals that actually happen here —
      // a short reason, a past date, an admin acting on another admin — are all
      // recoverable, and losing what was typed is the worst response to each.
      setError(err?.message || 'That did not go through. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-xs">
      <div className="small strong">This report is about {subject.name}</div>

      {alreadySuspended && (
        <p className="small dim">
          Their account is already suspended
          {subject.suspendedUntil
            ? `, until ${new Date(subject.suspendedUntil).toLocaleDateString()}.`
            : ', with no end date.'}
        </p>
      )}

      {!open && (
        <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
          {mayWarn && (
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen('warn')}>
              <MessageSquareWarning size={14} aria-hidden="true" /> Warn them
            </button>
          )}
          {maySuspend && !alreadySuspended && (
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen('suspend')}>
              <UserX size={14} aria-hidden="true" /> Suspend
            </button>
          )}
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="stack-xs">
          {error && (
            <div className="alert alert-danger" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label className="strong small" htmlFor="subject-action-reason">
              {open === 'warn'
                ? 'What are you warning them about?'
                : 'Why are you suspending them?'}
            </label>
            <textarea
              id="subject-action-reason"
              className="input"
              rows={3}
              value={reason}
              onChange={(e) => { setReason(e.target.value); if (error) setError(null); }}
              placeholder="Written to the person, in words they will read."
              aria-describedby="subject-action-hint"
              maxLength={1000}
              disabled={busy}
              autoFocus
            />
            {/* Says who reads it, because that changes how it should be written —
                this text is shown to the person verbatim, not just filed. */}
            <p className="small dim" id="subject-action-hint">
              {subject.name} is shown these words.
              {open === 'suspend' && ' It is also what an appeal is reviewed against.'}
            </p>
          </div>

          {open === 'suspend' && (
            <div className="field">
              <label className="strong small" htmlFor="subject-action-until">
                Until (optional)
              </label>
              <input
                id="subject-action-until"
                type="date"
                className="input"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                disabled={busy}
              />
              {/* States the consequence of leaving it blank, rather than letting
                  an empty field quietly mean "for ever". */}
              <p className="small dim">
                {until
                  ? 'They can sign in again from this date, without anybody having to lift it.'
                  : 'Leave this empty for a suspension with no end date — it stays until an '
                    + 'administrator lifts it.'}
              </p>
            </div>
          )}

          <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className={open === 'warn' ? 'btn btn-primary btn-sm' : 'btn btn-danger btn-sm'}
              disabled={busy || reason.trim().length < MIN_REASON}
            >
              {busy
                ? 'Saving…'
                : open === 'warn' ? 'Issue the warning' : 'Suspend this account'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
