import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../utils/api';
import Modal, { ModalHead } from '../Modal';

/**
 * Report a conversation to the moderators.
 *
 * ── The bug that mattered ──
 *
 * The reason dropdown offered `spam · harassment · inappropriate · other`. The
 * server accepts `inappropriate · spam · safety · other` — enforced twice, in the
 * route and by a CHECK constraint on `conversation_reports.reason`. So
 * "Harassment or bullying", the reason a student is most likely to reach for, was
 * rejected with 400 every time.
 *
 * And the only error handling was `console.error(err)` followed by re-enabling
 * the button. A student reporting harassment pressed Submit, saw the button come
 * back, and was told nothing whatsoever. The report was never filed and they had
 * no way to know. `safety` — the most serious of the four — was not offered at
 * all.
 *
 * The options are now exactly the server's set, so nothing offered can be
 * refused, and a failure is shown inline and announced rather than logged to a
 * console nobody has open.
 *
 * ── Why it moved to the shared Modal ──
 *
 * It was the last hand-rolled overlay in the app with no dialog semantics at all:
 * no `role="dialog"`, no `aria-modal`, no Escape, no focus containment, no focus
 * restore, no scroll lock. On a safety surface, reachable by someone who is
 * upset and may be on a keyboard or a screen reader, that is the wrong place to
 * be missing all of it.
 */

/**
 * Kept deliberately in lockstep with the server's accepted set
 * (server/routes/messageRoutes.js and the CHECK on conversation_reports.reason).
 * A value here that is not there fails with a 400 the user cannot act on.
 */
const REASONS = [
  { value: 'safety', label: 'Someone may be unsafe' },
  { value: 'inappropriate', label: 'Inappropriate or abusive content' },
  { value: 'spam', label: 'Spam or unwanted advertising' },
  { value: 'other', label: 'Something else' }
];

export default function ReportModal({ conversationId, onClose }) {
  const [reason, setReason] = useState('safety');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.reportConversation(conversationId, reason, details, []);
      setSuccess(true);
    } catch (err) {
      setError(err.message || 'Could not send the report. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      onClose={submitting ? () => {} : onClose}
      label="Report this conversation"
      className="report-modal"
    >
      {success ? (
        <>
          <ModalHead
            title="Report sent"
            description="Thank you. A moderator will review this conversation."
            onClose={onClose}
          />
          <div className="modal-foot">
            <button className="btn btn-primary" onClick={onClose}>Close</button>
          </div>
        </>
      ) : (
        <>
          <ModalHead
            title="Report this conversation"
            description="A moderator will review the messages in this conversation. The other person is not told that you reported it."
            onClose={onClose}
          />

          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              <div className="stack-md">
                {error && (
                  <div className="alert alert-danger" role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                )}

                <div className="field">
                  {/* htmlFor/id: the labels here were associated with nothing, so
                      clicking them did nothing and a screen reader announced an
                      unlabelled select and textarea. */}
                  <label className="strong small" htmlFor="report-reason">
                    What is happening?
                  </label>
                  <select
                    id="report-reason"
                    className="select"
                    value={reason}
                    onChange={(e) => { setReason(e.target.value); if (error) setError(null); }}
                  >
                    {REASONS.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="strong small" htmlFor="report-details">
                    Anything else a moderator should know?
                  </label>
                  <textarea
                    id="report-details"
                    className="input"
                    rows={4}
                    value={details}
                    onChange={(e) => setDetails(e.target.value)}
                    placeholder="Optional. A sentence is enough."
                    aria-describedby="report-details-hint"
                    maxLength={1000}
                  />
                  <p className="small dim" id="report-details-hint">
                    If someone is in immediate danger, tell a teacher or call your local
                    emergency number rather than waiting for a moderator.
                  </p>
                </div>
              </div>
            </div>

            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="btn btn-danger" disabled={submitting}>
                {submitting ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}
