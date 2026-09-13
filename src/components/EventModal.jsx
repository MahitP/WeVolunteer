import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, Link } from 'react-router-dom';
import { useModal } from '../utils/useModal';
import {
  X, CalendarClock, Users, Zap, ShieldCheck,
  Pencil, ClipboardCheck, AlertCircle, Megaphone, MessageSquare, ListChecks, Info, Star, Flag, Scale,
  ShieldBan, Clock
} from 'lucide-react';
import { api } from '../utils/api';
import {
  formatDay, formatTime, formatTimeRange, countdown,
  selectionMethodLabel, eventPermissions, usesAutoSelect, haversineDistance
} from '../utils/helpers';
import { useLocationContext } from '../contexts/LocationContext';
import TagChips from './common/TagChips';
import { can } from '../authz';
import { DECISION_LABELS, isFinal } from '../appeals';
import LocationLink from './location/LocationLink';
import DirectionsButton from './location/DirectionsButton';
import MapReveal from './location/MapReveal';
import WeatherSummary from './location/WeatherSummary';
import TravelTime from './location/TravelTime';
import EventEditForm from './EventEditForm';
import EventAttendance from './EventAttendance';
import EventComments from './EventComments';
import EventAnnouncements from './EventAnnouncements';
import EventShiftsTab from './EventShiftsTab';
import EventApplicantsTab from './EventApplicantsTab';
import AttendeeList from './AttendeeList';
import ReportModal from './ReportModal';
import Modal from './Modal';
import { organizationPath } from '../utils/organizationUrl';


export default function EventModal({
  event, currentUser, applications = [], onClose, refreshEvents, refreshApplications, addToast, onViewVolunteerProfile,
  isFavorited, onToggleFavorite, initialMode = 'view'
}) {
  const dialogRef = useModal(onClose);
  const navigate = useNavigate();
  /**
   * Which screen this modal opens on. `'view' | 'edit' | 'attendance'`.
   *
   * `initialMode` exists so the organizer dashboard's close-out reminder can
   * land somebody ON the Closeout screen rather than beside a button that
   * reaches it. It arrives from the `?mode=` search parameter, which is how the
   * modal already carries `?event=` — so the destination survives a reload and a
   * shared link, like every other modal state here.
   *
   * ── Gated, because the parameter is user-supplied ──
   *
   * Until now `'attendance'` was reachable only from a button rendered inside
   * `{isOwner && …}`. A mode read from the URL has no such protection: any
   * signed-in student could type `?event=X&mode=hours` and, ungated, be handed
   * the full roster with names and credited hours — which `attendeeVisibility`
   * exists to control. So the request is honoured only for somebody who could
   * have pressed the button, and ignored (not refused) otherwise: a stale link
   * should open the event, not an error.
   *
   * The server refuses regardless — every attendance route checks `canRunEvent`
   * — so this is about not RENDERING what it would refuse to act on.
   *
   * The test is the server's, said in the same two parts: a capability that
   * admits the screen at all (`requireCapAny` on every attendance route), AND
   * standing to act on THIS event — hosting it, or holding the `event.moderate`
   * bypass that `canRunEvent` accepts. Written with `can()` and an id
   * comparison rather than role names, per the rule
   * `authz.completeness.test.js` enforces: `can()` for "may this kind of actor",
   * ids for "is this their own row".
   */
  const mayManageHours =
    (can(currentUser, 'attendance.mark') || can(currentUser, 'organization.event.manage.own'))
    && (currentUser?.id === event?.organizerId || can(currentUser, 'event.moderate'));
  const [mode, setMode] = useState(
    initialMode === 'attendance' && mayManageHours ? 'attendance' : 'view',
  );
  const [tab, setTab] = useState('shifts');
  const [submitting, setSubmitting] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showRedrawModal, setShowRedrawModal] = useState(false);
  const [redrawReason, setRedrawReason] = useState('');
  const tabRefs = useRef({});
  const [selectedSlots, setSelectedSlots] = useState([]);
  const [conflictData, setConflictData] = useState(null);
  const [pendingApplySlot, setPendingApplySlot] = useState(null);

  const [selectionRuns, setSelectionRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const eventApps = useMemo(
    () => applications.filter(a => a.eventId === event?.id),
    [applications, event?.id]
  );

  // Grouped before the early return so hook order stays stable
  const days = useMemo(() => {
    const map = new Map();
    for (const slot of event?.slots || []) {
      const key = new Date(slot.startDatetime).toDateString();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(slot);
    }
    return [...map.entries()]
      .sort(([a], [b]) => new Date(a) - new Date(b))
      .map(([day, slots]) => ({
        day,
        slots: [...slots].sort((a, b) => new Date(a.startDatetime) - new Date(b.startDatetime))
      }));
  }, [event?.slots]);

  /**
   * How far this event is from wherever the volunteer is standing.
   *
   * Computed here rather than read from `event.distance`: the server only fills
   * that field in when the request carried coordinates, which the browse list
   * does and the index feeding this modal does not. So a modal opened from the
   * calendar or the dashboard would show no distance at all.
   *
   * Doing it client-side also means the volunteer's exact position never leaves
   * the device. The browse filter sends a coordinate coarsened to about a
   * kilometre, which is fine for "within five miles" and much too coarse for a
   * number somebody reads — this one is exact because it is computed where the
   * exact position already is. `useLocationContext` holds it only in memory,
   * only for the session, and only after the volunteer has opted in.
   *
   * Above the early return, with the `days` memo, so hook order cannot shift
   * between a render with an event and one without.
   */
  const { location: myLocation } = useLocationContext();
  const distanceMiles = useMemo(() => {
    if (!myLocation || event?.latitude == null || event?.longitude == null) return null;
    return haversineDistance(myLocation.latitude, myLocation.longitude, event.latitude, event.longitude);
  }, [myLocation, event?.latitude, event?.longitude]);

  const permissions = eventPermissions(event);
  const isOwner = currentUser?.role === 'organizer' && currentUser.id === event?.organizerId;
  const isAdmin = currentUser?.role === 'admin';
  const canSeeRuns = isOwner || isAdmin;

  const loadSelectionRuns = useCallback(async () => {
    if (!event?.id || !usesAutoSelect(event)) return;
    setRunsLoading(true);
    try {
      setSelectionRuns(await api.fetchAutoSelectRuns(event.id));
    } catch (err) {
      console.error('Failed to load selection runs:', err);
    } finally {
      setRunsLoading(false);
    }
  }, [event]);

  // Hooks must run on every render, so this sits above the early return.
  useEffect(() => {
    if (tab === 'applicants' && canSeeRuns) loadSelectionRuns();
  }, [tab, canSeeRuns, loadSelectionRuns]);

  if (!event) return null;

  const isStudent = currentUser?.role === 'student';
  const deadlinePassed = new Date() > new Date(event.applicationDeadline);
  const signupsClosed = event.status !== 'open' || deadlinePassed;

  const pendingApps = eventApps.filter(a => a.status === 'pending');
  const waitlistApps = eventApps.filter(a => a.status === 'waitlisted');
  const acceptedApps = eventApps.filter(a => a.status === 'accepted');
  const myApps = eventApps.filter(a => a.userId === currentUser?.id && a.status !== 'withdrawn' && a.status !== 'rejected');
  const iAmConfirmed = myApps.some(a => a.status === 'accepted');

  /* ── Actions ─────────────────────────────────────────────── */

  const startCheckin = async () => {
    // Navigate to the mobile-first check-in view
    navigate(`/checkin/${event.id}`);
    onClose();
  };

  const handleRunAutoSelect = async () => {
    if (selectionRuns.length > 0) {
      setRedrawReason('');
      setShowRedrawModal(true);
      return;
    }
    await executeAutoSelect('');
  };

  const executeAutoSelect = async (reason) => {
    setSubmitting(true);
    try {
      const newRun = await api.runAutoSelect(event.id, reason);
      addToast(`Draft selection ${newRun.runNumber} ready to review.`, 'success');
      setShowRedrawModal(false);
      await loadSelectionRuns();
      if (refreshApplications) refreshApplications();
    } catch (err) {
      addToast(`Could not run selection: ${err.message}`, 'error');
      if (err.data?.code === 'draw_cap_reached') setShowRedrawModal(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmAutoSelect = async () => {
    setSubmitting(true);
    try {
      await api.confirmAutoSelect(event.id);
      addToast('Selection confirmed. Volunteers have been notified.', 'success');
      await loadSelectionRuns();
      if (refreshApplications) refreshApplications();
    } catch (err) {
      addToast(`Could not confirm selection: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApply = async (overrideSlotId = null) => {
    const slotsToApply = overrideSlotId ? [overrideSlotId] : selectedSlots;
    if (slotsToApply.length === 0) return;
    setSubmitting(true);
    setConflictData(null);
    try {
      const results = await Promise.allSettled(
        slotsToApply.map(id => api.applyToSlot(event.id, id, !!overrideSlotId))
      );
      const failed = results.filter(r => r.status === 'rejected');
      const ok = results.length - failed.length;
      
      const conflictError = failed.find(f => f.reason.data?.conflict);
      if (conflictError && !overrideSlotId) {
        setConflictData(conflictError.reason.data.conflict);
        setPendingApplySlot(slotsToApply.find(id => id === conflictError.reason.data.conflict.slotId) || slotsToApply[0]);
        // If there were other slots that succeeded, we should still clear them from selectedSlots
        if (ok > 0) {
           setSelectedSlots(prev => prev.filter(id => id === pendingApplySlot));
           addToast(`Applied for ${ok} shift${ok !== 1 ? 's' : ''}, but one had a conflict.`, 'info');
        }
        return; // Pause for user input
      }

      if (failed.length === 0) {
        addToast(
          usesAutoSelect(event)
            ? `Applied for ${ok} shift${ok !== 1 ? 's' : ''}. Auto Select will run after the deadline.`
            : `Applied for ${ok} shift${ok !== 1 ? 's' : ''}. ${event.organizerName} will review it.`,
          'success'
        );
      } else if (ok > 0) {
        addToast(`Applied for ${ok}, but ${failed.length} failed: ${failed[0].reason.message}`, 'error');
      } else {
        addToast(`Could not apply: ${failed[0].reason.message}`, 'error');
      }
      setSelectedSlots([]);
      setPendingApplySlot(null);
      if (refreshEvents) refreshEvents();
      if (refreshApplications) refreshApplications();
    } finally {
      setSubmitting(false);
    }
  };

  const handleRelease = async (app, slotName) => {
    const confirmed = app.status === 'accepted';
    const message = confirmed
      ? `Give up your spot for "${slotName}"?\n\n${event.organizerName} will be notified and the spot reopens for someone else.`
      : `Withdraw your application for "${slotName}"?`;
    if (!window.confirm(message)) return;
    setSubmitting(true);
    try {
      await api.withdrawApplication(app.id);
      addToast(confirmed ? 'Spot released. The organizer has been notified.' : 'Application withdrawn.', 'info');
      if (refreshEvents) refreshEvents();
      if (refreshApplications) refreshApplications();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const decide = async (appId, name, status) => {
    setSubmitting(true);
    try {
      await api.updateApplicationStatus(appId, status);
      const verb = { accepted: 'accepted', waitlisted: 'moved to the waitlist', rejected: 'rejected' }[status];
      addToast(`${name} ${verb}.`, 'success');
      if (refreshEvents) refreshEvents();
      if (refreshApplications) refreshApplications();
    } catch (err) {
      addToast(`Could not update ${name}: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const bulkDecide = async (appIds, status) => {
    setSubmitting(true);
    try {
      const res = await api.updateApplicationsBulk(appIds, status);
      const verb = { accepted: 'accepted', waitlisted: 'moved to the waitlist', rejected: 'rejected' }[status];

      const updated = res?.updated ?? 0;
      const skipped = res?.skipped ?? [];
      const full = skipped.filter(s => s.reason === 'slot_full').length;
      const already = skipped.filter(s => s.reason === 'already_accepted').length;

      const parts = [`${updated} volunteer${updated === 1 ? '' : 's'} ${verb}`];
      if (full > 0) parts.push(`${full} skipped — shift full`);
      if (already > 0) parts.push(`${already} already accepted`);

      addToast(parts.join(' · '), full > 0 ? 'info' : 'success');
      if (refreshEvents) refreshEvents();
      if (refreshApplications) refreshApplications();
    } catch (err) {
      addToast(`Bulk update failed: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const runEqualizer = async () => {
    setSubmitting(true);
    try {
      const res = await api.runAutoApprove(event.id);
      if (res.approvedCount > 0) {
        addToast(`Accepted ${res.approvedCount} volunteer${res.approvedCount !== 1 ? 's' : ''}, fewest hours first.`, 'success');
        if (refreshEvents) refreshEvents();
        if (refreshApplications) refreshApplications();
      } else {
        addToast('No one could be accepted — every shift is already full.', 'info');
      }
    } catch (err) {
      addToast(`Could not fill shifts: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  /* ── Edit mode ───────────────────────────────────────────── */

  const handleSaveEdit = async (payload) => {
    setSubmitting(true);
    try {
      await api.updateEvent(event.id, payload);
      addToast('Event updated.', 'success');
      setMode('view');
      if (refreshEvents) refreshEvents();
    } catch (err) {
      addToast(`Could not save: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  /* ── Tabs ────────────────────────────────────────────────── */

  const handleTabKeyDown = (e) => {
    const ids = tabs.map(t => t.id);
    const current = ids.indexOf(tab);
    if (current === -1) return;

    let next = null;
    if (e.key === 'ArrowRight') next = (current + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next === null) return;

    e.preventDefault();
    const nextId = ids[next];
    setTab(nextId);
    tabRefs.current[nextId]?.focus();
  };

  const tabs = [
    { id: 'shifts', label: 'Shifts', icon: CalendarClock },
    ...(isOwner || isAdmin
      ? [{ id: 'applicants', label: 'Applicants', icon: ListChecks, count: pendingApps.length }]
      : []),
    { id: 'attendees', label: isOwner || isAdmin ? 'Roster' : "Who's going", icon: Users },
    { id: 'updates', label: 'Updates', icon: Megaphone },
    /* The thread is gated on `directory.read` on the server — it names the
       students who wrote in it — so a role without it (partner, or an organizer
       who has not accepted the agreement) is not offered a tab that would 403. */
    ...(can(currentUser, 'directory.read')
      ? [{ id: 'questions', label: 'Questions', icon: MessageSquare }]
      : [])
  ];

  const now = new Date();
  const endedApps = acceptedApps.filter(a => a.slot?.endDatetime && new Date(a.slot.endDatetime) <= now);
  const unendedApps = acceptedApps.filter(a => !a.slot?.endDatetime || new Date(a.slot.endDatetime) > now);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={dialogRef} className="modal modal-lg" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={event.title}>

        {/* ── Header ── */}
        <div className="modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row row-wrap" style={{ gap: 'var(--s2)', marginBottom: 4 }}>
              <span className="tag tag-brand">{event.category}</span>
              <span className="tag tag-ok">{selectionMethodLabel(event)}</span>
              {signupsClosed && <span className="tag">Applications closed</span>}
            </div>
            <div className="row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
              <h2>
                {mode === 'edit' ? 'Edit event'
                  : mode === 'attendance' ? (event.hoursClosedOutAt ? 'Hours (final)' : 'Finalise hours')
                  : event.title}
              </h2>
              {mode === 'view' && currentUser?.role === 'student' && onToggleFavorite && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => onToggleFavorite(event.id)}
                  style={{ color: isFavorited ? 'var(--accent)' : 'var(--ink-3)', display: 'inline-flex' }}
                  title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <Star size={18} fill={isFavorited ? 'var(--accent)' : 'none'} />
                </button>
              )}
              {mode === 'view' && currentUser && currentUser.id !== event.organizerId && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => setShowReportModal(true)}
                  style={{ color: 'var(--danger)', display: 'inline-flex' }}
                  title="Report this event"
                >
                  <Flag size={18} />
                </button>
              )}
            </div>
            {mode === 'view' && (
              <p className="lead row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <span>Hosted by {event.organizerName}</span>
                {event.organizerVerified && (
                  <span className="tag tag-ok" title="This organizer has been verified by school staff">
                    <ShieldCheck size={10} /> Verified organizer
                  </span>
                )}
              </p>
            )}
            {mode === 'attendance' && (
              <p className="lead">
                {event.hoursClosedOutAt
                  ? 'These hours have been closed out and are part of each volunteer\u2019s permanent record.'
                  : 'Mark who actually attended. Only the volunteers you tick are credited.'}
              </p>
            )}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {/* ── Body ── */}
        {mode === 'edit' ? (
          <EventEditForm 
            event={event} 
            onSave={handleSaveEdit} 
            onCancel={() => setMode('view')} 
            addToast={addToast} 
          />
        ) : mode === 'attendance' ? (
          <EventAttendance
            event={event}
            acceptedApps={acceptedApps}
            onClose={() => setMode('view')}
            onComplete={() => {
              setMode('view');
              if (refreshEvents) refreshEvents();
              if (refreshApplications) refreshApplications();
            }}
            addToast={addToast}
          />
        ) : (
          <div className="modal-body">
            {/**
              * ── Every tag, which is what this surface is for ──
              *
              * The card shows four and counts the rest; this is where the rest
              * are. Until now they were nowhere: the only full list in the
              * codebase was in `EventDetailsExperience.jsx`, which has no
              * importers, so a `+9` on a card pointed at a page that did not
              * exist. `limit={Infinity}` rather than a large number, because
              * "all of them" is the rule and a number would be a second cap to
              * keep in step with `MAX_TAGS_PER_EVENT`.
              *
              * Interactive when the caller can filter, inert otherwise —
              * `onSelect` is `TagChips`'s own test for that, and the modal
              * opens over a filterable list on Discover but also over places
              * that have no filter to drive.
              */}
            {event.tags?.length > 0 && (
              <TagChips
                tags={event.tags}
                limit={Infinity}
                className="event-modal-tags"
              />
            )}

            {/* ── Facts ── */}
            <div className="inset" style={{ marginBottom: 'var(--s5)' }}>
              <div className="grid grid-3" style={{ gap: 'var(--s4)' }}>
                <div>
                  <div className="eyebrow">When</div>
                  <div className="small strong tnum" style={{ marginTop: 2 }}>{formatDay(event.startDatetime)}</div>
                  <div className="small muted tnum">{formatTimeRange(event.startDatetime, event.endDatetime)}</div>
                </div>
                <div>
                  <div className="eyebrow">Where</div>
                  <div className="small strong" style={{ marginTop: 2 }}>
                    <LocationLink
                      location={event.location}
                      address={event.address}
                      latitude={event.latitude}
                      longitude={event.longitude}
                    />
                  </div>
                  {/* The street address only when it says something the name did
                      not. "Reichler Park / Reichler Park" is noise. */}
                  {event.address && event.address !== event.location && (
                    <div className="small muted">{event.address}</div>
                  )}
                  {distanceMiles != null && (
                    <div className="small muted tnum">{distanceMiles.toFixed(1)} mi away</div>
                  )}
                </div>
                <div>
                  <div className="eyebrow">Applications close</div>
                  <div className="small strong tnum" style={{ marginTop: 2 }}>
                    {formatDay(event.applicationDeadline)}, {formatTime(event.applicationDeadline)}
                  </div>
                  <div className={`small ${deadlinePassed ? 'status status-danger' : 'muted'}`}>
                    {countdown(event.applicationDeadline)}
                  </div>
                </div>
              </div>

              {event.description && (
                <p className="small" style={{
                  marginTop: 'var(--s4)', paddingTop: 'var(--s4)',
                  borderTop: '1px solid var(--rule)', whiteSpace: 'pre-line', color: 'var(--ink-2)'
                }}>
                  {event.description}
                </p>
              )}
            </div>

            {/**
              * Getting there.
              *
              * Above "Before you go" on purpose: arrival instructions assume you
              * already know where you are going, so the directions and the
              * forecast belong first.
              *
              * Every part of this is conditional and the block degrades to
              * nothing. An event with no location information at all renders no
              * empty container, no heading and no disabled button.
              */}
            {(event.latitude != null || event.address || event.location) && (
              <div style={{ marginBottom: 'var(--s5)' }}>
                <div className="row row-wrap" style={{ gap: 'var(--s3)', marginBottom: 'var(--s3)' }}>
                  <DirectionsButton
                    latitude={event.latitude}
                    longitude={event.longitude}
                    address={event.address}
                    label={event.location}
                  />
                  <WeatherSummary
                    latitude={event.latitude}
                    longitude={event.longitude}
                    datetime={event.startDatetime}
                  />
                  {/* A rough driving time, on the same row as the directions
                      link that produces the real, traffic-aware one. Renders
                      nothing without location, without coordinates, or without a
                      routing provider configured. */}
                  <TravelTime latitude={event.latitude} longitude={event.longitude} />
                </div>
                <MapReveal
                  latitude={event.latitude}
                  longitude={event.longitude}
                  label={event.location}
                  height={220}
                />
              </div>
            )}

            {/* Arrival instructions are for people actually going */}
            {event.instructions && (iAmConfirmed || isOwner || isAdmin) && (
              <div className="alert alert-brand" style={{ marginBottom: 'var(--s5)' }}>
                <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  <span className="alert-title">Before you go</span>
                  <span style={{ display: 'block', whiteSpace: 'pre-line', marginTop: 2 }}>{event.instructions}</span>
                </span>
              </div>
            )}

            {/* ── Organizer controls ── */}
            {isOwner && (
              <div className="card card-pad" style={{ marginBottom: 'var(--s5)', background: 'var(--surface-2)' }}>
                <div className="row-between row-wrap" style={{ gap: 'var(--s3)' }}>
                  <div>
                    <div className="strong small">Organizer tools</div>
                    <div className="small muted">
                      {pendingApps.length > 0
                        ? `${pendingApps.length} application${pendingApps.length !== 1 ? 's' : ''} waiting on you`
                        : 'No applications waiting'}
                    </div>
                  </div>
                  <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
                    {permissions.canEditDetails ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setMode('edit')}>
                        <Pencil size={12} /> Edit event
                      </button>
                    ) : (
                      <span className="small dim" title={permissions.blockedReason}
                        style={{ alignSelf: 'center' }}>
                        Details locked
                      </span>
                    )}
                    {pendingApps.length > 0 && !signupsClosed && (
                      <button className="btn btn-secondary btn-sm" onClick={runEqualizer} disabled={submitting}
                        title="Fill open spots automatically, giving priority to volunteers with the fewest hours">
                        <Zap size={13} /> Fill fairly
                      </button>
                    )}
                    {unendedApps.length > 0 && (
                      <button className="btn btn-secondary btn-sm" onClick={startCheckin}
                        title="Mark people off as they arrive. Credits no hours.">
                        <ListChecks size={13} /> Check-in
                      </button>
                    )}
                    <button className="btn btn-primary btn-sm" onClick={() => setMode('attendance')}
                      disabled={endedApps.length === 0}
                      title={endedApps.length === 0
                        ? 'Hours can be finalised once a shift has ended'
                        : undefined}>
                      <ClipboardCheck size={13} />
                      {/* Three states, three words. "Correct hours" on an event
                          whose hours are already final would name an action the
                          server refuses; "View hours" says what the screen is
                          for once nothing on it can change. */}
                      {event.hoursClosedOutAt ? 'View hours'
                        : event.status === 'completed' ? 'Correct hours'
                          : 'Finalise hours'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Tabs ──
                Declaring role="tablist" is a promise about behaviour. Before
                this, the roles were here but nothing honoured the contract:
                no aria-controls, no panel association, no roving tabindex, no
                arrow keys. A screen reader announced "tab, 1 of 5" and then
                arrow keys did nothing — which is worse than plain buttons,
                because it tells the user to expect something that isn't there.

                Now: each tab owns an id, points at its panel, and only the
                selected tab is in the tab order (roving tabindex). Arrow keys
                move between tabs, Home/End jump to the ends. */}
            <div
              className="tabs"
              role="tablist"
              aria-label="Event sections"
              onKeyDown={handleTabKeyDown}
            >
              {tabs.map(({ id, label, icon: Icon, count }) => (
                <button
                  key={id}
                  id={`tab-${id}`}
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls={`tabpanel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  ref={el => { tabRefs.current[id] = el; }}
                  className="tab"
                  onClick={() => setTab(id)}
                >
                  <Icon size={14} />
                  {label}
                  {count > 0 && (
                    <>
                      <span className="tab-count" aria-hidden="true">{count}</span>
                      {/* The bare number reads as noise otherwise. */}
                      <span className="sr-only">({count} awaiting your decision)</span>
                    </>
                  )}
                </button>
              ))}
            </div>

            <div
              className="tabpanel"
              role="tabpanel"
              id={`tabpanel-${tab}`}
              aria-labelledby={`tab-${tab}`}
              tabIndex={0}
            >
              {/**
                * ── Banned from the club running this, and what to do about it ──
                *
                * Beside the participation controls rather than in a
                * notification, because a notification is read once and then
                * buried. Somebody who comes back to the event a fortnight later
                * and finds they cannot take part learns why where they are
                * standing, and can act on it without going hunting.
                *
                * Only ever the reader's OWN ban: `viewerBan` is keyed on the
                * session server-side and has no parameter to point elsewhere.
                *
                * Three states, because they need different things said. No
                * appeal yet — offer one. One waiting — say so, and do not offer
                * a second, which would just make two rows for one grievance.
                * One already decided — say what was decided, and stop.
                */}
              {/**
                * ── For the club's own members, and you are not one ──
                *
                * Said here rather than by removing the apply button, because a
                * disabled control with no explanation is the thing people press
                * twice and then give up on. It names the club and points at it:
                * the answer to "why can't I" is usually "join, then you can".
                *
                * Suppressed when they are banned — that notice is the more
                * specific one, and stacking two refusals reads as two problems.
                */}
              {tab === 'shifts' && !event.viewerBan?.banned
                && event.audience === 'organization' && event.viewerIsMember === false && (
                <div className="alert event-members-only" role="status">
                  <div>
                    <span className="alert-title">
                      This one is for {event.organizationName || 'the organization'}&rsquo;s members
                    </span>
                    <p className="small">
                      Anybody can see it. Only members can take a place on a shift.
                      {event.organizationSlug && (
                        <>
                          {' '}
                          <Link to={organizationPath(event.organizationSlug)}>
                            See {event.organizationName || 'the organization'}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {tab === 'shifts' && event.viewerBan?.banned && (
                <div className="alert alert-danger event-ban-notice" role="status">
                  <div className="stack-sm">
                    <span className="alert-title row" style={{ gap: 6 }}>
                      <ShieldBan size={16} aria-hidden="true" />
                      You are banned from {event.organizationName || 'this organization'}
                    </span>
                    <p className="small">
                      You cannot join this or any other opportunity they run.
                      {event.viewerBan.reason ? ` Reason: ${event.viewerBan.reason}` : ''}
                    </p>

                    {/**
                      * The appeal control, and the ONLY control offered here.
                      *
                      * The shift rows below used to render a disabled "Select"
                      * button under this notice — a Join button that is greyed
                      * out still reads as "you could join", and the reader is
                      * left to work out that the notice above is the reason. So
                      * the shift list is suppressed entirely when banned and
                      * this takes its place.
                      *
                      * Three states, because they mean three different things:
                      * no appeal yet (act), one waiting (wait), one decided
                      * (the outcome, which is what they actually want to know).
                      */}
                    {!event.viewerBan.appeal ? (
                      <p>
                        <button
                          type="button"
                          className="btn btn-danger-solid"
                          onClick={() => navigate(
                            `/appeals/new?subject=organization_ban&organization=${encodeURIComponent(event.organizationId)}`
                          )}
                        >
                          <Scale size={16} aria-hidden="true" /> Appeal
                        </button>
                      </p>
                    ) : isFinal(event.viewerBan.appeal.status) ? (
                      <>
                        <p className="small">
                          You appealed, and a manager decided:{' '}
                          {DECISION_LABELS[event.viewerBan.appeal.decision] || 'the decision was recorded'}.
                        </p>
                        {/**
                          * And they may appeal again.
                          *
                          * A decided appeal is not the end of the road — the
                          * server's only bar on a fresh one is the rate limit
                          * (five per subject per rolling thirty days), and the
                          * duplicate guard blocks a second LIVE appeal, not a
                          * second appeal. Showing the outcome with no way
                          * forward made the UI stricter than the policy, which
                          * on the one screen a banned student can reach reads
                          * as a dead end that is not real.
                          */}
                        <p>
                          <button
                            type="button"
                            className="btn btn-danger-solid"
                            onClick={() => navigate(
                              `/appeals/new?subject=organization_ban&organization=${encodeURIComponent(event.organizationId)}`
                            )}
                          >
                            <Scale size={16} aria-hidden="true" /> Appeal again
                          </button>
                        </p>
                      </>
                    ) : (
                      <p>
                        {/* Disabled, not hidden: the reader needs to see that
                            the thing they did is recorded and in progress. */}
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled
                          aria-disabled="true"
                        >
                          <Clock size={16} aria-hidden="true" /> Appeal Sent
                        </button>
                        <span className="small dim" style={{ display: 'block', marginTop: 'var(--s2)' }}>
                          Your appeal is with the organization&rsquo;s managers. You do not need to send another.
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              )}

              {tab === 'shifts' && !event.viewerBan?.banned && (
                <EventShiftsTab
                  event={event}
                  eventApps={eventApps}
                  currentUser={currentUser}
                  isStudent={isStudent}
                  isOwner={isOwner}
                  isAdmin={isAdmin}
                  signupsClosed={signupsClosed}
                  selectedSlots={selectedSlots}
                  handleSlotSelect={(id) => setSelectedSlots(prev =>
                    prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
                  )}
                  sendApplication={handleApply}
                  submitting={submitting}
                  onRelease={handleRelease}
                />
              )}

              {tab === 'applicants' && (
                <EventApplicantsTab
                  event={event}
                  eventApps={eventApps}
                  pendingApps={pendingApps}
                  acceptedApps={acceptedApps}
                  waitlistApps={waitlistApps}
                  signupsClosed={signupsClosed}
                  selectionRuns={selectionRuns}
                  runsLoading={runsLoading}
                  submitting={submitting}
                  handleRunAutoSelect={handleRunAutoSelect}
                  handleConfirmAutoSelect={handleConfirmAutoSelect}
                  onViewVolunteerProfile={onViewVolunteerProfile}
                  decide={decide}
                  bulkDecide={bulkDecide}
                />
              )}

              {tab === 'attendees' && (
                <AttendeeList
                  eventId={event.id}
                  currentUser={currentUser}
                  onViewVolunteer={isOwner || isAdmin ? onViewVolunteerProfile : null}
                />
              )}

              {tab === 'updates' && (
                <EventAnnouncements eventId={event.id} canPost={isOwner || isAdmin} addToast={addToast} />
              )}

              {tab === 'questions' && (
                <EventComments eventId={event.id} currentUser={currentUser} addToast={addToast} />
              )}
            </div>
          </div>
        )}
      </div>

      {showReportModal && (
        <ReportModal
          targetType="event"
          targetId={event.id}
          onClose={() => setShowReportModal(false)}
          addToast={addToast}
        />
      )}
      
      {conflictData && (
        <ConflictDialog
          conflict={conflictData}
          eventTitle={event.title}
          submitting={submitting}
          onCancel={() => setConflictData(null)}
          onContinue={() => handleApply(pendingApplySlot)}
        />
      )}

      {showRedrawModal && (
        <RedrawReasonModal
          runNumber={selectionRuns.length + 1}
          reason={redrawReason}
          onChange={setRedrawReason}
          submitting={submitting}
          onCancel={() => setShowRedrawModal(false)}
          onConfirm={() => executeAutoSelect(redrawReason.trim())}
        />
      )}
    </div>
  );
}

/**
 * Collects the reason for re-running Auto Select.
 *
 * This exists as a real dialog rather than a window.prompt because of what the
 * field is for: a fairness mechanism that can be re-rolled needs a record of
 * why, and that record is shown to administrators. A bare system prompt with
 * no explanation and no validation reliably produces "n/a" — which is worse
 * than no audit trail, because it looks like one.
 *
 * The minimum length is deliberate but modest: enough to stop a single
 * character, not so much that it becomes an obstacle to a legitimate re-draw.
 */
/**
 * The schedule-conflict dialog.
 *
 * Two things were wrong with the previous version, and the visible one was a
 * symptom of the structural one.
 *
 * It was a second hand-rolled `.modal-overlay` rendered INSIDE the event
 * modal's own overlay. Both carried `z-index: 1000`, and the ancestor overlay
 * sets `backdrop-filter: blur(8px)` — which makes it a containing block for
 * `position: fixed` descendants. So the nested overlay stopped being
 * viewport-positioned and rendered as a translucent panel laid over the event
 * modal, with its text colliding with the content behind it and headings
 * wrapping mid-phrase. Portalling to document.body takes it out of that
 * containing block entirely; `.modal-overlay-stacked` then puts it deliberately
 * above the dialog that opened it, rather than relying on DOM order.
 *
 * Going through the shared `Modal` is what brings Escape, focus containment,
 * focus restore, scroll lock and `role="dialog" aria-modal` — none of which the
 * hand-rolled version had, so the conflict warning could not be dismissed from
 * the keyboard.
 *
 * The copy is the other half. A bare "⚠️ Schedule Conflict" with an OK/Cancel
 * pair reads like a browser alert, which is exactly what a decision about
 * double-booking a Saturday morning should not read like. The severity is a
 * status pill in the system's own language, the clash is laid out with the same
 * eyebrow-and-value structure as the event's own facts block, and the buttons
 * say what they do instead of "Cancel"/"Continue Anyway".
 */
function ConflictDialog({ conflict, eventTitle, submitting, onCancel, onContinue }) {
  // level 2 = already ACCEPTED elsewhere, which is a firm commitment someone is
  // expecting them at. level 1 = another pending application, which is not.
  const isConfirmed = conflict.level === 2;

  return createPortal(
    <Modal
      onClose={onCancel}
      label={isConfirmed ? 'You already have a shift at this time' : 'This overlaps another application'}
      overlayClassName="modal-overlay-stacked"
      className="conflict-dialog"
    >
      <div className="modal-head">
        <div>
          {/* status-pending carries the system's amber-adjacent "needs a decision"
              tone; status-info is the calmer blue. There is no status-warn. The
              pill draws its own dot via ::before, so no icon is needed. */}
          <span className={`status ${isConfirmed ? 'status-pending' : 'status-info'}`}>
            {isConfirmed ? 'Time clash' : 'Overlapping application'}
          </span>
          <h2>
            {isConfirmed
              ? 'You already have a shift at this time'
              : 'This overlaps another application'}
          </h2>
          <p className="lead">
            {isConfirmed
              ? `You are confirmed for another shift that runs at the same time as ${eventTitle}. `
                + 'If you take both, you cannot attend both — and the organizer expecting you '
                + 'will be left short.'
              : `You have applied to another shift that runs at the same time as ${eventTitle}. `
                + 'Applying to both is fine, but if both organizers accept you, you will have '
                + 'to release one.'}
          </p>
        </div>
        <button className="modal-close" onClick={onCancel} aria-label="Close dialog">
          <X size={18} />
        </button>
      </div>

      <div className="modal-body">
        <div className="inset conflict-detail">
          <div className="eyebrow">{isConfirmed ? 'Your confirmed shift' : 'Your other application'}</div>
          <div className="strong conflict-detail-title">{conflict.title}</div>
          {conflict.slotName && <div className="small muted">{conflict.slotName}</div>}
          <div className="small tnum conflict-detail-time">
            {formatDay(conflict.start)} · {formatTime(conflict.start)} – {formatTime(conflict.end)}
          </div>
        </div>
      </div>

      <div className="modal-foot">
        {/* The safe choice is the plain one and comes first, but it is not the
            primary action — the person opened this dialog intending to apply. */}
        <button className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
          {isConfirmed ? 'Keep my current shift' : 'Leave it for now'}
        </button>
        <button className="btn btn-primary" onClick={onContinue} disabled={submitting}>
          {submitting ? 'Applying…' : 'Apply to this shift too'}
        </button>
      </div>
    </Modal>,
    document.body
  );
}

const MIN_REDRAW_REASON = 10;

function RedrawReasonModal({ runNumber, reason, onChange, submitting, onCancel, onConfirm }) {
  const trimmed = reason.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_REDRAW_REASON;
  const canSubmit = trimmed.length >= MIN_REDRAW_REASON && !submitting;

  return (
    <Modal onClose={onCancel} label="Reason for re-running Auto Select">
      <div className="modal-head">
        <div>
          <h2>Re-run Auto Select?</h2>
          <p className="lead">This will be draw {runNumber} for this event.</p>
        </div>
        <button className="modal-close" onClick={onCancel} aria-label="Close"><X size={18} /></button>
      </div>

      <div className="modal-body">
        <div className="alert alert-warn" style={{ marginBottom: 'var(--s4)' }}>
          <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Every draw is kept, and your reason is <strong>permanently recorded</strong> and visible to
            administrators. This is what makes the draw auditable if a volunteer or parent asks why the
            selection was run again.
          </span>
        </div>

        <div className="field" style={{ marginTop: 0 }}>
          <label htmlFor="redraw-reason">Why are you re-running the draw?</label>
          <textarea
            id="redraw-reason"
            className="textarea"
            value={reason}
            autoFocus
            aria-invalid={tooShort}
            placeholder="e.g. Two selected students withdrew after the draw, so the shift was left short."
            onChange={e => onChange(e.target.value)}
          />
          {tooShort
            ? <span className="field-error"><AlertCircle size={12} />Please give a little more detail ({MIN_REDRAW_REASON} characters minimum)</span>
            : <span className="field-hint">A specific sentence. "n/a" or "retry" will not mean anything to whoever reads this later.</span>}
        </div>
      </div>

      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button className="btn btn-primary" onClick={onConfirm} disabled={!canSubmit}>
          {submitting ? 'Running…' : `Run draw ${runNumber}`}
        </button>
      </div>
    </Modal>
  );
}
