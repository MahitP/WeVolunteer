import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useModal } from '../utils/useModal';
import {
  X, CalendarClock, Users, Zap, ShieldCheck,
  Pencil, ClipboardCheck, AlertCircle, Megaphone, MessageSquare, ListChecks, Info, Star, Flag
} from 'lucide-react';
import { api } from '../utils/api';
import {
  formatDay, formatTime, formatTimeRange, countdown,
  selectionMethodLabel, eventPermissions, usesAutoSelect
} from '../utils/helpers';
import EventEditForm from './EventEditForm';
import EventAttendance from './EventAttendance';
import EventComments from './EventComments';
import EventAnnouncements from './EventAnnouncements';
import EventShiftsTab from './EventShiftsTab';
import EventApplicantsTab from './EventApplicantsTab';
import AttendeeList from './AttendeeList';
import ReportModal from './ReportModal';
import Modal from './Modal';


export default function EventModal({
  event, currentUser, applications = [], onClose, refreshEvents, refreshApplications, addToast, onViewVolunteerProfile,
  isFavorited, onToggleFavorite
}) {
  const dialogRef = useModal(onClose);
  const navigate = useNavigate();
  const [mode, setMode] = useState('view'); // 'view' | 'edit' | 'attendance'
  const [tab, setTab] = useState('shifts');
  const [submitting, setSubmitting] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showRedrawModal, setShowRedrawModal] = useState(false);
  const [redrawReason, setRedrawReason] = useState('');
  const tabRefs = useRef({});
  const [selectedSlots, setSelectedSlots] = useState([]);

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
  const myApps = eventApps.filter(a => a.userId === currentUser?.id);
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

  const handleApply = async () => {
    if (selectedSlots.length === 0) return;
    setSubmitting(true);
    try {
      const results = await Promise.allSettled(selectedSlots.map(id => api.applyToSlot(event.id, id)));
      const failed = results.filter(r => r.status === 'rejected');
      const ok = results.length - failed.length;
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
      if (refreshEvents) refreshEvents();
      if (refreshApplications) refreshApplications();
    } finally {
      setSubmitting(false);
    }
  };

  const handleRelease = async (app, slotName) => {
    const confirmed = app.status === 'accepted';
    const message = confirmed
      ? `Release your spot for "${slotName}"?\n\n${event.organizerName} will be notified and the spot reopens for someone else.`
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
    { id: 'questions', label: 'Questions', icon: MessageSquare }
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
                  : mode === 'attendance' ? 'Finalise hours'
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
              <p className="lead">Mark who actually attended. Only the volunteers you tick are credited.</p>
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
                  <div className="small strong" style={{ marginTop: 2 }}>{event.location}</div>
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
                      {event.status === 'completed' ? 'Correct hours' : 'Finalise hours'}
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
              {tab === 'shifts' && (
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
