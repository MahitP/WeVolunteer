import React, { useState, useMemo, useEffect } from 'react';
import {
  FileText, ArrowRight, Printer, X, Ban, Trophy, MapPin, CalendarCheck, History, ShieldCheck
} from 'lucide-react';
import { APP_NAME } from '../config';
import { formatHours, formatDay, formatTimeRange, countdown } from '../utils/helpers';
import { api } from '../utils/api';
import Modal from '../components/Modal';
import { BarChart, DonutChart } from '../components/BarChart';
import { DateChip } from '../components/Seats';

const HOUR_GOAL = 25;

export default function VolunteerDashboard({
  currentUser, events = [], applications = [], addToast, setActiveTab, onStateChange, onViewDetails
}) {
  const [showCertificate, setShowCertificate] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState(null);
  const [stats, setStats] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api.fetchVolunteerStats().then(s => !cancelled && setStats(s)).catch(() => {});
    api.fetchLeaderboard().then(l => !cancelled && setLeaderboard(l || [])).catch(() => {});
    return () => { cancelled = true; };
  }, [currentUser.id, applications.length]);

  const myApps = useMemo(
    () => applications.filter(a => a.userId === currentUser.id),
    [applications, currentUser.id]
  );

  // Pair each application with its event once, then slice that list by state.
  const mine = useMemo(() => {
    const byId = new Map(events.map(e => [e.id, e]));
    return myApps
      .map(app => {
        const event = byId.get(app.eventId);
        return event ? { app, event, slot: app.slot } : null;
      })
      .filter(Boolean);
  }, [myApps, events]);

  const upcoming = useMemo(() => mine
    .filter(({ app, event }) => event.status !== 'cancelled' && app.status === 'accepted' && new Date(app.slot?.endDatetime || 0) > new Date())
    .sort((a, b) => new Date(a.slot?.startDatetime || 0) - new Date(b.slot?.startDatetime || 0)),
    [mine]);

  const pending = useMemo(
    () => mine.filter(({ app }) => app.status === 'pending' || app.status === 'waitlisted'),
    [mine]);

  const completed = useMemo(() => mine
    .filter(({ app }) => app.attendance?.present)
    .sort((a, b) => new Date(b.slot?.startDatetime || 0) - new Date(a.slot?.startDatetime || 0)),
    [mine]);

  const nextShift = upcoming[0];
  const totalHours = currentUser.volunteeredHours || 0;
  const goalPct = Math.min(100, (totalHours / HOUR_GOAL) * 100);
  const goalMet = totalHours >= HOUR_GOAL;

  const handleWithdraw = async (app, title, confirmed) => {
    const message = confirmed
      ? `Release your spot for "${title}"?\n\nThe organizer will be notified and your spot reopens for another volunteer.`
      : `Withdraw your application for "${title}"?`;
    if (!window.confirm(message)) return;
    setWithdrawingId(app.id);
    try {
      await api.withdrawApplication(app.id);
      addToast(confirmed ? 'Spot released. The organizer has been notified.' : 'Application withdrawn.', 'info');
      onStateChange();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setWithdrawingId(null);
    }
  };

  return (
    <div className="stack-lg">
      {/* ── What's next: the single most useful thing on the page ── */}
      {nextShift ? (
        <section className="nextshift">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow" style={{ color: 'rgba(255,255,255,.7)' }}>Your next shift</div>
            <div className="nextshift-when">{countdown(nextShift.slot?.startDatetime)}</div>
            <div className="nextshift-what truncate">
              {nextShift.event.title} · {nextShift.slot?.name}
            </div>
            <div className="nextshift-detail tnum">
              <span className="row" style={{ gap: 5 }}>
                <CalendarCheck size={13} />
                {formatDay(nextShift.slot?.startDatetime)}, {formatTimeRange(nextShift.slot?.startDatetime, nextShift.slot?.endDatetime)}
              </span>
              <span className="row" style={{ gap: 5 }}>
                <MapPin size={13} /> {nextShift.event.location}
              </span>
            </div>
          </div>
          <button className="btn btn-secondary" onClick={() => onViewDetails(nextShift.event)}>
            View details
          </button>
        </section>
      ) : mine.length === 0 && totalHours === 0 ? (
        <section className="card card-pad" style={{ background: 'var(--brand)', color: '#fff', border: 'none' }}>
          <h2>Welcome to {APP_NAME}! 🎉</h2>
          <p className="lead" style={{ marginTop: 8, color: 'rgba(255,255,255,0.9)', maxWidth: '60ch' }}>
            This is your dashboard. Once you start signing up for events, your upcoming shifts and completed hours will appear here.
          </p>
          <div style={{ marginTop: 'var(--s4)' }}>
            <button className="btn btn-primary" style={{ background: '#fff', color: 'var(--brand)' }} onClick={() => setActiveTab('browse')}>
              Find your first opportunity <ArrowRight size={15} />
            </button>
          </div>
        </section>
      ) : (
        <section className="card card-pad row-between row-wrap" style={{ gap: 'var(--s4)' }}>
          <div>
            <h2>No upcoming shifts</h2>
            <p className="lead" style={{ marginTop: 2 }}>
              Find a shift that fits your schedule and apply — most are about two hours.
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setActiveTab('browse')}>
            Find opportunities <ArrowRight size={15} />
          </button>
        </section>
      )}

      {/* ── Awaiting a decision: second, because it's the other thing a
             student is actually wondering about ── */}
      {pending.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Waiting on a reply</h2>
            <span className="section-action small dim">{pending.length}</span>
          </div>
          <div className="list">
            {pending.map(({ app, event, slot }) => (
              <div key={app.id} className="list-row">
                <DateChip iso={slot?.startDatetime} />
                <div className="truncate" style={{ flex: 1 }}>
                  <div className="person-name truncate">{event.title}</div>
                  <div className="person-meta truncate tnum">
                    {slot?.name} · {formatDay(slot?.startDatetime)}, {formatTimeRange(slot?.startDatetime, slot?.endDatetime)}
                  </div>
                </div>
                <span className={`status ${app.status === 'waitlisted' ? 'status-info' : 'status-pending'}`}>
                  {app.status === 'waitlisted' ? 'Waitlisted' : 'Awaiting decision'}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => onViewDetails(event)}>View</button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleWithdraw(app, event.title, false)}
                  disabled={withdrawingId === app.id}
                >
                  <Ban size={13} /> Withdraw
                </button>
              </div>
            ))}
          </div>
          <p className="small dim" style={{ marginTop: 'var(--s2)' }}>
            Organizers review each application. You'll get a notification as soon as they decide.
          </p>
        </section>
      )}

      {/* ── Hours: the number students are actually here for ── */}
      <section className="card">
        <div className="card-body">
          <div className="row-between row-wrap" style={{ marginBottom: 'var(--s3)' }}>
            <div>
              <div className="eyebrow">Service hours this year</div>
              <div className="row" style={{ gap: 'var(--s2)', marginTop: 2 }}>
                <span className="stat-value accent">{formatHours(totalHours)}</span>
                <span className="muted small">of {HOUR_GOAL} hr goal</span>
              </div>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowCertificate(true)}
              disabled={completed.length === 0}
              title={completed.length === 0 ? 'Complete a shift to earn a certificate' : undefined}
            >
              <FileText size={14} /> Hours certificate
            </button>
          </div>

          {/* The single number this product exists to communicate. As styled
              divs it was decorative to a screen reader — the progress toward
              the Silver Award simply did not exist for those users. */}
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={Number(totalHours.toFixed(2))}
            aria-valuemin={0}
            aria-valuemax={HOUR_GOAL}
            aria-label={`Service hours: ${formatHours(totalHours)} of ${HOUR_GOAL} hour goal`}
          >
            <div className={`meter-fill ${goalMet ? 'full' : 'accent'}`} style={{ width: `${goalPct}%` }} />
          </div>
          <p className="small muted" style={{ marginTop: 'var(--s2)' }}>
            {goalMet
              ? `Goal reached — ${formatHours(totalHours - HOUR_GOAL)} past the ${HOUR_GOAL}-hour Silver Award target.`
              : `${formatHours(HOUR_GOAL - totalHours)} to go to reach the Silver Award target.`}
          </p>

          {/* The rule students and parents most need stated plainly. Hours
              are the currency here; ambiguity about how they're earned is
              the fastest way to lose trust in the platform. */}
          <div className="alert alert-brand" style={{ marginTop: 'var(--s4)' }}>
            <ShieldCheck size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              <span className="alert-title">How hours are credited</span>
              <span style={{ display: 'block', marginTop: 2 }}>
                Signing up doesn't earn hours. After a shift, the organizer marks who attended,
                and the hours for that shift are added here automatically. Every hour on your
                certificate is backed by an organizer's confirmation.
              </span>
            </span>
          </div>
        </div>

        <div className="stats" style={{ border: 'none', borderTop: '1px solid var(--rule)', borderRadius: 0 }}>
          <div className="stat">
            <div className="stat-label">Upcoming</div>
            <div className="stat-value">{upcoming.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Awaiting reply</div>
            <div className="stat-value">{pending.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Shifts completed</div>
            <div className="stat-value">{completed.length}</div>
          </div>
        </div>
      </section>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', alignItems: 'start', gap: 'var(--s6)' }}>
        <div className="stack-lg">
          {/* ── Confirmed shifts ── */}
          <section>
            <div className="section-head">
              <h2>Confirmed shifts</h2>
              {upcoming.length > 0 && <span className="section-action small dim">{upcoming.length}</span>}
            </div>
            {upcoming.length === 0 ? (
              <div className="card empty">
                <span className="empty-icon"><CalendarCheck size={18} /></span>
                <h3>Nothing on the calendar</h3>
                <p>Once an organizer confirms you for a shift, it will show up here.</p>
                <button className="btn btn-secondary btn-sm" onClick={() => setActiveTab('browse')}>
                  Browse opportunities
                </button>
              </div>
            ) : (
              <div className="list">
                {upcoming.map(({ app, event, slot }) => (
                  <div key={app.id} className="list-row">
                    <DateChip iso={slot?.startDatetime} />
                    <div className="truncate" style={{ flex: 1 }}>
                      <div className="person-name truncate">{event.title}</div>
                      <div className="person-meta truncate tnum">
                        {slot?.name} · {formatTimeRange(slot?.startDatetime, slot?.endDatetime)} · {formatHours(slot?.hours)}
                      </div>
                    </div>
                    <span className="status status-ok">Confirmed</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => onViewDetails(event)}>View</button>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--danger)' }}
                      disabled={withdrawingId === app.id}
                      onClick={() => handleWithdraw(app, event.title, true)}
                      title="Can't make it? Release your spot so someone else can take it"
                    >
                      Can't make it
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Impact charts, only once there's something to show ── */}
          {stats && (stats.monthlyHours?.length > 0 || stats.categoryHours?.length > 0) && (
            <section>
              <div className="section-head"><h2>Where your hours came from</h2></div>
              <div className="grid grid-2">
                {stats.monthlyHours?.length > 0 && (
                  <div className="card card-pad">
                    <div className="eyebrow" style={{ marginBottom: 'var(--s3)' }}>By month</div>
                    <BarChart data={stats.monthlyHours} valueKey="hours" labelKey="month" highlightLast />
                  </div>
                )}
                {stats.categoryHours?.length > 0 && (
                  <div className="card card-pad">
                    <div className="eyebrow" style={{ marginBottom: 'var(--s3)' }}>By type of service</div>
                    <DonutChart data={stats.categoryHours} valueKey="hours" labelKey="category" />
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        {/* ── Right column ── */}
        <div className="stack-lg">
          <section>
            <div className="section-head"><h2>Service history</h2></div>
            <div className="card card-pad">
              {completed.length === 0 ? (
                <div className="empty" style={{ padding: 'var(--s6) 0' }}>
                  <span className="empty-icon"><History size={18} /></span>
                  <h3>No completed shifts yet</h3>
                  <p>Hours appear here once an organizer confirms you attended.</p>
                </div>
              ) : (
                <div className="timeline">
                  {completed.map(({ app, event, slot }) => (
                    <div key={app.id} className="timeline-item">
                      <div className="timeline-date">{formatDay(slot?.startDatetime)}</div>
                      <div className="timeline-title">{event.title}</div>
                      <div className="timeline-meta">{slot?.name}</div>
                      <div className="hourspill" style={{ marginTop: 6 }}>
                        +{formatHours(app.attendance?.hoursAwarded)} <span>credited</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {leaderboard.length > 0 && (
            <section>
              <div className="section-head">
                <h2 className="row" style={{ gap: 6 }}>
                  <Trophy size={14} style={{ color: 'var(--accent)' }} /> Top volunteers
                </h2>
              </div>
              <div className="list">
                {buildBoard(leaderboard, currentUser.id).map(entry => (
                  <div key={entry.id} className={`list-row ${entry.id === currentUser.id ? 'is-me' : ''}`}>
                    <span className={`rank ${entry.rank <= 3 ? 'top' : ''}`}>{entry.rank}</span>
                    <span className="avatar sm">{entry.avatar || '👤'}</span>
                    <span className="truncate" style={{ flex: 1 }}>
                      <span className="person-name truncate">
                        {entry.name}{entry.id === currentUser.id ? ' (you)' : ''}
                      </span>
                    </span>
                    <span className="hourspill">{formatHours(entry.hours)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {showCertificate && (
        <CertificateModal
          user={currentUser}
          shifts={completed}
          onClose={() => setShowCertificate(false)}
        />
      )}
    </div>
  );
}

/** Top five, plus the current user pinned if they didn't make the cut. */
function buildBoard(leaderboard, myId) {
  const top = leaderboard.slice(0, 5);
  if (top.some(e => e.id === myId)) return top;
  const me = leaderboard.find(e => e.id === myId);
  return me ? [...top, me] : top;
}

function CertificateModal({ user, shifts, onClose }) {
  const total = shifts.reduce((sum, s) => sum + Number(s.app.attendance?.hoursAwarded || 0), 0);

  return (
    <Modal onClose={onClose} label="Hours certificate" size="lg">
      <div className="modal-head no-print">
        <div>
          <h2>Hours certificate</h2>
          <p className="lead">An official record of your completed service, ready to print or save as PDF.</p>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
      </div>

        <div className="modal-body" style={{ background: 'var(--surface-2)' }}>
          <div className="certificate" id="printable-certificate">
            <div style={{ textAlign: 'center' }}>
              <div className="certificate-org">Township of South Brunswick · New Jersey</div>
              <div className="certificate-rule" />
              <h1>Certificate of Community Service</h1>
              <p style={{ marginTop: 'var(--s5)', color: '#57534e' }}>This certifies that</p>
              <div className="certificate-name">{user.name}</div>
              <p style={{ color: '#57534e', maxWidth: '46ch', margin: '0 auto' }}>
                completed volunteer service through the South Brunswick Volunteer Network,
                totalling
              </p>
              <div className="certificate-hours" style={{ margin: 'var(--s4) 0' }}>{formatHours(total)}</div>
            </div>

            <table style={{ marginTop: 'var(--s8)' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event and role</th>
                  <th>Location</th>
                  <th style={{ textAlign: 'right' }}>Hours</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map(({ app, event, slot }) => (
                  <tr key={app.id}>
                    <td style={{ color: '#78716c' }} className="tnum">{formatDay(slot?.startDatetime)}</td>
                    <td><strong>{event.title}</strong> — {slot?.name}</td>
                    <td style={{ color: '#78716c' }}>{event.location?.split('(')[0]}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }} className="tnum">
                      {formatHours(app.attendance?.hoursAwarded)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="row" style={{ marginTop: 'var(--s12)', gap: 'var(--s8)' }}>
              <div style={{ flex: 1 }}>
                <div className="certificate-sign">Volunteer signature</div>
              </div>
              <div style={{ flex: 1 }}>
                <div className="certificate-sign">Program coordinator</div>
              </div>
            </div>
          </div>
        </div>

      <div className="modal-foot no-print">
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={() => window.print()}>
          <Printer size={15} /> Print or save as PDF
        </button>
      </div>
    </Modal>
  );
}
