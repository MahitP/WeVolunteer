import React, { useState } from 'react';
import { AlertTriangle, UserX, UserCheck, MessageSquareWarning, MessageSquare } from 'lucide-react';
import { api } from '../../utils/api';
import { can } from '../../authz';
import DatePicker from '../common/DatePicker';

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
  const [open, setOpen] = useState(null);   // 'warn' | 'suspend' | 'unsuspend' | null
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const mayWarn = can(user, 'user.warn');
  const maySuspend = can(user, 'user.suspend');
  /**
   * `report.resolve`, matching the endpoint's gate — NOT `message.send`.
   *
   * Taking part in a conversation is one thing; choosing an arbitrary person by id
   * to start one with is a moderation power. An organizer holds `message.send` and
   * must not reach a stranger through it, so the server gates the resolve on the
   * moderation capability and this mirrors it. Asking `message.send` here would
   * render a button that 403s for exactly the role most likely to press it.
   */
  const mayMessage = can(user, 'report.resolve');

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
  if (!mayWarn && !maySuspend && !mayMessage) return null;

  const alreadySuspended = subject.accountStatus === 'suspended';

  const close = () => { setOpen(null); setReason(''); setUntil(''); setError(null); };

  /**
   * Opens the thread and sends the moderator to it.
   *
   * A full navigation rather than an inline composer: the conversation lives in
   * `/messages`, with its own history, unread state and realtime updates, and a
   * second place to type into the same thread is a second thing to keep correct.
   * The resolve is idempotent, so arriving here twice reopens rather than splits.
   */
  const message = async () => {
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await api.resolveAdminConversation(subject.id);
      window.location.assign(`/messages?conversation=${encodeURIComponent(conversation.id)}`);
    } catch (err) {
      setError(err?.message || 'Could not open a conversation with this person.');
      setBusy(false);
    }
  };

  /**
   * Lifting a suspension needs no reason, and that is the endpoint's rule rather
   * than a shortcut taken here: `POST /unsuspend` treats the note as optional
   * because the asymmetry is deliberate. Imposing a sanction has to be justified —
   * the person is told why and an appeal is reviewed against it. Removing one does
   * not, and requiring twenty characters before somebody can undo their own
   * mistake is friction pointed the wrong way.
   */
  const reasonOptional = open === 'unsuspend';

  const submit = async (e) => {
    e.preventDefault();
    if (!reasonOptional && reason.trim().length < MIN_REASON) {
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
      } else if (open === 'unsuspend') {
        await api.unsuspendUser(subject.id, reason.trim() || undefined);
        addToast?.(`${subject.name} can sign in again.`, 'success');
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

      {/* Rendered outside the form, because "Message them" can fail with no form
          open — and an error shown only inside a block that is not mounted is an
          error nobody sees. */}
      {error && !open && (
        <div className="alert alert-danger" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {!open && (
        <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
          {mayMessage && (
            /**
             * Offered FIRST, and before the two enforcement actions, because it is
             * usually the right first step: most reports are resolved by asking
             * somebody what happened, and a moderator who can only warn or suspend
             * will warn or suspend.
             */
            <button className="btn btn-ghost btn-sm" onClick={message} disabled={busy}>
              <MessageSquare size={14} aria-hidden="true" />
              {busy && open === null ? 'Opening…' : 'Message them'}
            </button>
          )}
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
          {/**
            * The way back.
            *
            * `unsuspendUser` existed but was reachable only from `AdminAppeals`,
            * i.e. only by the person appealing. An administrator who suspended the
            * wrong account, or changed their mind, had no route to reverse it and
            * had to wait for the student to appeal something the administrator
            * already knew was wrong.
            */}
          {maySuspend && alreadySuspended && (
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen('unsuspend')}>
              <UserCheck size={14} aria-hidden="true" /> Lift the suspension
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
              {open === 'warn' ? 'What are you warning them about?'
                : open === 'unsuspend' ? 'Anything to tell them? (optional)'
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
              {open === 'unsuspend'
                && ' They are told their account works again either way — this just adds context.'}
            </p>
          </div>

          {open === 'suspend' && (
            <div className="field">
              <label className="strong small" htmlFor="subject-action-until">
                Until (optional)
              </label>
              {/*
                `DatePicker`, not `<input type="date">`, so the one date control
                in the moderation flow matches the rest of the product and reads
                correctly in dark mode — this panel is opened from a dialog over
                a dark surface, which is where the native picker's light chrome
                was most obvious.

                Still deliberately unbounded. The server refuses a date in the
                past and says so, and that refusal is the one worth keeping:
                pinning `min` to today here would silently move a mistyped 2025
                to 2026 in the reader's mind, when what a moderator needs to see
                is that the date they chose is not a suspension at all. The
                message is shown above and the typed text survives it.
              */}
              <DatePicker
                id="subject-action-until"
                value={until}
                onChange={setUntil}
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
              className={open === 'suspend' ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm'}
              disabled={busy || (!reasonOptional && reason.trim().length < MIN_REASON)}
            >
              {busy ? 'Saving…'
                : open === 'warn' ? 'Issue the warning'
                  : open === 'unsuspend' ? 'Lift the suspension'
                    : 'Suspend this account'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
