import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Clock, Lock, Sparkles } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { formatHours } from '../utils/helpers';

/**
 * Somebody else's service history.
 *
 * ── What is on this page, and what is deliberately not ──
 *
 * The totals, the kinds of service, and the milestones. Those are the figures
 * the profile already summarised, gathered in one place.
 *
 * NOT the itemised list of events. Each of those rows carries a past event's
 * title, its LOCATION and its exact start and end times — for a fifteen-year-old
 * that is a week-by-week record of where they have been, and it is gated on
 * `user.contact.read` at the server for exactly that reason. Nothing here asks
 * for it, and asking would not help: the endpoint returns an empty array to a
 * caller who does not hold the capability.
 *
 * So "public service history" means how much and what kind, never where and
 * when. That distinction is the whole design and it predates this page.
 */
export default function PublicServiceHistory({ currentUser }) {
  const { handle } = useParams();
  const username = String(handle || '').replace(/^@/, '');

  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setState({ status: 'loading' });
      try {
        const person = await api.fetchPublicProfile(username);
        const subject = person?.profile ?? person;
        if (!subject?.id) throw new Error('not_found');

        const record = await api.fetchVolunteerProfile(subject.id);
        if (cancelled) return;

        /* The server says whether the figures are real or withheld. Inferring it
           from "hours === 0" would read a genuine new volunteer as private. */
        if (record.hoursVisible === false) {
          setState({ status: 'private', subject });
          return;
        }
        setState({ status: 'ready', subject, record });
      } catch (err) {
        if (cancelled) return;
        if (err?.status === 404 || /not found/i.test(err?.message || '')) setState({ status: 'missing' });
        else setState({ status: 'error' });
      }
    };

    if (username) load();
    else setState({ status: 'missing' });

    return () => { cancelled = true; };
  }, [username]);

  const backHref = `/users/@${username}`;
  const name = state.subject?.name || `@${username}`;
  const isSelf = currentUser?.username && currentUser.username === username;
  const stats = state.record?.stats;
  const byCategory = state.record?.byCategory || [];
  const milestones = (state.record?.milestones || []).filter(m => m.earned ?? m.achieved ?? true);

  return (
    <div className="page stack-lg">
      <div className="stack-xs">
        <Link to={backHref} className="btn btn-ghost btn-sm row" style={{ gap: 6, alignSelf: 'flex-start' }}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to profile
        </Link>
        <h2 className="row page-title" style={{ gap: 8 }}>
          <Clock size={20} style={{ color: 'var(--brand)' }} aria-hidden="true" />
          {isSelf ? 'Your service history' : `${name}’s service history`}
        </h2>
      </div>

      {state.status === 'loading' && <LoadingSkeleton heights={[120, 120]} className="stack-lg" />}

      {state.status === 'private' && (
        <EmptyState
          icon={Lock}
          title="This service history is private"
          message={`${name} has chosen not to show their hours. Their volunteering still counts — it is just not published here.`}
        />
      )}

      {state.status === 'missing' && (
        <EmptyState notFound title="No such profile" message="We could not find that volunteer." />
      )}

      {state.status === 'error' && (
        <p className="small dim" role="status">This service history could not be loaded.</p>
      )}

      {state.status === 'ready' && (
        <>
          <section className="card card-pad">
            <h2>Totals</h2>
            <div className="stats">
              <div><span className="stat-value tnum">{formatHours(stats?.hours ?? 0)}</span><span className="stat-label">Hours</span></div>
              <div><span className="stat-value tnum">{stats?.eventsCompleted ?? 0}</span><span className="stat-label">Events</span></div>
              <div><span className="stat-value tnum">{stats?.shiftsCompleted ?? 0}</span><span className="stat-label">Shifts</span></div>
            </div>
            {/* Said out loud, so a reader does not take a short page for a short
                record. The omission is a privacy decision, not missing data. */}
            <p className="small dim" style={{ marginTop: 'var(--s3)' }}>
              The individual events someone attended are never shown to other students.
            </p>
          </section>

          {byCategory.length > 0 && (
            <section className="card card-pad stack-sm">
              <h2>Kinds of service</h2>
              {byCategory.map(c => {
                const total = stats?.hours || 0;
                const pct = total > 0 ? (c.hours / total) * 100 : 0;
                return (
                  <div key={c.category}>
                    <div className="row-between small" style={{ marginBottom: 3 }}>
                      <span className="muted">{c.category}</span>
                      <span className="strong tnum">{formatHours(c.hours)}</span>
                    </div>
                    <div className="meter"><div className="meter-fill accent" style={{ width: `${pct}%` }} /></div>
                  </div>
                );
              })}
            </section>
          )}

          {milestones.length > 0 && (
            <section className="card card-pad stack-sm">
              <h2>Milestones</h2>
              <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
                {milestones.map(m => (
                  <span key={m.id} className="milestone" title={m.hint}>
                    <Sparkles size={11} aria-hidden="true" /> {m.label}
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
