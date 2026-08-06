import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../utils/api';
import Modal, { ModalHead } from '../Modal';
import { groupedCategoriesFor, MAX_DESCRIPTION_LENGTH } from '../../moderation';

/**
 * Report a conversation to the moderators.
 *
 * ── The bug that mattered ──
 *
 * The reason dropdown offered `spam · harassment · inappropriate · other`. The
 * server accepted `inappropriate · spam · safety · other` — enforced twice, in
 * the route and by a CHECK constraint. So "Harassment or bullying", the reason a
 * student is most likely to reach for, was rejected with 400 every time, and the
 * only error handling was `console.error(err)` followed by re-enabling the
 * button. A student reporting harassment pressed Submit, saw the button come
 * back, and was told nothing whatsoever. The report was never filed and they had
 * no way to know. `safety` — the most serious of the four — was not offered at
 * all.
 *
 * ── Why it now offers eighteen ──
 *
 * The four-value enum was replaced by a taxonomy written in students' own words,
 * imported from `server/moderation.js` through `src/moderation.js` rather than
 * retyped here. That import is the actual fix: the reason this dialog was broken
 * for as long as it was is that its list and the server's list were two lists.
 *
 * A conversation is the surface where the safety categories belong, so it offers
 * all of them — the ones naming a specific danger are exactly the ones a private
 * message thread is where they happen.
 *
 * ── Why it moved to the shared Modal ──
 *
 * It was the last hand-rolled overlay in the app with no dialog semantics at all:
 * no `role="dialog"`, no `aria-modal`, no Escape, no focus containment, no focus
 * restore, no scroll lock. On a safety surface, reachable by someone who is
 * upset and may be on a keyboard or a screen reader, that is the wrong place to
 * be missing all of it.
 */
export default function ReportModal({ conversationId, onClose }) {
  const [category, setCategory] = useState('');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(null);

  const groups = useMemo(() => groupedCategoriesFor('conversation'), []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!category) {
      setError('Choose what is happening, so a moderator knows what to look at.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // The route takes the category in `reason` and still understands the four
      // legacy values, so an older build in a tab somebody left open keeps working.
      await api.reportConversation(conversationId, category, details.trim());
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
            description="Thank you. A moderator will review this conversation, including the messages in it."
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
                    value={category}
                    onChange={(e) => { setCategory(e.target.value); if (error) setError(null); }}
                    aria-describedby="report-reason-hint"
                    required
                    disabled={submitting}
                  >
                    <option value="">Choose one…</option>
                    {groups.map(group => (
                      <optgroup key={group.key} label={group.label}>
                        {group.options.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <p className="small dim" id="report-reason-hint">
                    If a conversation makes you uneasy and you cannot say exactly why, that is
                    reason enough — pick “Something feels wrong and I can’t explain why”.
                  </p>
                </div>

                <div className="field">
                  <label className="strong small" htmlFor="report-details">
                    Anything else a moderator should know? <span className="dim">(optional)</span>
                  </label>
                  <textarea
                    id="report-details"
                    className="input"
                    rows={4}
                    value={details}
                    onChange={(e) => setDetails(e.target.value)}
                    placeholder="Optional. A sentence is enough."
                    aria-describedby="report-details-hint"
                    maxLength={MAX_DESCRIPTION_LENGTH}
                    disabled={submitting}
                  />
                  <p className="small dim" id="report-details-hint">
                    If someone is in immediate danger, call <strong>911</strong>. To report abuse in
                    New Jersey, call <strong>1-877-NJ-ABUSE</strong> (1-877-652-2873) — they take
                    anonymous calls, 24 hours. Do not wait for a moderator.
                  </p>
                </div>
              </div>
            </div>

            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="btn btn-danger" disabled={submitting || !category}>
                {submitting ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}
