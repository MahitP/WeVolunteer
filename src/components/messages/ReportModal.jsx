import React, { useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../utils/api';

export default function ReportModal({ conversationId, onClose }) {
  const [reason, setReason] = useState('spam');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.reportConversation(conversationId, reason, details, []);
      setSuccess(true);
    } catch (err) {
      console.error(err);
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal report-modal">
        <div className="modal-header">
          <h3>Report Conversation</h3>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {success ? (
          <div className="modal-body text-center">
            <p className="mb-4">Thank you for your report. Our team will review this conversation shortly.</p>
            <button className="btn btn-primary" onClick={onClose}>Close</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              <div className="form-group">
                <label>Reason for reporting</label>
                <select value={reason} onChange={(e) => setReason(e.target.value)} className="form-input">
                  <option value="spam">Spam or unwanted advertising</option>
                  <option value="harassment">Harassment or bullying</option>
                  <option value="inappropriate">Inappropriate content</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="form-group mt-3">
                <label>Additional details</label>
                <textarea 
                  className="form-input" 
                  rows="4" 
                  value={details} 
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder="Please provide any additional context..."
                ></textarea>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-danger-solid" disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
