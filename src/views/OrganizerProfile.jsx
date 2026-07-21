import React, { useEffect, useState } from 'react';
import {
  ShieldCheck, ShieldAlert, ArrowLeft, CalendarClock, Lock, Mail, Award
} from 'lucide-react';
import { api } from '../utils/api';
import { formatHours, formatDay, countdown } from '../utils/helpers';
import { DateChip } from '../components/Seats';

/**
 * The page a student checks before trusting an event.
 *
 * Every figure here is evidence of a track record: how many events this person
 * has actually run, how many volunteers they worked with, and how many hours
 * they have credited. Verification status is stated plainly either way.
 */
export default function OrganizerProfile({ userId, onBack, onViewEvent }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.fetchOrganizerProfile(userId)
      .then(res => { if (!cancelled) setData(res); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) {
    return (
      <div className="stack-lg">
        <div className="skeleton" style={{ height: 130 }} />
        <div className="skeleton" style={{ height: 88 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card empty">
        <span className="empty-icon"><Lock size={18} /></span>
        <h3>Profile unavailable</h3>
        <p>{error || 'This organizer profile could not be loaded.'}</p>
        {onBack && <button className="btn btn-secondary btn-sm" onClick={onBack}>Go back</button>}
      </div>
    );
  }

  const { organizer, stats, upcoming, past } = data;

  const EventRow = ({ event }) => (
    <button
      className="list-row"
      style={{ width: '100%', textAlign: 'left' }}
      onClick={() => onViewEvent?.(event.id)}
    >
      <DateChip iso={event.startDatetime} />
      <span className="truncate" style={{ flex: 1 }}>
        <span className="person-name truncate">{event.title}</span>
        <span className="person-meta truncate">{event.category} · {event.location}</span>
      </span>
      <span className="small dim nowrap tnum">
        {event.accepted}/{event.maxSpots} filled
      </span>
      {event.status === 'cancelled'
        ? <span className="status status-danger">Cancelled</span>
        : event.startDatetime && new Date(event.startDatetime) > new Date()
          ? <span className="small dim nowrap">{countdown(event.startDatetime)}</span>
          : <span className="small dim nowrap">{formatDay(event.startDatetime)}</span>}
    </button>
  );

  return (
    <div className="stack-lg">
      {onBack && (
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>
      )}

      {/* ── Identity and verification ── */}
      <section className="card card-pad">
        <div className="row row-wrap" style={{ gap: 'var(--s5)', alignItems: 'flex-start' }}>
          <span className="avatar lg" style={{ width: 64, height: 64, fontSize: '1.9rem' }}>
            {organizer.avatar || '👤'}
          </span>

          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
              <h1 style={{ fontSize: '1.375rem' }}>{organizer.name}</h1>
              {organizer.verified ? (
                <span className="tag tag-ok"><ShieldCheck size={11} /> Verified organizer</span>
              ) : (
                <span className="tag tag-warn"><ShieldAlert size={11} /> Not yet verified</span>
              )}
            </div>

            <p className="lead" style={{ marginTop: 2 }}>
              {organizer.organization ? `Hosting on behalf of ${organizer.organization}` : 'Event organizer'}
            </p>

            {organizer.bio && (
              <p className="small muted" style={{ marginTop: 'var(--s3)', maxWidth: '60ch' }}>
                {organizer.bio}
              </p>
            )}

            <div className="row row-wrap small dim" style={{ gap: 'var(--s4)', marginTop: 'var(--s3)' }}>
              {organizer.email && (
                <a className="row" style={{ gap: 5 }} href={`mailto:${organizer.email}`}>
                  <Mail size={12} /> {organizer.email}
                </a>
              )}
              <span className="row" style={{ gap: 5 }}>
                <CalendarClock size={12} /> Organizing since {formatDay(organizer.joinedAt)}
              </span>
            </div>
          </div>
        </div>

        <div
          className={`alert ${organizer.verified ? 'alert-brand' : 'alert-warn'}`}
          style={{ marginTop: 'var(--s5)' }}
        >
          {organizer.verified ? <ShieldCheck size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            : <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />}
          <span>
            <span className="alert-title">
              {organizer.verified ? 'Approved by school staff' : 'Awaiting staff approval'}
            </span>
            <span style={{ display: 'block', marginTop: 2 }}>
              {organizer.verified
                ? 'A school administrator checked this organizer\'s identity before letting them post events.'
                : 'This organizer cannot post events until an administrator approves their account.'}
            </span>
          </span>
        </div>
      </section>

      {/* ── Track record ── */}
      <section className="stats">
        <div className="stat">
          <div className="stat-label">Events hosted</div>
          <div className="stat-value">{stats.eventsHosted}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Volunteers worked with</div>
          <div className="stat-value">{stats.volunteersHelped}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Hours credited</div>
          <div className="stat-value accent">{formatHours(stats.hoursAwarded)}</div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Upcoming events</h2>
          {upcoming.length > 0 && <span className="section-action small dim">{upcoming.length}</span>}
        </div>
        {upcoming.length === 0 ? (
          <div className="card empty" style={{ padding: 'var(--s8) var(--s4)' }}>
            <span className="empty-icon"><CalendarClock size={18} /></span>
            <h3>Nothing scheduled</h3>
            <p>This organizer has no upcoming events posted right now.</p>
          </div>
        ) : (
          <div className="list">
            {upcoming.map(e => <EventRow key={e.id} event={e} />)}
          </div>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Past events</h2>
            <span className="section-action small dim">{past.length}</span>
          </div>
          <div className="list">
            {past.slice(0, 10).map(e => <EventRow key={e.id} event={e} />)}
          </div>
          {stats.hoursAwarded > 0 && (
            <p className="small dim row" style={{ gap: 6, marginTop: 'var(--s3)' }}>
              <Award size={12} />
              {formatHours(stats.hoursAwarded)} credited to {stats.volunteersHelped} volunteer
              {stats.volunteersHelped !== 1 ? 's' : ''} across these events.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
