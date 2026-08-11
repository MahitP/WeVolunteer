import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Sprout, Flame, Sparkles } from 'lucide-react';
import { api } from '../utils/api';
import { formatHours } from '../utils/helpers';
import { reportClientError } from '../utils/errorReporting';
import { BarChart } from './BarChart';
import LoadingSkeleton from './common/LoadingSkeleton';
import EmptyState from './common/EmptyState';
import ErrorPanel from '../views/ErrorExperience/ErrorPanel';

/**
 * What a volunteer's service adds up to.
 *
 * ── Why this is a component and not a block inside the dashboard ──
 *
 * It has four states — loading, failed, two kinds of empty, and content — and
 * VolunteerDashboard is already 600 lines with a long list of hooks. Four
 * branches inline there is exactly the shape `hookOrder.test.jsx` exists
 * because of. Owning its own fetch also means a failure here cannot take the
 * rest of the dashboard with it, and vice versa.
 *
 * ── What it replaces ──
 *
 * Two charts under the heading "Where your hours came from": hours by month,
 * and a doughnut of hours by category. The doughnut is gone. It answered a
 * question that changed nothing a volunteer would do next, it degenerated to
 * one or two arcs because the category enum has five values and most students
 * serve in one, and the profile page already renders the same breakdown as
 * labelled bars that work at any category count.
 *
 * The section now leads with the thing a volunteer is most likely to be
 * confused about — hours that have not appeared yet — because that is the
 * question they would otherwise have to ask an adult.
 */

/** Below this, a streak is noise rather than a signal. See the streak block. */
const MIN_STREAK_MONTHS = 2;

export default function ServiceInsights({ userId, setActiveTab }) {
  const [insights, setInsights] = useState(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    api.fetchVolunteerStats()
      .then((data) => { if (!cancelled) setInsights(data); })
      .catch((err) => {
        if (cancelled) return;
        /**
         * The previous version was `.catch(() => {})`.
         *
         * A 500 and "this student has done nothing yet" produced identical
         * screens — the section simply never appeared — so the failure was
         * invisible to the volunteer AND to us.
         */
        setFailed(true);
        reportClientError(err, { kind: 'fetch', route: '/dashboard' });
      });

    return () => { cancelled = true; };
    /* Deliberately not `applications.length`. Every figure here derives from
       the attendance ledger, which no student action changes: withdrawing is
       refused once a shift has started, so it can only ever remove a future
       commitment, which this section does not count. */
  }, [userId, reload]);

  const loading = !insights && !failed;

  return (
    <section aria-labelledby="insights-heading" aria-busy={loading || undefined}>
      {/* The heading renders in every state. That is what stops the page
          reflowing when the data lands — nothing above the fold moves. */}
      <div className="section-head"><h2 id="insights-heading">Your service so far</h2></div>

      {loading && (
        <LoadingSkeleton heights={[172, 96]} className="stack-lg" style={{}} />
      )}

      {failed && (
        <ErrorPanel
          title="We couldn't load your service summary"
          message="Your hours are safe — this is only the summary on this page. Try again in a moment."
          onRetry={() => setReload(n => n + 1)}
        />
      )}

      {insights && <InsightsBody insights={insights} setActiveTab={setActiveTab} />}
    </section>
  );
}

function InsightsBody({ insights, setActiveTab }) {
  const { record, monthlyHours, milestones, streak } = insights;
  const waiting = record.eventsAwaitingRecord || 0;
  const nothingConfirmed = record.eventsAttended === 0 && record.hoursCredited === 0;

  /**
   * Two different empty states, because they are two different situations and
   * the previous code could express neither.
   */
  if (nothingConfirmed && waiting > 0) {
    return (
      <EmptyState
        icon={Clock}
        title="Nothing confirmed yet"
        message={
          `You've worked ${waiting} ${waiting === 1 ? 'event' : 'events'} that ${waiting === 1 ? 'is' : 'are'} `
          + 'waiting for an organizer to confirm attendance. Your hours and milestones appear here as soon as they do.'
        }
      />
    );
    /* No action button: there is nothing the volunteer can do, and offering a
       button implies otherwise. */
  }

  if (nothingConfirmed) {
    return (
      <EmptyState
        icon={Sprout}
        title="Your service story starts with your first shift"
        message="Once an organizer confirms you attended, your hours, your milestones and the months you volunteered all show up here."
        action={
          setActiveTab
            ? <button className="btn btn-secondary btn-sm" onClick={() => setActiveTab('browse')}>Browse opportunities</button>
            : null
        }
      />
    );
  }

  const totalInWindow = monthlyHours.reduce((sum, m) => sum + (Number(m.hours) || 0), 0);
  const earned = milestones.filter(m => m.earned);
  const next = milestones.find(m => !m.earned);

  return (
    <div className="stack-lg">
      {waiting > 0 && (
        <div className="alert">
          <Clock size={15} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <span>
            <span className="alert-title">Waiting on an organizer</span>
            <span style={{ display: 'block', marginTop: 2 }}>
              {waiting} {waiting === 1 ? 'event is' : 'events are'} waiting for the organizer to
              confirm attendance. Hours are added here automatically once they do — checking in at
              the event doesn&rsquo;t credit them.
            </span>
          </span>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="eyebrow" style={{ marginBottom: 'var(--s3)' }}>Hours by month</div>
          <BarChart
            data={monthlyHours}
            valueKey="hours"
            labelKey="month"
            highlightLast
            highlightNote="this month"
            caption="Hours credited to you, by month"
            unit="Hours"
            periodLabel="Month"
            emptyText="No hours credited in the last six months."
          />
          <p className="small dim" style={{ marginTop: 'var(--s3)' }}>
            {formatHours(totalInWindow)} in the last six months.
          </p>
        </div>

        <div className="card card-pad">
          <div className="eyebrow" style={{ marginBottom: 'var(--s3)' }}>Your record</div>
          <div className="stats" style={{ border: 'none' }}>
            <div className="stat" style={{ padding: 'var(--s2) var(--s3)' }}>
              <div className="stat-label">Events attended</div>
              <div className="stat-value tnum">{record.eventsAttended}</div>
              {record.eventsSignedUp > 0 && (
                <div className="stat-note tnum">of {record.eventsSignedUp} completed</div>
              )}
            </div>
            <div className="stat" style={{ padding: 'var(--s2) var(--s3)' }}>
              <div className="stat-label">Kinds of service</div>
              <div className="stat-value tnum">{record.kindsOfService}</div>
            </div>
            <div className="stat" style={{ padding: 'var(--s2) var(--s3)' }}>
              <div className="stat-label">Volunteering since</div>
              <div className="stat-value">
                {record.firstVolunteeredAt
                  ? <time dateTime={record.firstVolunteeredAt.slice(0, 7)}>{monthYear(record.firstVolunteeredAt)}</time>
                  : '—'}
              </div>
            </div>
          </div>
          <p className="small dim" style={{ marginTop: 'var(--s3)' }}>
            <Link to="/hours">See every shift on your hours log →</Link>
          </p>
        </div>
      </div>

      <div className="card card-pad">
        <div className="eyebrow" style={{ marginBottom: 'var(--s3)' }}>Milestones</div>

        {earned.length > 0 ? (
          <ul className="chips" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {earned.map(m => (
              <li key={m.id} className="milestone">
                <Sparkles size={12} aria-hidden="true" />
                {m.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small dim" style={{ margin: 0 }}>
            Complete your first shift to reach your first milestone.
          </p>
        )}

        {next && (
          <p className="small dim" style={{ marginTop: 'var(--s3)', marginBottom: 0 }}>
            Next milestone: {next.label}.
          </p>
        )}

        {/**
          * A streak, shown only from two months.
          *
          * A "1 month streak" is not continuity, it is a single month with a
          * flame next to it, and putting one in front of somebody who has
          * volunteered once reads as a scoreboard opening.
          *
          * Deliberately absent: any countdown, any "keep it going", any
          * indication of what would break it. Those are the mechanics that turn
          * a record of what you did into pressure about what you must do next,
          * and this is a volunteer platform. A month is also long enough to
          * absorb an exam week, a holiday or an illness — see buildStreak.
          */}
        {streak.current >= MIN_STREAK_MONTHS && (
          <p className="small" style={{ marginTop: 'var(--s3)', marginBottom: 0 }}>
            <Flame size={13} aria-hidden="true" style={{ verticalAlign: '-2px' }} />
            {' '}
            <span className="strong">{streak.current} months in a row.</span>
            {streak.longest > streak.current && (
              <span className="dim"> Your longest is {streak.longest}.</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** "March 2026" from an ISO instant, in the reader's own locale. */
function monthYear(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
