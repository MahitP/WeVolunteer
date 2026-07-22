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

export default function ApplicantReview({ applications, onDecide, onBulkDecide, onViewVolunteer, busy }) {
  const [sortKey, setSortKey] = useState('fewestHours');
  const [selectedIds, setSelectedIds] = useState(new Set());

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

      {selectedIds.size > 0 && onBulkDecide && (
        <div className="card row-between" style={{ backgroundColor: 'var(--brand-tint)', padding: 'var(--s2) var(--s4)', marginBottom: 'var(--s3)', borderRadius: 8 }}>
          <span className="small strong" style={{ color: 'var(--brand-shade)' }}>
            {selectedIds.size} volunteer{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <button 
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => {
                onBulkDecide(Array.from(selectedIds), 'accepted');
                setSelectedIds(new Set());
              }}
            >
              <Check size={14} /> Accept all
            </button>
            <button 
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                onBulkDecide(Array.from(selectedIds), 'waitlisted');
                setSelectedIds(new Set());
              }}
            >
              <Clock4 size={14} /> Waitlist all
            </button>
            <button 
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() => {
                onBulkDecide(Array.from(selectedIds), 'rejected');
                setSelectedIds(new Set());
              }}
            >
              <Ban size={14} /> Reject all
            </button>
          </div>
        </div>
      )}

      {onBulkDecide && (
        <div className="toolbar" style={{ marginBottom: 'var(--s3)', background: 'var(--surface)', padding: 'var(--s2) var(--s4)', borderRadius: 8, border: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <input 
            type="checkbox"
            checked={selectedIds.size === sorted.length && sorted.length > 0}
            onChange={e => {
              if (e.target.checked) {
                setSelectedIds(new Set(sorted.map(a => a.id)));
              } else {
                setSelectedIds(new Set());
              }
            }}
            style={{ accentColor: 'var(--brand)', width: 16, height: 16, cursor: 'pointer' }}
          />
          <span className="small dim">Select all {sorted.length} volunteers</span>
        </div>
      )}

      <div className="list">
        {sorted.map(app => {
          const v = app.volunteer || {};
          const isNew = (v.completedEvents || 0) === 0;
          const isSelected = selectedIds.has(app.id);
          
          return (
            <div key={app.id} className={`list-row ${isSelected ? 'selected' : ''}`} style={isSelected ? { backgroundColor: 'var(--brand-tint)' } : {}}>
              {onBulkDecide && (
                <input 
                  type="checkbox"
                  checked={isSelected}
                  onChange={e => {
                    const next = new Set(selectedIds);
                    if (e.target.checked) next.add(app.id);
                    else next.delete(app.id);
                    setSelectedIds(next);
                  }}
                  style={{ accentColor: 'var(--brand)', width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                />
              )}
              
              <button
                className="person"
                style={{ flex: 1, minWidth: 150 }}
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
              
              <div className="small truncate" style={{ flexShrink: 0, width: 100 }}>{app.slot?.name}</div>
              
              <div style={{ flexShrink: 0, width: 90 }}>
                <span className={`hourspill ${!v.volunteeredHours ? 'zero' : ''}`}>
                  {formatHours(v.volunteeredHours)}
                </span>
              </div>
              
              <div style={{ flexShrink: 0, width: 120 }}>
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
              </div>
              
              <div className="small dim tnum" style={{ flexShrink: 0, width: 70 }}>
                {formatDay(app.appliedAt)}
              </div>
              
              {onDecide && (
                <div className="row" style={{ gap: 4, flexShrink: 0 }}>
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
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
