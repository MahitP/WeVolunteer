import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Calendar, Eye, Pencil, Trash2, Search, Copy, Download, ClipboardCheck, ShieldAlert, ShieldCheck, ArrowRight, Inbox, CalendarPlus, Lock, Unlock, AlertTriangle } from 'lucide-react';
import { formatHours, formatDay, formatTimeRange, isoToLocalInput, countdown, timeAgo, eventPermissions } from '../utils/helpers';
import { api } from '../utils/api';
import Modal, { ModalHead } from '../components/Modal';
import { Seats, DateChip } from '../components/Seats';
import EmptyState from '../components/common/EmptyState';
import ConfirmDialog from '../components/common/ConfirmDialog';
import VerifyCertificateAction from '../components/common/VerifyCertificateAction';
import { CATEGORY_GROUPS } from '../eventCategories';
import { can } from '../authz';
/* Mirrored from the server so the two roster exports cannot disagree about what
   a safe cell is — the same reason src/authz.js imports server/authz.js. */
import { rosterOf, downloadRosterCsv } from '../utils/volunteerRoster';
import VolunteerRosterRow from '../components/organizer/VolunteerRosterRow';
import PreviewList from '../components/common/PreviewList';
import DateTimeField from '../components/common/DateTimeField';

/** How many volunteers the dashboard shows before "Show all". */
const ROSTER_PREVIEW = 6;
const TABS = [{
  id: 'active',
  label: 'Active'
}, {
  id: 'completed',
  label: 'Completed'
}];
export default function OrganizerDashboard({
  currentUser,
  events = [],
  applications = [],
  refreshEvents,
  addToast,
  onViewDetails,
  onViewVolunteerProfile,
  setActiveTab
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState('active');
  const [query, setQuery] = useState('');
  const [editingEvent, setEditingEvent] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [stats, setStats] = useState(null);
  /**
   * `null` until the answer is known, so the banner below is never rendered
   * speculatively. Three states, not two: unknown, outstanding, accepted.
   */
  const [agreementOutstanding, setAgreementOutstanding] = useState(null);
  // A deletion refused because the event is under a live safety review. Kept on
  // screen rather than left to a toast — see handleDelete.
  /* Holds the event a delete is being asked about. The sign-up count it shows
     was already computed for the old `window.confirm` string — it is the
     "no room to explain consequences" the runbook names at L5, and a dialog is
     where it can actually be read. */
  const [deletingEvent, setDeletingEvent] = useState(null);
  const [heldReason, setHeldReason] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.fetchOrganizerStats().then(s => !cancelled && setStats(s)).catch(() => {});
    api.fetchOrganizerAgreement()
      .then(s => !cancelled && setAgreementOutstanding(Boolean(s.required) && !s.accepted))
      // A failed status check must not invent an obligation. Staying silent is the
      // safe direction here: the server enforces the gate regardless, so the worst
      // case is a missing explanation rather than a false accusation.
      .catch(() => !cancelled && setAgreementOutstanding(false));
    return () => {
      cancelled = true;
    };
  }, [currentUser.id, events.length, applications.length]);
  const hosted = useMemo(() => events.filter(e => e.organizerId === currentUser.id), [events, currentUser.id]);
  const appsForMe = useMemo(() => applications.filter(a => hosted.some(e => e.id === a.eventId)), [applications, hosted]);
  const pendingApps = appsForMe.filter(a => a.status === 'pending');
  const acceptedApps = appsForMe.filter(a => a.status === 'accepted');

  // Events needing attention, most urgent first — this is the organizer's
  // actual job, so it leads the page instead of a stat wall.
  //
  // `overdue` means the deadline has passed and applicants are still undecided.
  // Nothing selects volunteers automatically, so those students are stuck:
  // not accepted, not rejected, and told nothing. Those events sort above
  // everything else because they are the only ones where the cost of another
  // day's delay lands on someone other than the organizer.
  const needsReview = useMemo(() => {
    const now = Date.now();
    return hosted.map(event => ({
      event,
      pending: pendingApps.filter(a => a.eventId === event.id).length,
      overdue: new Date(event.applicationDeadline).getTime() <= now
    })).filter(x => x.pending > 0).sort((a, b) => b.overdue - a.overdue || new Date(a.event.applicationDeadline) - new Date(b.event.applicationDeadline));
  }, [hosted, pendingApps]);
  const overdueReview = needsReview.filter(x => x.overdue);
  const stuckApplicants = overdueReview.reduce((sum, x) => sum + x.pending, 0);

  /**
   * Finished events whose hours are credited but not yet made permanent.
   *
   * ── Why this needs saying at all ──
   *
   * Closing out is a deliberate act, which is what stops a mistyped number
   * becoming permanent the instant the last checkbox is ticked. The cost of that
   * design is that it can simply not happen: an organizer finishes an event,
   * credits everybody, and never returns. Nothing is broken — the hours are
   * credited, the certificates are issued, the students are fine — so there is
   * no error anywhere to notice. It just never becomes final.
   *
   * ── Why it is not urgent, and must not look it ──
   *
   * Nobody is waiting on this. Unlike an undecided applicant, where a day's
   * delay lands on a student who is told nothing, an un-closed event costs
   * nobody anything today. So this uses `--brand` and the word "ready", not the
   * amber and red the applications card uses, and the copy says the hours are
   * still correctable before it mentions permanence. An organizer who reads it
   * as an alarm will close out to make the alarm go away, which is precisely the
   * unconsidered press the confirmation exists to prevent.
   *
   * ── Authorization ──
   *
   * `hosted` is already `organizerId === currentUser.id`, and `canManageHours`
   * below repeats the server's capability test. The server checks `canRunEvent`
   * on every attendance route regardless, so this decides what is OFFERED, never
   * what is allowed.
   */
  const canManageHours = can(currentUser, 'attendance.mark')
    || can(currentUser, 'organization.event.manage.own');
  const awaitingCloseOut = useMemo(() => {
    if (!canManageHours) return [];
    return hosted
      .filter(e => eventPermissions(e).canCloseOutHours)
      /* Longest-finished first: the one most likely to have been forgotten. */
      .sort((a, b) => new Date(a.endDatetime || a.startDatetime) - new Date(b.endDatetime || b.startDatetime));
  }, [hosted, canManageHours]);

  // Events with a shift running today — the only ones check-in is useful for.
  // Compared on local calendar day, not a 24h window: an organizer opening the
  // app at 8am for a 6pm shift should still see it.
  const todaysEvents = useMemo(() => {
    const sameDay = iso => {
      const d = new Date(iso);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    };
    return hosted.filter(e => e.status !== 'cancelled' && (e.slots || []).some(s => sameDay(s.startDatetime)));
  }, [hosted]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = tab === 'completed' ? hosted.filter(e => e.status === 'completed') : hosted.filter(e => e.status !== 'completed' && e.status !== 'cancelled');
    return source.filter(e => !q || e.title.toLowerCase().includes(q) || e.location.toLowerCase().includes(q)).sort((a, b) => new Date(a.startDatetime) - new Date(b.startDatetime));
  }, [hosted, tab, query]);
  const uniqueVolunteers = new Set(acceptedApps.map(a => a.userId)).size;
  const hoursCredited = stats?.hoursAwarded ?? 0;

  /* ── Actions ─────────────────────────────────────────────── */

  const handleDelete = async event => {
    setDeletingEvent(null);
    setHeldReason(null);
    try {
      await api.deleteEvent(event.id);
      addToast(`"${event.title}" deleted.`, 'success');
      if (refreshEvents) refreshEvents();
    } catch (err) {
      /**
       * A 409 already explains itself in full — "Could not delete: This event
       * cannot be deleted while…" says it twice — so the prefix is dropped and
       * the server's sentence stands.
       *
       * The evidence hold is additionally kept on screen rather than left to a
       * five-second toast. It is the one refusal here that the reader cannot
       * predict from anything on their own dashboard, and it is deliberately
       * NOT pre-computed onto the delete button: shipping a "this is under
       * review" flag with every event would tell the subject of a report, at
       * rest and on every page load, something the 409 only says if they try.
       */
      if (err.status === 409) setHeldReason(err.message);
      addToast(err.status === 409 ? err.message : `Could not delete: ${err.message}`, 'error');
    }
  };
  const handleToggleStatus = async event => {
    const next = event.status === 'open' ? 'closed' : 'open';
    try {
      await api.toggleEventStatus(event.id, next);
      addToast(next === 'open' ? 'Applications reopened.' : 'Applications closed.', 'success');
      if (refreshEvents) refreshEvents();
    } catch (err) {
      addToast(`Could not update: ${err.message}`, 'error');
    }
  };
  const handleDuplicate = async event => {
    try {
      await api.duplicateEvent(event.id);
      addToast(`Copied "${event.title}" with dates moved forward one week.`, 'success');
      if (refreshEvents) refreshEvents();
    } catch (err) {
      addToast(`Could not duplicate: ${err.message}`, 'error');
    }
  };
  const handleExport = async event => {
    try {
      const blob = await api.exportRosterCSV(event.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${event.title.replace(/[^a-z0-9]/gi, '_')}_roster.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addToast('Roster downloaded.', 'success');
    } catch (err) {
      addToast(`Could not export: ${err.message}`, 'error');
    }
  };
  const downloadRosterCSV = () => {
    downloadRosterCsv(acceptedApps);
    addToast('Roster downloaded.', 'success');
  };
  const saveEdit = async e => {
    e.preventDefault();
    if (!editForm.title?.trim()) {
      addToast('Give the event a name.', 'error');
      return;
    }
    try {
      await api.updateEvent(editingEvent.id, {
        title: editForm.title,
        description: editForm.description,
        category: editForm.category,
        location: editForm.location,
        applicationDeadline: new Date(editForm.applicationDeadline).toISOString(),
        autoApprove: editForm.autoApprove,
        slots: editingEvent.slots || []
      });
      addToast('Event updated.', 'success');
      setEditingEvent(null);
      if (refreshEvents) refreshEvents();
    } catch (err) {
      addToast(`Could not save: ${err.message}`, 'error');
    }
  };
  const startEdit = event => {
    setEditingEvent(event);
    setEditForm({
      title: event.title,
      category: event.category,
      description: event.description,
      location: event.location,
      applicationDeadline: isoToLocalInput(event.applicationDeadline),
      autoApprove: !!event.autoApprove
    });
  };

  /**
   * Above the approval gate, and it has to stay there.
   *
   * Five hooks run before this point, so when this `useMemo` sat *below* the
   * `if (!currentUser.verified)` return, an unverified render called 22 hooks and
   * a verified one called 23. React rejects that outright:
   * "Rendered more hooks than during the previous render."
   *
   * The trigger is routine — an admin approves a pending organizer who has this
   * page open, App.jsx refreshes `currentUser` over the socket, `verified` flips
   * 0→1 under a mounted component, and the dashboard white-screens at the moment
   * it was supposed to appear. Covered by src/hookOrder.test.jsx, which fails
   * with that exact error if this is moved back down.
   */
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

  /* ── Unverified organizers can't do anything yet ─────────── */
  if (!currentUser.verified) {
    return <div className="card empty s-fd1ec5">
        <span className="empty-icon s-dce988">
          <ShieldAlert size={20} />
        </span>
        <h3>Your organizer account is awaiting approval</h3>
        <p>
          A WeVolunteer administrator reviews every new organizer account, including{' '}
          <span className="strong">{currentUser.email}</span>, before it can post events. We will
          let you know when yours is approved; then you accept the Organizer Agreement, and you
          can post. You can look around Discover in the meantime.
        </p>
        {/* The sentence above says what to do next and this card used to offer
            nothing to do it with — on the one screen every organizer sees
            between registering and being approved. */}
        <Link to="/discover" className="btn btn-primary btn-sm">Discover</Link>
        <div className="alert alert-info s-2db5ef">
          <span>
            <span className="alert-title">Testing the demo?</span>{' '}
            Switch to the System Admin account in the demo bar above to approve yourself.
          </span>
        </div>
      </div>;
  }

  return <div className="stack-lg">
      {/**
        * The way out of the withheld state.
        *
        * An organizer who has not accepted the Organizer Agreement holds none of
        * the capabilities that reach a student, so this dashboard renders with
        * every panel empty and no explanation — which reads as a broken app rather
        * than as a pending obligation. First thing on the page, before anything
        * else, for the same reason the privacy notice puts its incompleteness
        * warning above any reassuring content.
        *
        * It renders only when the agreement is genuinely outstanding: `null` while
        * the status is still loading, so it never flashes at an organizer who has
        * already accepted.
        */}
      {agreementOutstanding && (
        <a className="alert alert-warn oa-banner" href="/organizer-agreement">
          <AlertTriangle size={18} aria-hidden="true" />
          <span className="stack-xs">
            {/* Worded for the organizer who has never had the tools as well as
                for one asked to accept a new version: "paused … restores
                everything" read as a suspension to somebody approved that day
                (final audit, Phase 5). */}
            <strong>One step before you can post: the Organizer Agreement</strong>
            <span className="small">
              Until you accept it, you cannot create events, see who applied, mark attendance,
              or message students. It takes a minute, and everything opens as soon as you do.
            </span>
            {/* The block is the link; this says so, because a warning card
                does not otherwise look like something to press. */}
            <span className="oa-banner-cta small">Read and accept the agreement</span>
          </span>
        </a>
      )}

      {/* `role="alert"` announces the refusal without moving focus, which would
          be an unexpected context change and would strand the focus ring. */}
      {heldReason && (
        <div className="alert alert-warn" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span className="stack-xs">
            <strong>This event is on hold</strong>
            <span className="small">{heldReason}</span>
          </span>
        </div>
      )}

      {/* The greeting row is also the page-action row. It was a heading with
          the whole width to itself; the action sits in the space that was
          already there rather than adding a band above it. */}
      <div className="dashboard-greeting" style={{ marginBottom: '-var(--s4)' }}>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 700 }}>
          {greetingMessage}
        </h2>
        <VerifyCertificateAction />
      </div>
      {/* ── What needs a decision ── */}
      {needsReview.length > 0 && <section className="card" style={{
      borderColor: overdueReview.length > 0 ? 'var(--danger)' : 'var(--warn)',
      borderLeftWidth: 3
    }}>
          <div className="card-body">
            <div className="row-between row-wrap s-615dbe">
              <div>
                <div className="eyebrow" style={{
              color: overdueReview.length > 0 ? 'var(--danger)' : 'var(--warn)'
            }}>
                  {overdueReview.length > 0 ? 'Applications closed — waiting on you' : 'Needs your decision'}
                </div>
                <h2 className="s-956c6f">
                  {pendingApps.length} application{pendingApps.length !== 1 ? 's' : ''} waiting
                  {needsReview.length > 1 && ` across ${needsReview.length} events`}
                </h2>
                {/* Said plainly, because the consequence falls on the students,
                    not on the organizer: nothing chooses volunteers on its own. */}
                {stuckApplicants > 0 && <p className="small s-00e727">
                    {stuckApplicants} {stuckApplicants === 1 ? 'volunteer has' : 'volunteers have'} been
                    waiting since the deadline passed on {overdueReview.length === 1 ? 'this event' : `${overdueReview.length} events`}.
                    They are not told anything until you decide.
                  </p>}
              </div>
              <button className="btn btn-primary" onClick={() => onViewDetails(needsReview[0].event)}>
                Review {needsReview.length > 1 ? 'the most overdue' : 'applications'} <ArrowRight size={15} />
              </button>
            </div>

            {needsReview.length > 1 && <div className="list s-2b52df">
                {needsReview.map(({
            event,
            pending,
            overdue
          }) => <button key={event.id} className="list-row s-0a650c" onClick={() => onViewDetails(event)}>
                    <DateChip iso={event.startDatetime} />
                    <span className="truncate s-49cdf8">
                      <span className="person-name truncate">{event.title}</span>
                      <span className="person-meta tnum">
                        {overdue ? `Applications closed ${timeAgo(event.applicationDeadline)}` : `Applications close ${countdown(event.applicationDeadline).toLowerCase()}`}
                      </span>
                    </span>
                    <span className={overdue ? 'tag tag-danger' : 'tag tag-warn'}>
                      {pending} {overdue ? 'awaiting reply' : 'pending'}
                    </span>
                  </button>)}
              </div>}
          </div>
        </section>}

      {/* ── Programme at a glance ── */}
      <section className="stats">
        <div className="stat">
          <div className="stat-label">Active events</div>
          <div className="stat-value">{hosted.filter(e => e.status === 'open' || e.status === 'closed').length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Volunteers confirmed</div>
          <div className="stat-value">{uniqueVolunteers}</div>
          <div className="stat-note">{acceptedApps.length} shift assignments</div>
        </div>
        <div className="stat">
          <div className="stat-label">Awaiting review</div>
          <div className="stat-value" style={{
          color: pendingApps.length ? 'var(--warn)' : undefined
        }}>
            {pendingApps.length}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Hours credited</div>
          <div className="stat-value accent">{formatHours(hoursCredited)}</div>
        </div>
      </section>
      {/**
        * ── Hours waiting to be made permanent ──
        *
        * A sibling card in the same decisions region rather than a row inside
        * the one above, because the two carry different urgencies and merging
        * them would flatten both: "3 students have been waiting since the
        * deadline" and "2 events are ready whenever you are" cannot share one
        * headline without one of them lying.
        *
        * After the applications card, for the same reason — that one is about
        * people who are stuck. And after the summary strip too, by the owner's
        * request (CK-12): "This box [the strip] should be above the review hours
        * box" — the review hours box being this card, which he pasted to name
        * it. `OrganizerDashboard.statOrder.test.jsx` asserts the order.
        *
        * The word is always "close out HOURS", never "close": this dashboard
        * already has a "Close sign-ups" control three sections down, and those
        * two actions are unrelated. One stops new applications; this one
        * permanently locks credited service hours.
        */}
      {awaitingCloseOut.length > 0 && (
        <section className="card s-closeout-card">
          <div className="card-body">
            <div className="row-between row-wrap s-615dbe">
              <div>
                <div className="eyebrow s-closeout-eyebrow">Ready when you are</div>
                <h2 className="s-956c6f">
                  {awaitingCloseOut.length} finished event{awaitingCloseOut.length !== 1 ? 's' : ''} with
                  hours not closed out
                </h2>
                <p className="small s-00e727">
                  The hours are credited and <strong>still correctable</strong>. Closing them out makes
                  them a permanent part of each volunteer&rsquo;s record, which cannot be undone.
                </p>
              </div>
              <button
                className="btn btn-secondary"
                onClick={() => onViewDetails(awaitingCloseOut[0], { mode: 'hours' })}
              >
                Review hours <ArrowRight size={15} />
              </button>
            </div>

            {awaitingCloseOut.length > 1 && (
              <div className="list s-2b52df">
                {awaitingCloseOut.map(event => (
                  <button
                    key={event.id}
                    className="list-row s-0a650c"
                    onClick={() => onViewDetails(event, { mode: 'hours' })}
                  >
                    <DateChip iso={event.startDatetime} />
                    <span className="truncate s-49cdf8">
                      <span className="person-name truncate">{event.title}</span>
                      <span className="person-meta tnum">Finished {timeAgo(event.endDatetime || event.startDatetime)}</span>
                    </span>
                    <span className="tag">Hours open</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}


      {/* ── Happening today ──────────────────────────────────────────────
          Check-in is the one screen used standing up, outdoors, on a phone,
          while volunteers arrive. Reaching it meant: open the app, find the
          event in a list, open the modal, locate the check-in button among the
          modal's other actions. Every one of those steps happens one-handed
          while somebody is asking where to put the cooler.
           So on the day, it leads the page and check-in is the primary action. */}
      {todaysEvents.length > 0 && <section className="card s-f231de">
          <div className="card-body">
            <div className="eyebrow s-89c83f">Happening today</div>
            <div className="list s-eabd0a">
              {todaysEvents.map(event => <div key={event.id} className="list-row row-between row-wrap s-615dbe">
                  <span className="truncate s-7b2db8">
                    <span className="person-name truncate">{event.title}</span>
                    <span className="person-meta tnum">
                      {formatTimeRange(event.startDatetime, event.endDatetime)} · {event.location}
                    </span>
                  </span>
                  <button className="btn btn-primary btn-sm" onClick={() => navigate(`/checkin/${event.id}`)}>
                    <ClipboardCheck size={14} /> Check in volunteers
                  </button>
                </div>)}
            </div>
          </div>
        </section>}

      {/* ── Events ── */}
      <section>
        <div className="section-head">
          <h2>Your events</h2>
          <button className="btn btn-primary btn-sm section-action" onClick={() => setActiveTab('create')}>
            <CalendarPlus size={14} /> New event
          </button>
        </div>

        <div className="toolbar">
          <div className="segmented" role="tablist" aria-label="Event status">
            {TABS.map((t, index) => <button key={t.id} role="tab" aria-selected={tab === t.id} aria-controls="org-events-panel" id={`org-tab-${t.id}`} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} onKeyDown={e => {
            let nextIndex = index;
            if (e.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;else if (e.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;else if (e.key === 'Home') nextIndex = 0;else if (e.key === 'End') nextIndex = TABS.length - 1;else return;
            e.preventDefault();
            const nextId = TABS[nextIndex].id;
            setTab(nextId);
            // Use setTimeout to ensure React updates the DOM before focusing
            setTimeout(() => document.getElementById(`org-tab-${nextId}`)?.focus(), 0);
          }}>
                {t.label}
              </button>)}
          </div>
          <div className="input-affix s-c0dc2c">
            <Search size={15} />
            <input type="search" className="input" placeholder="Find an event…" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search your events" />
          </div>
        </div>

        <div key={tab} id="org-events-panel" className="tabpanel" role="tabpanel" aria-labelledby={`org-tab-${tab}`} tabIndex={0}>

        {filtered.length === 0 ? <EmptyState icon={Calendar} title={query ? 'No events match that search' : tab === 'completed' ? 'No completed events yet' : 'No active events'} message={query ? 'Try a different name or location.' : tab === 'completed' ? 'Events move here once you take attendance.' : 'Create a sign-up sheet and volunteers can start claiming shifts.'} action={!query && tab === 'active' && <button className="btn btn-primary btn-sm" onClick={() => setActiveTab('create')}>
                  <CalendarPlus size={14} /> Create your first event
                </button>} /> : <div className="tablewrap">
            <div className="tablescroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Date</th>
                    <th className="s-8b224a">Sign-ups</th>
                    <th>Status</th>
                    <th className="cell-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(event => {
                  const evApps = appsForMe.filter(a => a.eventId === event.id);
                  const pending = evApps.filter(a => a.status === 'pending').length;
                  const accepted = evApps.filter(a => a.status === 'accepted').length;
                  const closed = event.status === 'closed' || new Date() > new Date(event.applicationDeadline);
                  const perms = eventPermissions(event);
                  return <tr key={event.id}>
                        <td>
                          <div className="cell-title truncate s-83eed1">{event.title}</div>
                          <div className="small dim truncate s-83eed1">
                            {event.category} · {event.location}
                          </div>
                        </td>
                        <td className="tnum">
                          <div className="small strong">{formatDay(event.startDatetime)}</div>
                          <div className="small dim">
                            {formatTimeRange(event.startDatetime, event.endDatetime)}
                          </div>
                        </td>
                        <td>
                          <Seats filled={accepted} total={event.maxSpots} />
                          {pending > 0 && <button className="tag tag-warn s-9c7e4f" onClick={() => onViewDetails(event)}>
                              {pending} to review
                            </button>}
                        </td>
                        <td>
                          {event.status === 'completed' ? <span className="status status-muted">Completed</span> : closed ? <span className="status status-muted">Closed</span> : <span className="status status-ok">Open</span>}
                        </td>
                        <td className="cell-actions">
                          <div className="row s-b7a2f0">
                            <button className="btn btn-ghost btn-sm btn-icon" title="Open event" onClick={() => onViewDetails(event)}>
                              <Eye size={14} />
                            </button>
                            {perms.canEditDetails && <button className="btn btn-ghost btn-sm btn-icon" title="Edit details" onClick={() => startEdit(event)}>
                                <Pencil size={14} />
                              </button>}
                            {perms.canChangeStatus && <button className="btn btn-ghost btn-sm btn-icon" title={event.status === 'open' ? 'Close sign-ups' : 'Reopen sign-ups'} onClick={() => handleToggleStatus(event)}>
                                {event.status === 'open' ? <Lock size={14} /> : <Unlock size={14} />}
                              </button>}
                            <button className="btn btn-ghost btn-sm btn-icon" title="Duplicate, one week later" onClick={() => handleDuplicate(event)}>
                              <Copy size={14} />
                            </button>
                            <button className="btn btn-ghost btn-sm btn-icon" title="Download roster as CSV" onClick={() => handleExport(event)}>
                              <Download size={14} />
                            </button>
                            {perms.canDelete && <button className="btn btn-ghost btn-sm btn-icon s-973ad1" title="Delete event" onClick={() => setDeletingEvent(event)}>
                                <Trash2 size={14} />
                              </button>}
                            {!perms.canDelete && <span className="btn btn-ghost btn-sm btn-icon s-17fa6c" title={perms.blockedReason} aria-label={perms.blockedReason}>
                                <ShieldCheck size={14} />
                              </span>}
                          </div>
                        </td>
                      </tr>;
                })}
                </tbody>
              </table>
            </div>
          </div>}
        </div>
      </section>

      {/* ── Volunteer roster ── */}
      <section>
        <div className="section-head">
          <h2>Your volunteers</h2>
          {acceptedApps.length > 0 && <button className="btn btn-secondary btn-sm section-action" onClick={downloadRosterCSV}>
              <Download size={14} /> Download ledger
            </button>}
        </div>
        {acceptedApps.length === 0 ? <div className="card empty">
            <span className="empty-icon"><Inbox size={18} /></span>
            <h3>No confirmed volunteers yet</h3>
            <p>Once you confirm applications, the people helping at your events show up here.</p>
          </div> : (
            /* Capped, with the rest on its own page — the owner's rule for every
               long list (FX-31): "show more … to take them to the specific
               webpage", never an expansion that grows the dashboard. A busy
               organizer had every volunteer they ever confirmed here. */
            <PreviewList
              items={rosterOf(acceptedApps)}
              cap={ROSTER_PREVIEW}
              className="list"
              label="volunteers"
              moreHref="/volunteers"
              moreLabel={`Show all ${rosterOf(acceptedApps).length} volunteers`}
              renderItem={person => (
                <VolunteerRosterRow key={person.id} person={person} onViewProfile={onViewVolunteerProfile} />
              )}
            />
          )}
      </section>

      {/* ── Quick edit ── */}
      {editingEvent && <Modal onClose={() => setEditingEvent(null)} label="Edit event">
          <ModalHead title="Edit event" description="Shifts and times are edited on the event's sign-up sheet." onClose={() => setEditingEvent(null)} />

            <form id="quick-edit" className="modal-body" onSubmit={saveEdit}>
              <div className="field">
                <label htmlFor="qe-title">Event name</label>
                <input id="qe-title" className="input" value={editForm.title || ''} onChange={e => setEditForm(f => ({
            ...f,
            title: e.target.value
          }))} />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="qe-cat">Category</label>
                  <select id="qe-cat" className="select" value={editForm.category || 'School'} onChange={e => setEditForm(f => ({
              ...f,
              category: e.target.value
            }))}>
                    {/* From the shared vocabulary, not a fourth hand-written
                        copy of it. The copy that used to be here offered five
                        values and would have silently re-filed an event in any
                        of the eleven added since. */}
                    {CATEGORY_GROUPS.map(({ group, categories }) => (
                      <optgroup key={group} label={group}>
                        {categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div className="field">
                  {/* The app's date picker and a time box, not the browser's
                      datetime control (ruling 8). */}
                  <DateTimeField
                    id="qe-deadline"
                    label="Applications close"
                    timeLabel="Closing time"
                    value={editForm.applicationDeadline || ''}
                    defaultTime="17:00"
                    onChange={v => setEditForm(f => ({ ...f, applicationDeadline: v }))}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="qe-loc">Location</label>
                <input id="qe-loc" className="input" value={editForm.location || ''} onChange={e => setEditForm(f => ({
            ...f,
            location: e.target.value
          }))} />
              </div>

              <div className="field">
                <label htmlFor="qe-desc">What volunteers need to know</label>
                <textarea id="qe-desc" className="textarea" value={editForm.description || ''} onChange={e => setEditForm(f => ({
            ...f,
            description: e.target.value
          }))} />
              </div>

              {/* Mirrors the wording on the create form exactly — the same
                  choice must not be described two different ways. */}
              <div className="field">
                <span className="label">Selection method</span>
                <div className="stack-sm">
                  <label className="check" data-checked={!editForm.autoApprove ? 'true' : 'false'}>
                    <input type="radio" name="edit-selection" checked={!editForm.autoApprove} onChange={() => setEditForm(f => ({
                ...f,
                autoApprove: false
              }))} />
                    <span>
                      <span className="check-title">Manual review</span>
                      <span className="check-desc">
                        You review applicants after the deadline and choose who is accepted, waitlisted, or rejected.
                      </span>
                    </span>
                  </label>
                  <label className="check" data-checked={editForm.autoApprove ? 'true' : 'false'}>
                    <input type="radio" name="edit-selection" checked={!!editForm.autoApprove} onChange={() => setEditForm(f => ({
                ...f,
                autoApprove: true
              }))} />
                    <span>
                      <span className="check-title">Auto Select</span>
                      <span className="check-desc">
                        After the deadline the system picks volunteers automatically, giving those with fewer hours a better chance while keeping everyone eligible.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </form>

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={() => setEditingEvent(null)}>Cancel</button>
            <button className="btn btn-primary" type="submit" form="quick-edit">Save changes</button>
          </div>
        </Modal>}

      {deletingEvent && (() => {
        /* Counted here so the dialog can say it in a sentence somebody reads,
           rather than in a `\n\n` the browser typeset for us. */
        const signups = appsForMe.filter(a => a.eventId === deletingEvent.id).length;
        return (
          <ConfirmDialog
            title="Delete this event?"
            confirmLabel="Delete"
            destructive
            onConfirm={() => handleDelete(deletingEvent)}
            onCancel={() => setDeletingEvent(null)}
          >
            <span>
              &ldquo;{deletingEvent.title}&rdquo; will be deleted.
              {signups > 0 && (
                <> <strong>{signups} volunteer sign-up{signups === 1 ? '' : 's'}</strong> will
                be removed with it.</>
              )}
              {' '}This cannot be undone.
            </span>
          </ConfirmDialog>
        );
      })()}
    </div>;
}

