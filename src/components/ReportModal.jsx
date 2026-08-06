import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../utils/api';
import Modal, { ModalHead } from './Modal';
import { groupedCategoriesFor, normalizeTargetType, MAX_DESCRIPTION_LENGTH } from '../moderation';

/**
 * What to call the thing being reported, in the dialog's own copy.
 *
 * Keyed by the NORMALISED target type, so the `organizer` alias resolves through
 * the shared map rather than being compared here. That is not only tidier: the
 * client-side role-string guard reads `targetType === 'organizer'` as a
 * role-name comparison — correctly, since it cannot tell a target type from a
 * role by looking — and the right answer to a guard that broad is to stop
 * writing the string, not to declare an exception to it.
 */
const TARGET_NOUNS = {
  event: 'event',
  comment: 'comment',
  announcement: 'announcement',
  message: 'message',
  conversation: 'conversation',
  user: 'person',
  certificate: 'certificate',
};

/**
 * Report something to the moderators.
 *
 * ── Why this was rebuilt, twice ──
 *
 * The first rebuild was cosmetic and accessibility: it referenced four class
 * names that do not exist anywhere in index.css, so the dialog rendered with no
 * backdrop, no panel, no centring and no width constraint, and it was the last
 * hand-rolled overlay in the app — no Escape, no focus containment, no focus
 * restore, no scroll lock, no `role="dialog"`. Going through `Modal`/`ModalHead`
 * fixed both at once.
 *
 * This rebuild is about what the dialog actually sends. The unified reporting
 * model replaced a free-text `reason` with a category from a fixed taxonomy —
 * eighteen options written in a student's own words, each deriving a priority
 * that decides whether a moderator looks at it today or tomorrow. This component
 * kept sending prose. The server maps prose onto `other` rather than refusing it,
 * which is why nothing was visibly broken, and it is also why the whole thing was
 * invisible: every report of an event or a comment arrived uncategorised and at
 * normal priority, including the ones that were not.
 *
 * So the categories are offered here, filtered to the ones that make sense for
 * what is being reported, and the free text stays — as `description`, which is
 * what it always was. Nothing a student types is discarded.
 *
 * ── The category is required, the description is not ──
 *
 * Deliberately that way round. The Youth Safety Guidelines say "You do not need
 * proof. You do not need to be sure." Requiring prose is a barrier at the exact
 * moment it costs the most, and `something_feels_wrong` — "Something feels wrong
 * and I can't explain why" — exists to be pickable by somebody who cannot yet
 * put it into words. Tapping one option and pressing send is a complete report.
 */
export default function ReportModal({ targetType, targetId, onClose, addToast }) {
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const noun = TARGET_NOUNS[normalizeTargetType(targetType)] ?? 'content';

  /**
   * The offer is filtered by what is being reported: an event listing cannot
   * itself ask you to meet alone, and putting that option on an event report
   * makes the list longer and less scannable at no benefit. UI only — the server
   * accepts any valid category for any valid target, on purpose.
   */
  const groups = useMemo(() => groupedCategoriesFor(targetType), [targetType]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!category) {
      setError('Choose what is wrong, so a moderator knows what they are looking at.');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await api.submitReport({
        targetType,
        targetId,
        // `reason` carries the category: it is the field the endpoint has always
        // taken, and a taxonomy value is recognised there and stored as one.
        reason: category,
        details: description.trim() || undefined,
      });
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
          + 'The person you report is never told who reported them.'}
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
              <label className="strong small" htmlFor="report-category">
                What is wrong?
              </label>
              {/* Grouped rather than flat: eighteen options in one list is not
                  something anybody reads, least of all somebody upset enough to
                  be filing a report. */}
              <select
                id="report-category"
                className="select"
                value={category}
                onChange={(e) => { setCategory(e.target.value); if (error) setError(null); }}
                aria-describedby="report-category-hint"
                required
                autoFocus
                disabled={isSubmitting}
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
              <p className="small dim" id="report-category-hint">
                If none of these fit, choose “Something else” and tell us below.
              </p>
            </div>

            <div className="field">
              <label className="strong small" htmlFor="report-description">
                Anything else a moderator should know? <span className="dim">(optional)</span>
              </label>
              <textarea
                id="report-description"
                className="input"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional. A sentence is enough — you do not need proof, and you do not need to be sure."
                aria-describedby="report-description-hint"
                maxLength={MAX_DESCRIPTION_LENGTH}
                disabled={isSubmitting}
              />
              {/* WeVolunteer is an independent platform, not a school district
                  service — the Organizer Agreement §1 says so in terms. This
                  previously read "contact your school directly", which sent a
                  student in danger to an organisation that does not run this
                  platform, cannot see this report, and has no power to act on
                  it. The correct answers are the emergency number and the New
                  Jersey hotline, both of which the Youth Safety Guidelines
                  already publish. */}
              <p className="small dim" id="report-description-hint">
                If someone is in immediate danger, call <strong>911</strong>.
                To report abuse in New Jersey, call <strong>1-877-NJ-ABUSE</strong> (1-877-652-2873) —
                they take anonymous calls, 24 hours. Do not wait for a moderator.
              </p>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          {/* btn-danger, not the non-existent btn-error this used to ask for. */}
          <button type="submit" className="btn btn-danger" disabled={isSubmitting || !category}>
            {isSubmitting ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
