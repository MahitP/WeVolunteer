import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../utils/api';
import Modal, { ModalHead } from './Modal';

/**
 * Report an event or a comment to the moderators.
 *
 * ── Why this was rebuilt rather than nudged ──
 *
 * It was not a styling problem. The component referenced four class names that
 * do not exist anywhere in index.css — `.modal-backdrop`, `.modal-content`,
 * `.btn-error` and `.stack-md` — plus three generated `s-*` classes that also
 * had no rules behind them. The app's dialog classes are `.modal-overlay` and
 * `.modal`, and its destructive button is `.btn-danger`. So this dialog rendered
 * with no backdrop, no panel, no centring, no width constraint, and a submit
 * button drawn as a bare browser default. It looked unfinished because
 * essentially none of it was styled.
 *
 * It was also the last hand-rolled overlay in the app, which meant no Escape, no
 * focus containment, no focus restore, no scroll lock and no `role="dialog"` — on
 * a safety surface, where the person using it may well be upset and may be on a
 * keyboard or a screen reader. Going through `Modal`/`ModalHead` fixes the
 * appearance and the accessibility in one move, because both come from the shell
 * every other dialog already uses.
 *
 * The reporting behaviour is deliberately unchanged: same endpoint, same payload,
 * same props, same success toast. What is added is an inline, announced error —
 * previously a failure produced only a transient toast, so someone who looked
 * away learned nothing and pressed the button again.
 */
export default function ReportModal({ targetType, targetId, onClose, addToast }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const noun = targetType === 'event' ? 'event' : 'comment';
  const trimmed = reason.trim();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!trimmed) {
      setError('Tell us briefly what is wrong, so a moderator knows what to look at.');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await api.submitReport({ targetType, targetId, reason: trimmed });
      addToast('Report submitted. Thank you — a moderator will review it.', 'success');
      onClose();
    } catch (err) {
      // apiFetch throws an Error whose message is the server's error text.
      setError(err.message || 'Could not submit the report. Please try again.');
      addToast(err.message || 'Could not submit the report.', 'error');
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      onClose={isSubmitting ? () => {} : onClose}
      label={`Report this ${noun}`}
      className="modal-report"
    >
      <ModalHead
        title={`Report this ${noun}`}
        description={`A moderator will review this ${noun} against the community guidelines. `
          + 'Reports are not shown to the person who posted it.'}
        onClose={onClose}
      />

      <form onSubmit={handleSubmit}>
        <div className="modal-body">
          <div className="stack-md">
            {/* role="alert" so a failure is announced rather than only flashing
                past in a toast. */}
            {error && (
              <div className="alert alert-danger" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <div className="field">
              <label className="strong small" htmlFor="report-reason">
                What is wrong with this {noun}?
              </label>
              <textarea
                id="report-reason"
                className="input"
                rows={4}
                value={reason}
                onChange={(e) => { setReason(e.target.value); if (error) setError(null); }}
                placeholder={targetType === 'event'
                  ? 'For example: the details are misleading, or this is not a real volunteering opportunity.'
                  : 'For example: this comment is abusive, or it contains personal information.'}
                aria-describedby="report-reason-hint"
                maxLength={1000}
                autoFocus
              />
              <p className="small dim" id="report-reason-hint">
                A sentence is enough. If someone is in immediate danger, contact your school
                directly rather than waiting for a moderator.
              </p>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          {/* btn-danger, not the non-existent btn-error this used to ask for. */}
          <button type="submit" className="btn btn-danger" disabled={isSubmitting || !trimmed}>
            {isSubmitting ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
