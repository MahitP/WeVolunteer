import React, { useState, useMemo } from 'react';
import { Check, Clock4, Ban, ArrowUpDown, Sparkles } from 'lucide-react';
import { formatHours, formatDay, gradeLabel } from '../utils/helpers';

/**
 * The screen where an organizer decides who gets a spot.
 *
 * Everything shown is decision-relevant: how many hours someone already has,
 * how many events they've completed, and when they last volunteered. Sorting
 * defaults to fewest hours first because that is the fairness question most
 * school programmes are actually trying to answer — but it is a default, not
 * a rule, and the organizer can re-sort freely.
 */
const SORTS = {
  fewestHours: {
    label: 'Fewest hours first',
    hint: 'Prioritises volunteers who have had the least opportunity so far',
    compare: (a, b) =>
      (a.volunteer?.volunteeredHours || 0) - (b.volunteer?.volunteeredHours || 0) ||
      new Date(a.appliedAt) - new Date(b.appliedAt)
  },
  newest: {
    label: 'New volunteers first',
    hint: 'Students who have not completed an event yet',
    compare: (a, b) =>
      (a.volunteer?.completedEvents || 0) - (b.volunteer?.completedEvents || 0) ||
      new Date(a.appliedAt) - new Date(b.appliedAt)
  },
  experienced: {
    label: 'Most experienced first',
    hint: 'Useful when a shift needs someone who has done it before',
    compare: (a, b) =>
      (b.volunteer?.completedEvents || 0) - (a.volunteer?.completedEvents || 0) ||
      (b.volunteer?.volunteeredHours || 0) - (a.volunteer?.volunteeredHours || 0)
  },
  applied: {
    label: 'Applied earliest first',
    hint: 'Order the applications arrived',
    compare: (a, b) => new Date(a.appliedAt) - new Date(b.appliedAt)
  }
};

export default function ApplicantReview({ applications, onDecide, onViewVolunteer, busy }) {
  const [sortKey, setSortKey] = useState('fewestHours');

  const sorted = useMemo(
    () => [...applications].sort(SORTS[sortKey].compare),
    [applications, sortKey]
  );

  if (applications.length === 0) {
    return (
      <div className="empty" style={{ padding: 'var(--s6) var(--s4)' }}>
        <span className="empty-icon"><Check size={18} /></span>
        <h3>No applications waiting</h3>
        <p>When students apply for a shift, they'll appear here for you to review.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 'var(--s3)' }}>
        <label className="row small" style={{ gap: 6 }}>
          <ArrowUpDown size={14} style={{ color: 'var(--ink-3)' }} />
          <span className="dim nowrap">Order by</span>
          <select
            className="select"
            value={sortKey}
            onChange={e => setSortKey(e.target.value)}
            aria-label="Order applicants by"
          >
            {Object.entries(SORTS).map(([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
        <span className="small dim">{SORTS[sortKey].hint}</span>
      </div>

      <div className="tablewrap">
        <div className="tablescroll">
          <table className="table">
            <thead>
              <tr>
                <th>Volunteer</th>
                <th>Shift</th>
                <th>Hours so far</th>
                <th>Track record</th>
                <th>Applied</th>
                {onDecide && <th className="cell-actions">Decision</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map(app => {
                const v = app.volunteer || {};
                const isNew = (v.completedEvents || 0) === 0;
                return (
                  <tr key={app.id}>
                    <td>
                      <button
                        className="person"
                        style={{ maxWidth: 190 }}
                        onClick={() => onViewVolunteer(v)}
                        title={`View ${v.name}'s profile`}
                      >
                        <span className="avatar sm">{v.avatar || '👤'}</span>
                        <span className="truncate">
                          <span className="person-name truncate">{v.name}</span>
                          <span className="person-meta truncate">
                            {[gradeLabel(v.grade), v.school].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className="small truncate" style={{ maxWidth: 130 }}>{app.slot?.name}</td>
                    <td>
                      <span className={`hourspill ${!v.volunteeredHours ? 'zero' : ''}`}>
                        {formatHours(v.volunteeredHours)}
                      </span>
                    </td>
                    {/* Events completed and recency read together — "3 events,
                        last in March" is one judgement, not two numbers. */}
                    <td>
                      {isNew ? (
                        <span className="tag tag-brand">
                          <Sparkles size={10} /> First event
                        </span>
                      ) : (
                        <>
                          <div className="small tnum">
                            {v.completedEvents} event{v.completedEvents !== 1 ? 's' : ''}
                          </div>
                          <div className="small dim tnum">
                            last {formatDay(v.lastVolunteeredDate)}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="small dim tnum">{formatDay(app.appliedAt)}</td>
                    {onDecide && (
                      <td className="cell-actions">
                        <div className="row" style={{ gap: 4 }}>
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={busy}
                            onClick={() => onDecide(app.id, v.name, 'accepted')}
                          >
                            <Check size={13} /> Accept
                          </button>
                          <button
                            className="btn btn-secondary btn-sm btn-icon"
                            title="Move to waitlist"
                            aria-label={`Waitlist ${v.name}`}
                            disabled={busy}
                            onClick={() => onDecide(app.id, v.name, 'waitlisted')}
                          >
                            <Clock4 size={13} />
                          </button>
                          <button
                            className="btn btn-danger btn-sm btn-icon"
                            title="Reject"
                            aria-label={`Reject ${v.name}`}
                            disabled={busy}
                            onClick={() => onDecide(app.id, v.name, 'rejected')}
                          >
                            <Ban size={13} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
