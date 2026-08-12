import React, { useEffect, useState } from 'react';
import {
  CalendarCheck, MapPin, Mail, Award, ArrowLeft, History, Medal, Sparkles, FileText, Lock, Pencil
} from 'lucide-react';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import { DistinctionTag } from '../components/profile/Distinction';
import EmptyState from '../components/common/EmptyState';
import { api } from '../utils/api';
import { formatHours, formatDay, formatTimeRange, gradeLabel, countdown } from '../utils/helpers';
import { DateChip } from '../components/Seats';
import CertificateModal from '../components/CertificateModal';
import PreviewList from '../components/common/PreviewList';
import BadgesList from '../components/BadgesList';
import { Link } from 'react-router-dom';

/**
 * A volunteer's record of service.
 *
 * Celebrates contribution without becoming social: no followers, no likes,
 * nothing another student can react to. Everything here is either a fact
 * about service completed or a next step the person can take.
 */
export default function VolunteerProfile({
  userId, currentUser, onBack, onEditProfile, onViewEvent, addToast
}) {
  const [data, setData] = useState(null);
  const [certificates, setCertificates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [certificate, setCertificate] = useState(null);

  const isSelf = userId === currentUser?.id;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    api.fetchVolunteerProfile(userId)
      .then(res => { if (!cancelled) setData(res); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    // Certificates are personal — only ever fetched for your own profile
    if (isSelf) {
      api.fetchCertificates()
        .then(res => { if (!cancelled) setCertificates(res || []); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [userId, isSelf]);

  if (loading) {
    return (
      <div className="stack-lg">
        <LoadingSkeleton heights={[120, 88]} className="" style={{}} />
        <div className="grid grid-2">
          <LoadingSkeleton heights={[220]} className="" style={{}} />
          <LoadingSkeleton heights={[220]} className="" style={{}} />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card empty">
        <span className="empty-icon"><Lock size={18} /></span>
        <h3>Profile unavailable</h3>
        <p>{error || 'This volunteer profile could not be loaded.'}</p>
        {onBack && <button className="btn btn-secondary btn-sm" onClick={onBack}>Go back</button>}
      </div>
    );
  }

  const { volunteer, stats, milestones, byCategory, completed, upcoming } = data;
  const earned = milestones.filter(m => m.earned);
  const next = milestones.find(m => !m.earned);
  /* From the server, not a local constant — see the note in
     VolunteerDashboard.jsx and server/milestones.js. */
  const HOUR_GOAL = currentUser?.serviceHourGoal || 25;
  const goalPct = Math.min(100, (stats.hours / HOUR_GOAL) * 100);
  const progressTone = goalPct < 33 ? 'danger' : goalPct < 100 ? 'warn' : 'ok';

  return (
    <div className="stack-lg">
      {onBack && (
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>
      )}

      {/* ── Identity ── */}
      <section className="card card-pad">
        <div className="row row-wrap" style={{ gap: 'var(--s5)', alignItems: 'flex-start' }}>
          <span className="avatar lg" style={{ width: 64, height: 64, fontSize: '1.9rem' }}>
            {volunteer.avatar || '👤'}
          </span>

          <div style={{ flex: 1, minWidth: 200 }}>
            <h1 style={{ fontSize: '1.375rem' }}>{volunteer.name}</h1>
            {/**
              * The owner or partner pill, if this account carries one.
              *
              * An account can be the platform owner AND a volunteer — the owner
              * of this platform deliberately is both — and this page is now
              * where such an account lands, because privilege should not decide
              * whether somebody gets to see their own service record. The pill
              * keeps the distinction visible without turning the page into a
              * different page: everything below it is the ordinary student
              * presentation, which is the whole point.
              *
              * `distinctionFor` is a pure function of role on the server and is
              * presentation only — no capability is derived from it.
              */}
            <DistinctionTag distinction={currentUser?.id === userId ? currentUser?.distinction : volunteer.distinction} />
            <p className="lead" style={{ marginTop: 2 }}>
              {[gradeLabel(volunteer.grade), 'Volunteer'].filter(Boolean).join(' · ')}
            </p>
            {volunteer.bio && (
              <p className="small muted" style={{ marginTop: 'var(--s3)', maxWidth: '60ch' }}>
                {volunteer.bio}
              </p>
            )}
            {volunteer.skills?.length > 0 && (
              <div className="row row-wrap" style={{ gap: 4, marginTop: 'var(--s3)' }}>
                {volunteer.skills.map(s => <span key={s} className="tag tag-brand">{s}</span>)}
              </div>
            )}
          </div>

          {isSelf && (
            <div className="row" style={{ gap: 8 }}>
              <Link to="/portfolio" className="btn btn-secondary btn-sm">
                <FileText size={13} /> Transcript
              </Link>
              {onEditProfile && (
                <button className="btn btn-secondary btn-sm" onClick={onEditProfile}>
                  <Pencil size={13} /> Edit profile
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── Impact ── */}
      <section className="stats">
        <div className="stat">
          <div className="stat-label">Hours served</div>
          <div className={`stat-value ${progressTone}`}>{formatHours(stats.hours)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Events completed</div>
          <div className="stat-value">{stats.eventsCompleted}</div>
          {stats.shiftsCompleted !== stats.eventsCompleted && (
            <div className="stat-note">{stats.shiftsCompleted} shifts</div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">Coming up</div>
          <div className="stat-value">{stats.upcomingCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Awaiting reply</div>
          <div className="stat-value">{stats.pendingCount}</div>
        </div>
      </section>

      {isSelf && (
        <section className="card card-body">
          <div className="row-between" style={{ marginBottom: 'var(--s2)' }}>
            <span className="small strong">Progress to the {HOUR_GOAL}-hour Silver Award</span>
            <span className="small muted tnum">{formatHours(stats.hours)} / {HOUR_GOAL} hrs</span>
          </div>
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={Number(Number(stats.hours).toFixed(2))}
            aria-valuemin={0}
            aria-valuemax={HOUR_GOAL}
            aria-label={`Progress to the ${HOUR_GOAL}-hour Silver Award: ${formatHours(stats.hours)} of ${HOUR_GOAL} hours`}
          >
            <div
              className={`meter-fill ${progressTone}`}
              style={{ width: `${goalPct}%` }}
            />
          </div>
        </section>
      )}

      <section>
        <BadgesList userId={userId} />
      </section>

      {/* The same two-column body as the dashboard, and the same class — it had
          the same inline `gridTemplateColumns`, so it overflowed a phone for the
          same reason. See the note in VolunteerDashboard.jsx. */}
      <div className="dash-split">
        <div className="stack-lg">
          {/* ── Coming up ── */}
          <section>
            <div className="section-head"><h2>Coming up</h2></div>
            {upcoming.length === 0 ? (
              <EmptyState 
                icon={CalendarCheck} 
                title="No upcoming shifts" 
                message={isSelf ? 'Opportunities you get accepted for will appear here.' : 'Nothing scheduled right now.'} 
                style={{ padding: 'var(--s8) var(--s4)' }} 
              />
            ) : (
              <div className="list">
                {/* The INDEX is in the key, and it has to be: one event can have
                    two shifts starting at the same moment with the same name (a
                    demo database has exactly that), so eventId, start time and
                    slot name together are still not unique. A student accepted
                    for both produced two rows with the same key — React's "two
                    children with the same key" console error, and a real risk of
                    one of them being dropped on re-render. The index is safe
                    here because this list is never reordered and its rows hold
                    no state of their own. */}
                {upcoming.map((u, i) => (
                  <div key={`${u.eventId}-${u.startDatetime}-${i}`} className="list-row">
                    <DateChip iso={u.startDatetime} />
                    <div className="truncate" style={{ flex: 1 }}>
                      <div className="person-name truncate">{u.title}</div>
                      <div className="person-meta truncate tnum">
                        {u.slotName} · {formatTimeRange(u.startDatetime, u.endDatetime)}
                      </div>
                    </div>
                    <span className="small dim nowrap">{countdown(u.startDatetime)}</span>
                    {onViewEvent && (
                      <button className="btn btn-ghost btn-sm" onClick={() => onViewEvent(u.eventId)}>View</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Service record ── */}
          <section>
            <div className="section-head">
              <h2>Service record</h2>
              {completed.length > 0 && <span className="section-action small dim">{completed.length}</span>}
            </div>
            {completed.length === 0 ? (
              <EmptyState 
                icon={History} 
                title="No completed events yet" 
                message={isSelf ? 'Once an organizer confirms you attended, the event and its hours are recorded here.' : 'This volunteer has not completed an event yet.'} 
                style={{ padding: 'var(--s8) var(--s4)' }} 
              />
            ) : (
              /* Five, not all of them. This list was uncapped on both the
                 client and the server, so a volunteer with two hundred
                 confirmed shifts rendered two hundred rows on their own
                 profile — and on anybody else's view of it. */
              <PreviewList
                items={completed}
                cap={5}
                className="list"
                label="completed shifts"
                moreHref="/hours"
                moreLabel={`Show all ${completed.length} shifts`}
                renderItem={(c, i) => (
                  <div key={`${c.eventId}-${c.startDatetime}-${i}`} className="list-row">
                    <DateChip iso={c.startDatetime} />
                    <div className="truncate" style={{ flex: 1 }}>
                      <div className="person-name truncate">{c.title}</div>
                      <div className="person-meta truncate">
                        {c.slotName} · hosted by {c.organizerName}
                      </div>
                      <div className="small dim row truncate" style={{ gap: 4, marginTop: 2 }}>
                        <MapPin size={11} /> {c.location}
                      </div>
                    </div>
                    <span className="hourspill">+{formatHours(c.hours)}</span>
                  </div>
                )}
              />
            )}
          </section>
        </div>

        <div className="stack-lg">
          {/* ── Milestones ── */}
          <section>
            <div className="section-head">
              <h2 className="row" style={{ gap: 6 }}>
                <Medal size={15} style={{ color: 'var(--accent)' }} /> Milestones
              </h2>
            </div>
            <div className="card card-pad">
              {earned.length === 0 ? (
                <p className="small muted">
                  Complete your first shift to earn your first milestone.
                </p>
              ) : (
                <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
                  {earned.map(m => (
                    <span key={m.id} className="milestone" title={m.hint}>
                      <Sparkles size={11} /> {m.label}
                    </span>
                  ))}
                </div>
              )}
              {next && (
                <p className="small dim" style={{ marginTop: earned.length ? 'var(--s3)' : 0 }}>
                  Next: <span className="strong">{next.label}</span> — {next.hint.toLowerCase()}
                </p>
              )}
            </div>
          </section>

          {/* ── Where hours came from ── */}
          {byCategory.length > 0 && (
            <section>
              <div className="section-head"><h2>Kinds of service</h2></div>
              <div className="card card-pad stack-sm">
                {byCategory.map(c => {
                  const pct = stats.hours > 0 ? (c.hours / stats.hours) * 100 : 0;
                  return (
                    <div key={c.category}>
                      <div className="row-between small" style={{ marginBottom: 3 }}>
                        <span className="muted">{c.category}</span>
                        <span className="strong tnum">{formatHours(c.hours)}</span>
                      </div>
                      <div className="meter">
                        <div className="meter-fill accent" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Certificates (own profile only) ── */}
          {isSelf && (
            <section>
              <div className="section-head">
                <h2 className="row" style={{ gap: 6 }}>
                  <Award size={15} style={{ color: 'var(--brand)' }} /> Certificates
                </h2>
              </div>
              {certificates.length === 0 ? (
                <EmptyState 
                  icon={FileText} 
                  title="No certificates yet" 
                  message="You earn one for each event you complete." 
                  style={{ padding: 'var(--s6) var(--s4)' }} 
                />
              ) : (
                <div className="list">
                  {certificates.map(c => (
                    <button
                      key={c.eventId}
                      className="list-row"
                      style={{ width: '100%', textAlign: 'left' }}
                      onClick={() => setCertificate(c)}
                    >
                      <span className="notif-icon tone-brand"><Award size={15} /></span>
                      <span className="truncate" style={{ flex: 1 }}>
                        <span className="person-name truncate">{c.title}</span>
                        <span className="person-meta truncate tnum">
                          {formatDay(c.endDatetime)} · {formatHours(c.hours)}
                        </span>
                      </span>
                      <span className="small dim nowrap">View</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {certificate && (
        <CertificateModal
          certificate={certificate}
          volunteer={volunteer}
          onClose={() => setCertificate(null)}
          addToast={addToast}
        />
      )}
    </div>
  );
}
