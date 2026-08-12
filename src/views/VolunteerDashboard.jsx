import React, { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, ArrowRight, Printer, X, Ban, Trophy, MapPin, CalendarCheck, History, ShieldCheck
} from 'lucide-react';
import { APP_NAME, SCHOOL_NAME } from '../config';
import { formatHours, formatDay, formatTimeRange, countdown, haversineDistance } from '../utils/helpers';
import { api } from '../utils/api';
import Modal from '../components/Modal';
import { DateChip } from '../components/Seats';
import EmptyState from '../components/common/EmptyState';
import ServiceInsights from '../components/ServiceInsights';
import PreviewList from '../components/common/PreviewList';
import { useLocationContext } from '../contexts/LocationContext';
import LocationLink from '../components/location/LocationLink';
import WeatherSummary from '../components/location/WeatherSummary';

export default function VolunteerDashboard({
  currentUser, events = [], applications = [], addToast, setActiveTab, refreshEvents, refreshApplications, onViewDetails
}) {
  const [showCertificate, setShowCertificate] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);

  /**
   * Leaderboard only. `ServiceInsights` fetches its own figures.
   *
   * This used to fetch the volunteer statistics here too, swallow every error,
   * and re-run whenever `applications.length` changed. All three were wrong:
   * the section that consumes the figures is the one that should own the
   * request, a swallowed 500 was indistinguishable from "no data", and none of
   * those figures depend on applications.
   */
  useEffect(() => {
    let cancelled = false;
    api.fetchLeaderboard().then(l => !cancelled && setLeaderboard(l || [])).catch(() => {});
    return () => { cancelled = true; };
  }, [currentUser.id]);

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

  /* How far the next shift is, computed on the device so the volunteer's exact
     position never leaves it. Null whenever they have not opted in, or the
     event has no pin — both ordinary, both render nothing. */
  const { location: myLocation } = useLocationContext();
  const nextDistance = useMemo(() => {
    const e = nextShift?.event;
    if (!myLocation || !e || e.latitude == null || e.longitude == null) return null;
    return haversineDistance(myLocation.latitude, myLocation.longitude, e.latitude, e.longitude);
  }, [myLocation, nextShift]);

  const totalHours = currentUser.volunteeredHours || 0;
  /* The district's Silver Award threshold, from the server. It was
     `const HOUR_GOAL = 25` here and again in VolunteerProfile.jsx — two copies
     of a number the server uses to decide whether the milestone is earned, so
     the meter could contradict the milestone beside it. See
     server/milestones.js. The `|| 25` is not a second copy: it is the value for
     a session payload predating this field, and it goes when nothing can be
     holding one. */
  const HOUR_GOAL = currentUser.serviceHourGoal || 25;
  const goalPct = Math.min(100, (totalHours / HOUR_GOAL) * 100);
  const goalMet = totalHours >= HOUR_GOAL;
  const progressTone = goalPct < 33 ? 'danger' : goalPct < 100 ? 'warn' : 'ok';

  const handleWithdraw = async (app, title, confirmed) => {
    const message = confirmed
      ? `Release your spot for "${title}"?\n\nThe organizer will be notified and your spot reopens for another volunteer.`
      : `Withdraw your application for "${title}"?`;
    if (!window.confirm(message)) return;
    setWithdrawingId(app.id);
    try {
      await api.withdrawApplication(app.id);
      addToast(confirmed ? 'Spot released. The organizer has been notified.' : 'Application withdrawn.', 'info');
      if (refreshEvents) refreshEvents();
      if (refreshApplications) refreshApplications();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setWithdrawingId(null);
    }
  };

  const greetingMessage = useMemo(() => {
    const name = currentUser.name.split(' ')[0];
    const hour = new Date().getHours();
    
    const morning = [
      `Good morning, ${name} ☀️`,
      `Morning, ${name}! Ready?`,
      `Rise and shine, ${name}`,
      `Ready to make an impact, ${name}?`,
      `New day, new impact, ${name}`,
      `Fresh chances await, ${name}`,
      `Let’s do some good, ${name}`,
      `Ready to lend a hand, ${name}?`
    ];
    
    const afternoon = [
      `Good afternoon, ${name} 👋`,
      `Welcome back, ${name}`,
      `Ready to help, ${name}?`,
      `More good ahead, ${name}`,
      `Keep the momentum going, ${name}`,
      `Still time to make an impact, ${name}`,
      `Back for more good, ${name}?`,
      `Let’s keep helping, ${name}`
    ];
    
    const evening = [
      `Good evening, ${name} 🌙`,
      `Nice to see you, ${name}`,
      `Evening, ${name}`,
      `Still making an impact, ${name}?`,
      `Your impact matters, ${name}`,
      `Another good day, ${name}`,
      `Keep making a difference, ${name}`,
      `More good awaits, ${name}`
    ];
    
    const generic = [
      `Ready to help, ${name}? 💙`,
      `Your next mission awaits, ${name}`,
      `Time to make an impact, ${name}`,
      `Find your next opportunity, ${name}`,
      `New ways to help await, ${name}`,
      `Let’s make a difference, ${name}`,
      `Your kindness matters, ${name}`,
      `Causes need you, ${name}`,
      `Your next adventure starts here, ${name}`,
      `Make today count, ${name}`
    ];

    let pool = Math.random() > 0.3
      ? (hour < 12 ? morning : hour < 17 ? afternoon : evening)
      : generic;
      
    return pool[Math.floor(Math.random() * pool.length)];
  }, [currentUser.name]);

  return (
    <div className="stack-lg">
      <div className="dashboard-greeting" style={{ marginBottom: '-var(--s4)' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 700 }}>
          {greetingMessage}
        </h1>
      </div>
      {/* ── What's next: the single most useful thing on the page ── */}
      {nextShift ? (
        <section className="nextshift">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow" style={{ color: 'var(--ink-inv-3)' }}>Your next shift</div>
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
                <MapPin size={13} aria-hidden="true" />
                <LocationLink
                  location={nextShift.event.location}
                  address={nextShift.event.address}
                  latitude={nextShift.event.latitude}
                  longitude={nextShift.event.longitude}
                />
              </span>
              {nextDistance != null && (
                <span className="row tnum" style={{ gap: 5 }}>{nextDistance.toFixed(1)} mi away</span>
              )}
              {/* Keyed to the SLOT's start, not the event's: this is a specific
                  shift, and that hour is the one they will be standing outside in. */}
              <WeatherSummary
                latitude={nextShift.event.latitude}
                longitude={nextShift.event.longitude}
                datetime={nextShift.slot?.startDatetime}
              />
            </div>
          </div>
          <button className="btn btn-secondary" onClick={() => onViewDetails(nextShift.event)}>
            View details
          </button>
        </section>
      ) : mine.length === 0 && totalHours === 0 ? (
        <section className="card card-pad brand-panel" style={{ background: 'var(--brand)', color: 'var(--ink-inv)', border: 'none' }}>
          <h2 style={{ color: 'var(--ink-inv)' }}>Welcome to {APP_NAME}! 🎉</h2>
          <p className="lead" style={{ marginTop: 8, color: 'var(--ink-inv-2)', maxWidth: '60ch' }}>
            This is your dashboard. Once you start signing up for events, your upcoming shifts and completed hours will appear here.
          </p>
          <div style={{ marginTop: 'var(--s4)' }}>
            <button className="btn btn-primary" style={{ background: 'var(--ink-inv)', color: 'var(--brand)' }} onClick={() => setActiveTab('browse')}>
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
                <span className={`stat-value ${progressTone}`}>{formatHours(totalHours)}</span>
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
            <div className={`meter-fill ${progressTone}`} style={{ width: `${goalPct}%` }} />
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

      {/**
        * The two-column body. A CLASS, not an inline `gridTemplateColumns`.
        *
        * ── The bug this fixes ──
        *
        * "The Dashboard is zoomed out on my phone." It was, and it was this
        * element. The columns were declared inline as
        * `minmax(0, 1.5fr) minmax(0, 1fr)`, and an inline style cannot be
        * overridden by a media query — so a 375px phone laid the dashboard out
        * in TWO columns, the narrower one about 128px wide. The "Log external
        * hours" button in the Service history heading is 156px and does not
        * shrink, so the page was 523px wide inside a 375px viewport. Mobile
        * browsers answer a document wider than the viewport by scaling it down
        * to fit, which is exactly what "zoomed out" looks like.
        *
        * So the fix is not `overflow-x: hidden`, which would have hidden the
        * evidence and left the column 128px wide. `.dash-split` collapses to one
        * column below the width where two of them fit — see index.css.
        */}
      <div className="dash-split">
        <div className="stack-lg">
          {/* ── Confirmed shifts ── */}
          <section>
            <div className="section-head">
              <h2>Confirmed shifts</h2>
              {upcoming.length > 0 && <span className="section-action small dim">{upcoming.length}</span>}
            </div>
            {upcoming.length === 0 ? (
              <EmptyState
                icon={CalendarCheck}
                title="Nothing on the calendar"
                message="Once an organizer confirms you for a shift, it will show up here."
                action={
                  <button className="btn btn-secondary btn-sm" onClick={() => setActiveTab('browse')}>
                    Browse opportunities
                  </button>
                }
              />
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

          <ServiceInsights userId={currentUser.id} setActiveTab={setActiveTab} />
        </div>

        {/* ── Right column ── */}
        <div className="stack-lg">
          <section>
            {/**
              * The volunteer's counterpart to the organizer's "New event",
              * deliberately in the same place and the same shape: a
              * `section-action` on the heading of the section it adds to.
              *
              * It sits on Service history rather than at the top of the page
              * because that is the list it writes into, and because a student
              * looking for "where do I record the thing I did on Saturday" is
              * already looking at their history when the question occurs to
              * them.
              */}
            {/**
              * The entry point to Logged hours — and deliberately the ONLY one
              * in the shell.
              *
              * It replaced "Log external hours", which pointed straight at the
              * form. The full log is the better destination from here: it holds
              * the external form's own entry point, it shows this same history
              * complete rather than truncated, and it is where the question a
              * student has while looking at this list ("how much have I actually
              * done?") is answered.
              *
              * There is no rail entry and no mobile tab for it, which is the
              * point: the navigation should get shorter, not longer, and a page
              * you reach from your hours does not need to be resident beside
              * Messages and the Calendar.
              */}
            <div className="section-head">
              <h2>Service history</h2>
              <Link className="btn btn-secondary btn-sm section-action" to="/hours">
                <History size={14} aria-hidden="true" /> My logged hours
              </Link>
            </div>
            <div className="card card-pad">
              {completed.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="No completed shifts yet"
                  message="Hours appear here once an organizer confirms you attended."
                />
              ) : (
                /* Three, not all of them. A timeline item is four lines tall,
                   so a volunteer with a real history turned this card into the
                   longest thing on the dashboard. The full record has its own
                   page. */
                <PreviewList
                  items={completed}
                  cap={3}
                  className="timeline"
                  label="completed shifts"
                  moreHref="/hours"
                  renderItem={({ app, event, slot }) => (
                    <div key={app.id} className="timeline-item">
                      <div className="timeline-date">{formatDay(slot?.startDatetime)}</div>
                      <div className="timeline-title">{event.title}</div>
                      <div className="timeline-meta">{slot?.name}</div>
                      <div className="hourspill" style={{ marginTop: 6 }}>
                        +{formatHours(app.attendance?.hoursAwarded)} <span>credited</span>
                      </div>
                    </div>
                  )}
                />
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
              <div className="certificate-org">{SCHOOL_NAME}</div>
              <div className="certificate-rule" />
              <h1>Certificate of Community Service</h1>
              <p style={{ marginTop: 'var(--s5)', color: 'var(--certificate-ink-2)' }}>This certifies that</p>
              <div className="certificate-name">{user.name}</div>
              <p style={{ color: 'var(--certificate-ink-2)', maxWidth: '46ch', margin: '0 auto' }}>
                completed volunteer service through the {SCHOOL_NAME} Volunteer Network,
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
                    <td style={{ color: 'var(--certificate-ink-3)' }} className="tnum">{formatDay(slot?.startDatetime)}</td>
                    <td><strong>{event.title}</strong> — {slot?.name}</td>
                    <td style={{ color: 'var(--certificate-ink-3)' }}>{event.location?.split('(')[0]}</td>
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
