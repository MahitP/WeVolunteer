import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal, { ModalHead } from './Modal';
import { REPORT_RESOLUTIONS } from '../moderation';

/**
 * Closing a report, with what was done and why.
 *
 * ── Why a note is required, and why it is twenty characters ──
 *
 * The note is what an appeal is reviewed against. Community Guidelines promises
 * an appellant the outcome and the reason, and a suspension is contestable years
 * later — at which point "ok" is not something anybody can review a decision
 * against. The threshold mirrors `MIN_SUSPENSION_REASON`, which exists for the
 * same reason on the same kind of decision.
 *
 * The server enforces this independently and always will; the check here is so a
 * moderator finds out before they press the button rather than after.
 *
 * ── What this component got wrong ──
 *
 * It offered four of the seven resolutions. `warning_issued`, `account_removed`
 * and `duplicate` were unreachable, so a moderator who had issued a warning had
 * to record it as something else — and `duplicate` in particular is the outcome
 * the system itself produces when it folds a repeat report, so the queue could
 * hold a resolution the UI could not express.
 *
 * And a refusal from the server closed the dialog anyway, discarding the note
 * the moderator had just written. The two refusals that actually happen here —
 * a note one character short, and a conflict of interest — are both ones where
 * losing the text is the worst possible response.
 */

/**
 * Written out rather than derived from the stored values, because `no_action`
 * un-snake-cased is "no action", which reads as a shrug where the list needs to
 * read as a decision. Keyed by the server's enum, so a resolution added there and
 * not here falls back to something legible rather than disappearing.
 */
const RESOLUTION_LABELS = {
  no_action: 'No action needed — reviewed, nothing to act on',
  content_removed: 'Content removed',
  warning_issued: 'Warning issued to the person reported',
  account_suspended: 'Account suspended',
  account_removed: 'Account removed',
  escalated_offline: 'Escalated off-platform (school, district, or authorities)',
  duplicate: 'Duplicate of another report',
};

const MIN_NOTE = 20;

export default function ResolutionModal({ report, onClose, onSubmit, isSubmitting }) {
  const [resolution, setResolution] = useState('no_action');
  const [resolutionNote, setResolutionNote] = useState('');
  const [error, setError] = useState(null);

  const closing = report.status === 'dismissed' ? 'Dismiss' : 'Resolve';
  const remaining = MIN_NOTE - resolutionNote.trim().length;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (resolutionNote.trim().length < MIN_NOTE) {
      setError(`Say what was decided and why, in at least ${MIN_NOTE} characters. `
        + 'This is what an appeal is reviewed against.');
      return;
    }
    setError(null);
    try {
      await onSubmit(report.id, report.status, resolution, resolutionNote.trim());
    } catch (err) {
      // Kept open, with the note intact. A conflict of interest and a too-short
      // note are both recoverable, and both were previously answered by closing
      // the dialog and throwing the text away.
      setError(err?.message || 'Could not update the report. Please try again.');
    }
  };

  return (
    <Modal
      onClose={isSubmitting ? () => {} : onClose}
      label={`${closing} report`}
      className="modal-report"
    >
      <ModalHead
        title={`${closing} this report`}
        description="Record what was done and why. This is kept permanently and is what an appeal is reviewed against."
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
              <label className="strong small" htmlFor="resolution">
                What was done?
              </label>
              <select
                id="resolution"
                className="select"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                disabled={isSubmitting}
              >
                {/* Driven by the server's enum, so the two cannot fall out of
                    step the way the hand-written four-item list did. */}
                {REPORT_RESOLUTIONS.map(value => (
                  <option key={value} value={value}>
                    {RESOLUTION_LABELS[value] ?? value.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="strong small" htmlFor="resolutionNote">
                Why?
              </label>
              <textarea
                id="resolutionNote"
                className="input"
                rows={4}
                value={resolutionNote}
                onChange={(e) => { setResolutionNote(e.target.value); if (error) setError(null); }}
                placeholder="What you found, what you decided, and anything the next person needs to know."
                aria-describedby="resolution-note-hint"
                maxLength={1000}
                required
                disabled={isSubmitting}
                autoFocus
              />
              {/* Counts down rather than up, so the requirement is legible before
                  it is met rather than only after it is missed. */}
              <p className="small dim" id="resolution-note-hint">
                {remaining > 0
                  ? `${remaining} more character${remaining === 1 ? '' : 's'} needed.`
                  : 'An appeal is reviewed against this note.'}
              </p>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting || resolutionNote.trim().length < MIN_NOTE}
          >
            {isSubmitting ? 'Saving…' : `${closing} report`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
