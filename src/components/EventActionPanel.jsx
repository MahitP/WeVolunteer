import React from 'react';
import { ArrowRight, CheckCircle, Clock } from 'lucide-react';
import './EventActionPanel.css';
import { countdown } from '../utils/helpers';

export default function EventActionPanel({ 
  event, 
  currentUser, 
  iAmConfirmed, 
  myApps, 
  signupsClosed,
  onApplyClick 
}) {
  const isStudent = currentUser?.role === 'student';
  const hasApplied = myApps.length > 0;
  
  if (!isStudent) return null;

  const renderStatus = () => {
    if (iAmConfirmed) {
      return (
        <div className="action-panel-status status-success">
          <CheckCircle size={20} />
          <div className="status-text">
            <strong>Confirmed</strong>
            <span>You are scheduled for this event.</span>
          </div>
        </div>
      );
    }
    if (hasApplied) {
      return (
        <div className="action-panel-status status-pending">
          <Clock size={20} />
          <div className="status-text">
            <strong>Pending</strong>
            <span>Your application is under review.</span>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="event-action-panel">
      <div className="action-panel-card">
        {renderStatus()}
        
        {!signupsClosed && !iAmConfirmed && (
          <div className="action-panel-apply">
            <h3 className="action-panel-title">Ready to volunteer?</h3>
            <p className="action-panel-desc">Select your preferred shifts to apply.</p>
            <button 
              className="btn btn-primary btn-lg action-panel-btn" 
              onClick={onApplyClick}
            >
              Choose Shifts <ArrowRight size={16} />
            </button>
            <div className="action-panel-meta">
              Closes {countdown(event.applicationDeadline)}
            </div>
          </div>
        )}

        {signupsClosed && !hasApplied && (
          <div className="action-panel-closed">
            Applications are currently closed for this event.
          </div>
        )}
      </div>
    </div>
  );
}
