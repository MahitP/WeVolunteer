import { useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { api } from '../utils/api';
export default function ReportModal({
  targetType,
  targetId,
  onClose,
  addToast
}) {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const handleSubmit = async e => {
    e.preventDefault();
    if (!reason.trim()) return;
    setIsSubmitting(true);
    try {
      await api.submitReport({
        targetType,
        targetId,
        reason: reason.trim()
      });
      addToast('Report submitted successfully. Thank you.', 'success');
      onClose();
    } catch (err) {
      console.error(err);
      // apiFetch throws a plain Error whose message is the server's error text.
      addToast(err.message || 'Failed to submit report', 'error');
      setIsSubmitting(false);
    }
  };
  return <div className="modal-backdrop">
      <div className="modal-content s-2383b5">
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={24} />
        </button>

        <div className="stack-lg">
          <div className="stack-sm">
            <h2 className="s-a9d228">
              <AlertTriangle size={24} />
              Report {targetType === 'event' ? 'Event' : 'Comment'}
            </h2>
            <p className="dim">
              Our moderation team will review this {targetType} for violations of our community guidelines.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="stack-md">
            <div className="form-group">
              <label htmlFor="report-reason">Please describe the issue:</label>
              <textarea id="report-reason" className="input" rows={4} value={reason} onChange={e => setReason(e.target.value)} placeholder="E.g., Inappropriate content, spam, etc." required autoFocus />
            </div>

            <div className="row s-0ed3ee">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </button>
              <button type="submit" className="btn btn-error" disabled={isSubmitting || !reason.trim()}>
                {isSubmitting ? 'Submitting...' : 'Submit Report'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>;
}