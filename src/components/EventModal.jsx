import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useModal } from '../utils/useModal';
import {
  X, CalendarClock, Users, Check, Clock4, Plus, Trash2, Zap, ShieldCheck,
  Pencil, ClipboardCheck, AlertCircle, Megaphone, MessageSquare, ListChecks, Info, Star
} from 'lucide-react';
import { api } from '../utils/api';
import {
  formatHours, formatDay, formatTime, formatTimeRange, isoToLocalInput, countdown, gradeLabel,
  usesAutoSelect, selectionMethodLabel, eventPermissions
} from '../utils/helpers';
import { Seats } from './Seats';
import EventComments from './EventComments';
import EventAnnouncements from './EventAnnouncements';
import AttendeeList from './AttendeeList';
import ApplicantReview from './ApplicantReview';

const CATEGORIES = [
  { value: 'School', label: 'School project' },
  { value: '5K', label: '5K run / athletics' },
  { value: 'Food Pantry', label: 'Food pantry' },
  { value: 'Fundraiser', label: 'Fundraiser' },
  { value: 'Other', label: 'Other community service' }
];

export default function EventModal({
  event, currentUser, applications = [], onClose, onStateChange, addToast, onViewVolunteerProfile,
  isFavorited, onToggleFavorite
}) {
  const dialogRef = useModal(onClose);
  const [mode, setMode] = useState('view'); // 'view' | 'edit' | 'attendance'
  const [tab, setTab] = useState('shifts');
  const [submitting, setSubmitting] = useState(false);
  const [selectedSlots, setSelectedSlots] = useState([]);

  const [editForm, setEditForm] = useState({
    title: event?.title || '',
    category: event?.category || 'School',
    description: event?.description || '',
    instructions: event?.instructions || '',
    location: event?.location || '',
    applicationDeadline: event?.applicationDeadline || '',
    attendeeVisibility: event?.attendeeVisibility || 'accepted'
  });
  const [editSlots, setEditSlots] = useState(event?.slots || []);
  const [editErrors, setEditErrors] = useState({});
  const [attendanceMap, setAttendanceMap] = useState({});
  // Only volunteers the organizer has explicitly marked are submitted. Without
  // this an unticked box would be indistinguishable from "recorded as absent".
  const [touchedIds, setTouchedIds] = useState(new Set());
  const [attendanceReason, setAttendanceReason] = useState('');
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
  }, [event?.id, event?.autoApprove]);

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

  /**
   * Opening the attendance screen no longer pre-ticks everyone.
   *
   * It used to default every accepted volunteer to present, which on a
   * multi-date event meant saving after the first day credited hours to
   * everyone signed up for every later date too. Marks now start from what has
   * actually been recorded — an existing attendance record, or a check-in mark
   * taken on the day — and anything else needs an explicit tick.
   */
  const startAttendance = async () => {
    const initial = {};
    const touched = new Set();

    for (const a of acceptedApps) {
      if (a.attendance) {
        initial[a.id] = a.attendance.present;
        touched.add(a.id);
      }
    }

    try {
      const checkins = await api.fetchCheckins(event.id);
      const byPair = new Map(checkins.map(c => [`${c.slotId}:${c.userId}`, c.present]));
      for (const a of acceptedApps) {
        if (a.attendance) continue;
        const mark = byPair.get(`${a.slotId}:${a.userId}`);
        if (mark !== undefined) {
          initial[a.id] = mark;   // carrying forward a deliberate mark, not a default
          touched.add(a.id);
        }
      }
    } catch {
      // Check-in marks are a convenience; the screen still works without them.
    }

    setAttendanceMap(initial);
    setTouchedIds(touched);
    setAttendanceReason('');
    setMode('attendance');
  };

  const startCheckin = async () => {
    const initial = {};
    try {
      const checkins = await api.fetchCheckins(event.id);
      const byPair = new Map(checkins.map(c => [`${c.slotId}:${c.userId}`, c.present]));
      for (const a of acceptedApps) {
        const mark = byPair.get(`${a.slotId}:${a.userId}`);
        if (mark !== undefined) initial[a.id] = mark;
      }
    } catch { /* start from a blank sheet */ }
    setAttendanceMap(initial);
    setTouchedIds(new Set(Object.keys(initial)));
    setMode('checkin');
  };

  const setMark = (appId, value) => {
    setAttendanceMap(m => ({ ...m, [appId]: value }));
    setTouchedIds(prev => new Set(prev).add(appId));
  };

  const markAll = (apps, value) => {
    setAttendanceMap(m => ({ ...m, ...Object.fromEntries(apps.map(a => [a.id, value])) }));
    setTouchedIds(prev => new Set([...prev, ...apps.map(a => a.id)]));
  };

  const submitCheckin = async () => {
    setSubmitting(true);
    try {
      const payload = Object.fromEntries(
        [...touchedIds].filter(id => id in attendanceMap).map(id => [id, !!attendanceMap[id]])
      );
      const res = await api.submitCheckins(event.id, payload);
      addToast(`Check-in saved for ${res.marked} volunteer${res.marked !== 1 ? 's' : ''}. No hours credited yet.`, 'success');
      setMode('view');
    } catch (err) {
      addToast(`Could not save check-in: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const submitAttendance = async () => {
    setSubmitting(true);
    try {
      // Only explicitly-marked volunteers are sent. Anything untouched is left
      // exactly as it is on the server rather than being recorded as absent.
      const payload = Object.fromEntries(
        [...touchedIds].filter(id => id in attendanceMap).map(id => [id, !!attendanceMap[id]])
      );
      const res = await api.submitAttendance(event.id, payload, attendanceReason);
      const credited = res.credited?.length || 0;
      const revoked = res.revoked?.length || 0;
      addToast(
        [
          credited ? `${credited} volunteer${credited !== 1 ? 's' : ''} credited` : '',
          revoked ? `${revoked} record${revoked !== 1 ? 's' : ''} corrected` : '',
          !credited && !revoked ? 'No changes to save' : ''
        ].filter(Boolean).join(' · '),
        credited || revoked ? 'success' : 'info'
      );
      if (res.eventCompleted) addToast('Every shift is accounted for — this event is now complete.', 'info');
      setMode('view');
      setAttendanceReason('');
      onStateChange();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRunAutoSelect = async () => {
    setSubmitting(true);
    try {
      const newRun = await api.runAutoSelect(event.id);
      addToast(`Draft selection ${newRun.runNumber} ready to review.`, 'success');
      await loadSelectionRuns();
      onStateChange();
    } catch (err) {
      addToast(`Could not run selection: ${err.message}`, 'error');
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
      onStateChange();
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
      onStateChange();
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
      onStateChange();
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
      onStateChange();
    } catch (err) {
      addToast(`Could not update ${name}: ${err.message}`, 'error');
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
        onStateChange();
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

  const validateEdit = () => {
    const errs = {};
    if (!editForm.title.trim()) errs.title = 'Give the event a name';
    if (!editForm.description.trim()) errs.description = 'Describe what volunteers will do';
    if (!editForm.location.trim()) errs.location = 'Add a location';
    if (!editForm.applicationDeadline) errs.applicationDeadline = 'Set an application deadline';
    if (editSlots.length === 0) errs.slots = 'An event needs at least one shift';

    editSlots.forEach((slot, i) => {
      if (!slot.name?.trim()) errs[`slot-${i}-name`] = 'Name this shift';
      if (!slot.startDatetime || !slot.endDatetime) errs[`slot-${i}-time`] = 'Set a start and end time';
      else if (new Date(slot.startDatetime) >= new Date(slot.endDatetime)) {
        errs[`slot-${i}-time`] = 'End time must be after the start time';
      }
      if (Number(slot.maxSpots) <= 0) errs[`slot-${i}-maxSpots`] = 'At least one spot';
    });

    setEditErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    if (!validateEdit()) {
      addToast('Check the highlighted fields before saving.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.updateEvent(event.id, {
        ...editForm,
        applicationDeadline: new Date(editForm.applicationDeadline).toISOString(),
        autoApprove: event.autoApprove,
        slots: editSlots.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          startDatetime: new Date(s.startDatetime).toISOString(),
          endDatetime: new Date(s.endDatetime).toISOString(),
          maxSpots: Number(s.maxSpots)
        }))
      });
      addToast('Event updated.', 'success');
      setMode('view');
      onStateChange();
    } catch (err) {
      addToast(`Could not save: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = () => {
    setEditForm({
      title: event.title,
      category: event.category,
      description: event.description,
      instructions: event.instructions || '',
      location: event.location,
      applicationDeadline: event.applicationDeadline,
      attendeeVisibility: event.attendeeVisibility || 'accepted'
    });
    setEditSlots(event.slots || []);
    setEditErrors({});
    setMode('edit');
  };

  const changeSlot = (i, field, value) =>
    setEditSlots(prev => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));

  const addSlot = () => {
    const base = event.slots?.[0]?.startDatetime || new Date().toISOString();
    const day = isoToLocalInput(base).split('T')[0];
    setEditSlots(prev => [...prev, {
      id: `new-${Date.now()}`, name: '', description: '',
      startDatetime: `${day}T09:00`, endDatetime: `${day}T11:00`, maxSpots: 2
    }]);
  };

  /* ── Tabs ────────────────────────────────────────────────── */

  const tabs = [
    { id: 'shifts', label: 'Shifts', icon: CalendarClock },
    ...(isOwner || isAdmin
      ? [{ id: 'applicants', label: 'Applicants', icon: ListChecks, count: pendingApps.length }]
      : []),
    { id: 'attendees', label: isOwner || isAdmin ? 'Roster' : "Who's going", icon: Users },
    { id: 'updates', label: 'Updates', icon: Megaphone },
    { id: 'questions', label: 'Questions', icon: MessageSquare }
  ];

  /* ── Attendance / check-in derived state ─────────────────── */

  // Hours can only be finalised for shifts that are over; check-in is for the
  // ones that are not. Splitting the list here is what stops an organizer
  // crediting a shift that has not happened.
  const now = new Date();
  const endedApps = acceptedApps.filter(a => a.slot?.endDatetime && new Date(a.slot.endDatetime) <= now);
  const unendedApps = acceptedApps.filter(a => !a.slot?.endDatetime || new Date(a.slot.endDatetime) > now);
  const markableApps = mode === 'checkin' ? unendedApps : endedApps;

  const markedCount = markableApps.filter(a => touchedIds.has(a.id)).length;
  const presentCount = markableApps.filter(a => touchedIds.has(a.id) && attendanceMap[a.id]).length;
  const correctionCount = markableApps.filter(
    a => touchedIds.has(a.id) && a.attendance && a.attendance.present !== !!attendanceMap[a.id]
  ).length;

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
                  : mode === 'checkin' ? 'Check-in'
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
            {mode === 'checkin' && (
              <p className="lead">Tick people off as they arrive. This credits no hours — you finalise those after the shift ends.</p>
            )}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {/* ── Edit ── */}
        {mode === 'edit' ? (
          <>
            <form id="edit-event-form" className="modal-body" onSubmit={saveEdit}>
              <div className="field">
                <label htmlFor="ev-title">Event name</label>
                <input id="ev-title" className="input" value={editForm.title}
                  aria-invalid={!!editErrors.title}
                  onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} />
                {editErrors.title && <span className="field-error"><AlertCircle size={12} />{editErrors.title}</span>}
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="ev-cat">Category</label>
                  <select id="ev-cat" className="select" value={editForm.category}
                    onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ev-deadline">Applications close</label>
                  <input id="ev-deadline" type="datetime-local" className="input"
                    value={isoToLocalInput(editForm.applicationDeadline)}
                    aria-invalid={!!editErrors.applicationDeadline}
                    onChange={e => setEditForm(f => ({ ...f, applicationDeadline: e.target.value }))} />
                  {editErrors.applicationDeadline && (
                    <span className="field-error"><AlertCircle size={12} />{editErrors.applicationDeadline}</span>
                  )}
                </div>
              </div>

              <div className="field">
                <label htmlFor="ev-loc">Location</label>
                <input id="ev-loc" className="input" value={editForm.location}
                  aria-invalid={!!editErrors.location}
                  onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} />
                {editErrors.location && <span className="field-error"><AlertCircle size={12} />{editErrors.location}</span>}
              </div>

              <div className="field">
                <label htmlFor="ev-desc">What volunteers will be doing</label>
                <textarea id="ev-desc" className="textarea" value={editForm.description}
                  aria-invalid={!!editErrors.description}
                  onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} />
                {editErrors.description && <span className="field-error"><AlertCircle size={12} />{editErrors.description}</span>}
              </div>

              <div className="field">
                <label htmlFor="ev-instr">Arrival instructions <span className="dim" style={{ fontWeight: 400 }}>(optional)</span></label>
                <textarea id="ev-instr" className="textarea" style={{ minHeight: 64 }}
                  value={editForm.instructions}
                  placeholder="Where to park, who to check in with, what to bring."
                  onChange={e => setEditForm(f => ({ ...f, instructions: e.target.value }))} />
                <span className="field-hint">Shown to volunteers once they're confirmed.</span>
              </div>

              <div className="field">
                <span className="label">Who can see the volunteer list</span>
                <div className="stack-sm">
                  <label className="check" data-checked={editForm.attendeeVisibility === 'accepted' ? 'true' : 'false'}>
                    <input type="radio" name="vis" checked={editForm.attendeeVisibility === 'accepted'}
                      onChange={() => setEditForm(f => ({ ...f, attendeeVisibility: 'accepted' }))} />
                    <span>
                      <span className="check-title">Confirmed volunteers</span>
                      <span className="check-desc">Anyone accepted can see who else is coming. Recommended — it helps people coordinate rides and feel part of a group.</span>
                    </span>
                  </label>
                  <label className="check" data-checked={editForm.attendeeVisibility === 'private' ? 'true' : 'false'}>
                    <input type="radio" name="vis" checked={editForm.attendeeVisibility === 'private'}
                      onChange={() => setEditForm(f => ({ ...f, attendeeVisibility: 'private' }))} />
                    <span>
                      <span className="check-title">Only me</span>
                      <span className="check-desc">Volunteers see how many spots are taken, but not who has them.</span>
                    </span>
                  </label>
                </div>
              </div>

              <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
                <h3>Shifts</h3>
                <button type="button" className="btn btn-secondary btn-sm section-action" onClick={addSlot}>
                  <Plus size={13} /> Add shift
                </button>
              </div>

              {editErrors.slots && (
                <div className="alert alert-danger" style={{ marginBottom: 'var(--s4)' }}>{editErrors.slots}</div>
              )}

              <div className="stack">
                {editSlots.map((slot, i) => (
                  <div key={slot.id || i} className="inset">
                    <div className="row-between" style={{ marginBottom: 'var(--s3)' }}>
                      <span className="eyebrow">Shift {i + 1}</span>
                      <button type="button" className="btn btn-ghost btn-sm"
                        onClick={() => setEditSlots(prev => prev.filter((_, idx) => idx !== i))}
                        aria-label={`Remove shift ${i + 1}`}>
                        <Trash2 size={13} />
                      </button>
                    </div>

                    <div className="field-row" style={{ marginTop: 0 }}>
                      <div className="field">
                        <label>Role</label>
                        <input className="input" value={slot.name || ''} placeholder="e.g. Grill helper"
                          aria-invalid={!!editErrors[`slot-${i}-name`]}
                          onChange={e => changeSlot(i, 'name', e.target.value)} />
                        {editErrors[`slot-${i}-name`] && <span className="field-error">{editErrors[`slot-${i}-name`]}</span>}
                      </div>
                      <div className="field">
                        <label>Spots</label>
                        <input type="number" min="1" className="input" value={slot.maxSpots}
                          aria-invalid={!!editErrors[`slot-${i}-maxSpots`]}
                          onChange={e => changeSlot(i, 'maxSpots', e.target.value)} />
                        {editErrors[`slot-${i}-maxSpots`] && <span className="field-error">{editErrors[`slot-${i}-maxSpots`]}</span>}
                      </div>
                    </div>

                    <div className="field-row">
                      <div className="field">
                        <label>Starts</label>
                        <input type="datetime-local" className="input" value={isoToLocalInput(slot.startDatetime)}
                          onChange={e => changeSlot(i, 'startDatetime', e.target.value)} />
                      </div>
                      <div className="field">
                        <label>Ends</label>
                        <input type="datetime-local" className="input" value={isoToLocalInput(slot.endDatetime)}
                          onChange={e => changeSlot(i, 'endDatetime', e.target.value)} />
                      </div>
                    </div>
                    {editErrors[`slot-${i}-time`] && (
                      <span className="field-error" style={{ marginTop: 6 }}>
                        <AlertCircle size={12} />{editErrors[`slot-${i}-time`]}
                      </span>
                    )}

                    <div className="field">
                      <label>Details (optional)</label>
                      <input className="input" value={slot.description || ''}
                        placeholder="e.g. Bring closed-toe shoes"
                        onChange={e => changeSlot(i, 'description', e.target.value)} />
                    </div>
                  </div>
                ))}
              </div>
            </form>

            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setMode('view')}>Cancel</button>
              <button className="btn btn-primary" type="submit" form="edit-event-form" disabled={submitting}>
                {submitting ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </>
        ) : mode === 'attendance' || mode === 'checkin' ? (
          <>
            <div className="modal-body">
              <div className={`alert ${mode === 'checkin' ? 'alert-info' : 'alert-brand'}`} style={{ marginBottom: 'var(--s4)' }}>
                <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {mode === 'checkin' ? (
                    <>
                      <span className="alert-title">Check-in doesn't award hours</span>
                      <span style={{ display: 'block', marginTop: 2 }}>
                        Use this while the event is running. Once a shift has ended, finalise it to credit hours.
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="alert-title">Only ticked volunteers are credited</span>
                      <span style={{ display: 'block', marginTop: 2 }}>
                        Anyone you leave untouched keeps whatever is already recorded — nothing is set to absent
                        on your behalf. Changing a record that already exists needs a reason.
                      </span>
                    </>
                  )}
                </span>
              </div>

              {markableApps.length === 0 ? (
                <div className="empty">
                  <span className="empty-icon"><Users size={18} /></span>
                  <h3>
                    {acceptedApps.length === 0
                      ? 'No confirmed volunteers'
                      : mode === 'attendance' ? 'No shifts have ended yet' : 'Nothing to check in'}
                  </h3>
                  <p>
                    {acceptedApps.length === 0
                      ? 'Accept applicants first, then come back to record who attended.'
                      : mode === 'attendance'
                        ? 'Hours can only be finalised once a shift is over. Use check-in during the event.'
                        : 'Every shift on this event has already finished.'}
                  </p>
                </div>
              ) : (
                <>
                  <div className="row-between row-wrap" style={{ marginBottom: 'var(--s4)', gap: 'var(--s2)' }}>
                    <span className="small muted tnum">
                      <span className="strong">{markedCount}</span> of {markableApps.length} marked
                      {presentCount > 0 && <> · <span className="strong">{presentCount}</span> present</>}
                    </span>
                    <div className="row" style={{ gap: 'var(--s2)' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => markAll(markableApps, true)}>
                        All present
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => markAll(markableApps, false)}>
                        All absent
                      </button>
                    </div>
                  </div>

                  <div className="stack-sm">
                    {markableApps.map(app => {
                      const isTouched = touchedIds.has(app.id);
                      const isPresent = !!attendanceMap[app.id];
                      const changesExisting = app.attendance && app.attendance.present !== isPresent;
                      return (
                        <label key={app.id} className="check"
                          data-checked={isTouched && isPresent ? 'true' : 'false'}>
                          <input type="checkbox" checked={isPresent}
                            onChange={e => setMark(app.id, e.target.checked)} />
                          <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span className="check-title">{app.volunteer?.name}</span>
                            <span className="check-desc tnum">
                              {app.slot?.name} · {formatTimeRange(app.slot?.startDatetime, app.slot?.endDatetime)}
                            </span>
                          </span>
                          {!isTouched && <span className="status status-muted">Not marked</span>}
                          {changesExisting && <span className="status status-pending">Changes record</span>}
                          {mode === 'attendance' && (
                            <span className="hourspill">{formatHours(app.attendance?.hoursAwarded ?? app.slot?.hours)}</span>
                          )}
                        </label>
                      );
                    })}
                  </div>

                  {mode === 'attendance' && correctionCount > 0 && (
                    <div className="field" style={{ marginTop: 'var(--s5)' }}>
                      <label htmlFor="att-reason">
                        Why are you changing {correctionCount} existing record{correctionCount !== 1 ? 's' : ''}?
                      </label>
                      <input id="att-reason" className="input" value={attendanceReason}
                        placeholder="e.g. Signed in but left before the shift finished"
                        onChange={e => setAttendanceReason(e.target.value)} />
                      <span className="field-hint">
                        Saved against the volunteer's hours record along with your name.
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setMode('view')}>Back</button>
              {mode === 'checkin' ? (
                <button className="btn btn-primary" onClick={submitCheckin}
                  disabled={submitting || markedCount === 0}>
                  {submitting ? 'Saving…' : `Save check-in for ${markedCount}`}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={submitAttendance}
                  disabled={submitting || markedCount === 0 || (correctionCount > 0 && !attendanceReason.trim())}>
                  {submitting ? 'Saving…' : `Credit hours to ${presentCount} volunteer${presentCount !== 1 ? 's' : ''}`}
                </button>
              )}
            </div>
          </>
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
                      <button className="btn btn-secondary btn-sm" onClick={startEdit}>
                        <Pencil size={13} /> Edit event
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
                    <button className="btn btn-primary btn-sm" onClick={startAttendance}
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

            {/* ── Tabs ── */}
            <div className="tabs" role="tablist">
              {tabs.map(({ id, label, icon: Icon, count }) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className="tab"
                  onClick={() => setTab(id)}
                >
                  <Icon size={14} />
                  {label}
                  {count > 0 && <span className="tab-count">{count}</span>}
                </button>
              ))}
            </div>

            <div className="tabpanel" role="tabpanel">
              {tab === 'shifts' && (
                <>
                  {isStudent && !signupsClosed && (
                    <div className="alert alert-info" style={{ marginBottom: 'var(--s4)' }}>
                      <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>
                        {usesAutoSelect(event) ? (
                          <div>
                            <strong>Selection Method: Auto Select</strong>
                            <div style={{ marginTop: '0.25rem' }}>
                              Applications remain open until the deadline. After the deadline, the system automatically selects volunteers. Students with fewer volunteer hours receive a higher chance of being selected, while every applicant remains eligible.
                            </div>
                          </div>
                        ) : (
                          `Choose the shifts you want and send an application. ${event.organizerName} decides who gets each spot, and you'll be notified either way.`
                        )}
                      </span>
                    </div>
                  )}

                  <div className="section-head">
                    <h3>Shifts</h3>
                    <span className="section-action small dim tnum">
                      {event.maxSpots - event.spotsRemaining} of {event.maxSpots} spots filled
                    </span>
                  </div>

                  {days.length === 0 ? (
                    <div className="card empty">
                      <span className="empty-icon"><CalendarClock size={18} /></span>
                      <h3>No shifts yet</h3>
                      <p>This event doesn't have any shifts set up.</p>
                    </div>
                  ) : (
                    <div className="sheet">
                      {days.map(({ day, slots }) => (
                        <div key={day} className="sheet-daygroup">
                          <div className="sheet-dayhead">
                            <CalendarClock size={12} />
                            {formatDay(slots[0].startDatetime)}
                          </div>

                          {slots.map(slot => {
                            const mine = eventApps.find(a => a.slotId === slot.id && a.userId === currentUser?.id);
                            const isFull = slot.spotsRemaining <= 0;
                            const isSelected = selectedSlots.includes(slot.id);
                            const acceptedHere = eventApps.filter(a => a.slotId === slot.id && a.status === 'accepted');

                            return (
                              <div key={slot.id}
                                className={`sheet-row ${isSelected ? 'is-selected' : ''} ${isFull && !mine ? 'is-full' : ''}`}>
                                <div>
                                  <div className="sheet-time">{formatTime(slot.startDatetime)}</div>
                                  <div className="sheet-dur">
                                    to {formatTime(slot.endDatetime)} · {formatHours(slot.hours)}
                                  </div>
                                </div>

                                <div style={{ minWidth: 0 }}>
                                  <div className="sheet-role">{slot.name}</div>
                                  {slot.description && <div className="sheet-desc">{slot.description}</div>}
                                  {(isOwner || isAdmin) && acceptedHere.length > 0 && (
                                    <div className="sheet-names">
                                      {acceptedHere.map(a => (
                                        <span key={a.id} className="sheet-name">
                                          <span className="avatar sm" style={{ width: 16, height: 16, fontSize: 9 }}>
                                            {a.volunteer?.avatar || '👤'}
                                          </span>
                                          {a.volunteer?.name}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>

                                <div className="sheet-action">
                                  <Seats
                                    filled={slot.maxSpots - slot.spotsRemaining}
                                    total={slot.maxSpots}
                                    mine={mine && mine.status === 'accepted' ? 1 : 0}
                                    showLabel={false}
                                  />
                                  {isStudent ? (
                                    mine ? (
                                      <div className="row" style={{ gap: 6 }}>
                                        <span className={`status ${
                                          mine.status === 'accepted' ? 'status-ok'
                                            : mine.status === 'waitlisted' ? 'status-info'
                                            : mine.status === 'rejected' ? 'status-muted' : 'status-pending'
                                        }`}>
                                          {{
                                            accepted: "You're confirmed",
                                            pending: 'Awaiting decision',
                                            waitlisted: 'Waitlisted',
                                            rejected: 'Not selected'
                                          }[mine.status]}
                                        </span>
                                        {(mine.status === 'accepted' || mine.status === 'pending' || mine.status === 'waitlisted') && (
                                          <button className="btn btn-ghost btn-sm"
                                            disabled={submitting}
                                            onClick={() => handleRelease(mine, slot.name)}>
                                            {mine.status === 'accepted' ? 'Release' : 'Withdraw'}
                                          </button>
                                        )}
                                      </div>
                                    ) : signupsClosed ? (
                                      <span className="small dim">Closed</span>
                                    ) : isFull ? (
                                      <span className="small dim">Full</span>
                                    ) : (
                                      <button
                                        className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                                        onClick={() => setSelectedSlots(prev =>
                                          isSelected ? prev.filter(id => id !== slot.id) : [...prev, slot.id]
                                        )}
                                      >
                                        {isSelected ? <><Check size={13} /> Selected</> : 'Request'}
                                      </button>
                                    )
                                  ) : (
                                    <span className={`seats-label ${isFull ? 'strong' : ''}`}>
                                      {acceptedHere.length}/{slot.maxSpots} filled
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}

                  {isStudent && selectedSlots.length > 0 && (
                    <div className="selectbar">
                      <span className="selectbar-text">
                        <strong>{selectedSlots.length} shift{selectedSlots.length !== 1 ? 's' : ''}</strong> selected
                      </span>
                      <button className="btn btn-ghost btn-sm"
                        style={{ color: 'rgba(255,255,255,.7)', marginLeft: 'auto' }}
                        onClick={() => setSelectedSlots([])}>
                        Clear
                      </button>
                      <button className="btn btn-primary" onClick={handleApply} disabled={submitting}>
                        {submitting
                          ? 'Sending…'
                          : `Apply for ${selectedSlots.length} shift${selectedSlots.length !== 1 ? 's' : ''}`}
                      </button>
                    </div>
                  )}
                </>
              )}

              {tab === 'applicants' && (
                <div className="stack-lg">
                  {usesAutoSelect(event) ? (
                    <>
                      <div className="alert alert-info" style={{ marginBottom: 'var(--s4)' }}>
                        <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>
                          <strong>Selection Method: Auto Select</strong>
                          <div style={{ marginTop: 4, fontSize: '0.875rem' }}>
                            Auto Select automatically chooses volunteers after the application deadline. Students with fewer volunteer hours receive a higher chance of being selected while every applicant remains eligible.
                          </div>
                        </span>
                      </div>

                      {/* Case 1: Selection is confirmed (Selection summary exists) */}
                      {event.selectionSummary ? (
                        <>
                          <div className="card" style={{ padding: 'var(--s4)', background: 'var(--ink-5)', border: '1px solid var(--ink-4)', borderRadius: 8, marginBottom: 'var(--s4)' }}>
                            <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--ink-1)' }}>Selection Run Summary</h4>
                            <p className="small dim" style={{ margin: '4px 0 12px 0' }}>
                              Completed on {new Date(event.selectionSummary.timestamp).toLocaleString()}
                            </p>
                            <div className="row row-wrap" style={{ gap: 'var(--s4)' }}>
                              <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                                <span className="small dim">Total Applicants</span>
                                <strong className="large">{event.selectionSummary.totalApplicants}</strong>
                              </div>
                              <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                                <span className="small dim">Accepted</span>
                                <strong className="large text-ok">{event.selectionSummary.acceptedVolunteers}</strong>
                              </div>
                              <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                                <span className="small dim">Waitlisted</span>
                                <strong className="large text-warn">{event.selectionSummary.waitlistedVolunteers}</strong>
                              </div>
                              <div className="stack-xs" style={{ flex: 1.5, minWidth: 150 }}>
                                <span className="small dim">Avg. Hours (Accepted)</span>
                                <strong className="large">{event.selectionSummary.avgAcceptedHours} hrs</strong>
                              </div>
                              <div className="stack-xs" style={{ flex: 1.5, minWidth: 150 }}>
                                <span className="small dim">Avg. Hours (Waitlisted)</span>
                                <strong className="large">{event.selectionSummary.avgWaitlistedHours} hrs</strong>
                              </div>
                            </div>
                          </div>

                          <section>
                            <div className="section-head">
                              <h3>Final Accepted Volunteers</h3>
                              {acceptedApps.length > 0 && <span className="section-action tag tag-ok">{acceptedApps.length}</span>}
                            </div>
                            {acceptedApps.length === 0 ? (
                              <div className="card empty">
                                <p>No volunteers were accepted.</p>
                              </div>
                            ) : (
                              <div className="list">
                                {acceptedApps.map(app => (
                                  <div key={app.id} className="list-row">
                                    <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                                      <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                                      <span className="truncate">
                                        <span className="person-name truncate">{app.volunteer?.name}</span>
                                        <span className="person-meta truncate">
                                          {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                                        </span>
                                      </span>
                                    </button>
                                    <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                                      {formatHours(app.volunteer?.volunteeredHours)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </section>

                          <section>
                            <div className="section-head">
                              <h3>Waitlist Order</h3>
                              {waitlistApps.length > 0 && <span className="section-action tag tag-warn">{waitlistApps.length}</span>}
                            </div>
                            {waitlistApps.length === 0 ? (
                              <div className="card empty">
                                <p>Waitlist is empty.</p>
                              </div>
                            ) : (
                              <div className="list">
                                {[...waitlistApps]
                                  .sort((a, b) => (a.waitlistOrder || 999) - (b.waitlistOrder || 999))
                                  .map((app, index) => (
                                    <div key={app.id} className="list-row">
                                      <span className="small badge" style={{ marginRight: 8, background: 'var(--ink-4)', color: 'var(--ink-2)', padding: '2px 6px', borderRadius: 4 }}>
                                        #{app.waitlistOrder || (index + 1)}
                                      </span>
                                      <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                                        <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                                        <span className="truncate">
                                          <span className="person-name truncate">{app.volunteer?.name}</span>
                                          <span className="person-meta truncate">
                                            {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                                          </span>
                                        </span>
                                      </button>
                                      <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                                        {formatHours(app.volunteer?.volunteeredHours)}
                                      </span>
                                    </div>
                                  ))}
                              </div>
                            )}
                          </section>
                        </>
                      ) : (
                        <>
                          {/* Case 2: Before deadline */}
                          {!signupsClosed ? (
                            <section>
                              <div className="section-head">
                                <h3>Applicants so far</h3>
                                {pendingApps.length > 0 && <span className="section-action tag tag-warn">{pendingApps.length}</span>}
                              </div>
                              <p className="small dim" style={{ marginTop: -8, marginBottom: 'var(--s3)' }}>
                                Selection will be available manually once the application deadline is reached ({new Date(event.applicationDeadline).toLocaleString()}).
                              </p>
                              <ApplicantReview
                                applications={pendingApps}
                                onViewVolunteer={onViewVolunteerProfile}
                                busy={submitting}
                              />
                            </section>
                          ) : (
                            <>
                              {/* Case 3: After deadline, selection NOT confirmed */}
                              {runsLoading && selectionRuns.length === 0 ? (
                                <div className="stack-sm" style={{ marginBottom: 'var(--s4)' }}>
                                  <div className="skeleton skeleton-row" />
                                  <div className="skeleton skeleton-line" style={{ width: '60%' }} />
                                </div>
                              ) : selectionRuns.length === 0 ? (
                                <div className="card" style={{ padding: 'var(--s4)', textAlign: 'center', background: 'var(--ink-5)', border: '1px solid var(--ink-4)', borderRadius: 8, marginBottom: 'var(--s4)' }}>
                                  <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Applications Closed – Auto Select Ready</h3>
                                  <p className="small dim" style={{ margin: 'var(--s2) 0 var(--s4) 0' }}>
                                    The application deadline has passed. You can now run the weighted selection.
                                  </p>
                                  <button className="btn btn-primary" onClick={handleRunAutoSelect} disabled={submitting}>
                                    {submitting ? 'Running…' : 'Run Auto Select'}
                                  </button>
                                </div>
                              ) : (
                                <>
                                  {/* Case 4: Preview screen of the latest draft run */}
                                  {(() => {
                                    const latestDraft = selectionRuns[selectionRuns.length - 1];
                                    const previewSelectedApps = eventApps.filter(a => latestDraft.selectedIds.includes(a.id));
                                    const previewWaitlistApps = eventApps.filter(a => latestDraft.waitlistIds.includes(a.id));

                                    const totalSelectedHours = previewSelectedApps.reduce((sum, a) => sum + (a.volunteer?.volunteeredHours || 0), 0);
                                    const totalWaitlistHours = previewWaitlistApps.reduce((sum, a) => sum + (a.volunteer?.volunteeredHours || 0), 0);

                                    const avgSelectedHrs = previewSelectedApps.length > 0 ? (totalSelectedHours / previewSelectedApps.length).toFixed(1) : '0';
                                    const avgWaitlistHrs = previewWaitlistApps.length > 0 ? (totalWaitlistHours / previewWaitlistApps.length).toFixed(1) : '0';

                                    return (
                                      <>
                                        <div className="card" style={{ padding: 'var(--s4)', background: 'var(--ink-5)', border: '1px solid var(--ink-4)', borderRadius: 8, marginBottom: 'var(--s4)' }}>
                                          <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--ink-1)' }}>Auto Select Results (Preview)</h4>
                                          <p className="small dim" style={{ margin: '4px 0 12px 0' }}>
                                            Generated draft Run #{latestDraft.runNumber} on {new Date(latestDraft.createdAt).toLocaleTimeString()}
                                          </p>
                                          <div className="row row-wrap" style={{ gap: 'var(--s4)', marginBottom: 'var(--s4)' }}>
                                            <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                                              <span className="small dim">Applicants</span>
                                              <strong className="large">{previewSelectedApps.length + previewWaitlistApps.length}</strong>
                                            </div>
                                            <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                                              <span className="small dim">Accepted</span>
                                              <strong className="large text-ok">{previewSelectedApps.length}</strong>
                                            </div>
                                            <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                                              <span className="small dim">Waitlisted</span>
                                              <strong className="large text-warn">{previewWaitlistApps.length}</strong>
                                            </div>
                                            <div className="stack-xs" style={{ flex: 1.5, minWidth: 150 }}>
                                              <span className="small dim">Avg. Hours (Accepted)</span>
                                              <strong className="large">{avgSelectedHrs} hrs</strong>
                                            </div>
                                            <div className="stack-xs" style={{ flex: 1.5, minWidth: 150 }}>
                                              <span className="small dim">Avg. Hours (Waitlisted)</span>
                                              <strong className="large">{avgWaitlistHrs} hrs</strong>
                                            </div>
                                          </div>

                                          <div className="row" style={{ gap: 12 }}>
                                            <button className="btn btn-secondary" onClick={handleRunAutoSelect} disabled={submitting}>
                                              Run Again
                                            </button>
                                            <button className="btn btn-primary" onClick={handleConfirmAutoSelect} disabled={submitting}>
                                              Confirm Results
                                            </button>
                                          </div>
                                        </div>

                                        <section>
                                          <div className="section-head">
                                            <h3>Accepted Volunteers (Preview)</h3>
                                            {previewSelectedApps.length > 0 && <span className="section-action tag tag-ok">{previewSelectedApps.length}</span>}
                                          </div>
                                          {previewSelectedApps.length === 0 ? (
                                            <div className="card empty"><p>No volunteers selected.</p></div>
                                          ) : (
                                            <div className="list">
                                              {previewSelectedApps.map(app => (
                                                <div key={app.id} className="list-row">
                                                  <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                                                    <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                                                    <span className="truncate">
                                                      <span className="person-name truncate">{app.volunteer?.name}</span>
                                                      <span className="person-meta truncate">
                                                        {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                                                      </span>
                                                    </span>
                                                  </button>
                                                  <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                                                    {formatHours(app.volunteer?.volunteeredHours)}
                                                  </span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </section>

                                        <section>
                                          <div className="section-head">
                                            <h3>Waitlist Order (Preview)</h3>
                                            {previewWaitlistApps.length > 0 && <span className="section-action tag tag-warn">{previewWaitlistApps.length}</span>}
                                          </div>
                                          {previewWaitlistApps.length === 0 ? (
                                            <div className="card empty"><p>Waitlist is empty.</p></div>
                                          ) : (
                                            <div className="list">
                                              {latestDraft.waitlistIds.map((id, idx) => {
                                                const app = previewWaitlistApps.find(a => a.id === id);
                                                if (!app) return null;
                                                return (
                                                  <div key={app.id} className="list-row">
                                                    <span className="small badge" style={{ marginRight: 8, background: 'var(--ink-4)', color: 'var(--ink-2)', padding: '2px 6px', borderRadius: 4 }}>
                                                      #{idx + 1}
                                                    </span>
                                                    <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                                                      <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                                                      <span className="truncate">
                                                        <span className="person-name truncate">{app.volunteer?.name}</span>
                                                        <span className="person-meta truncate">
                                                          {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                                                        </span>
                                                      </span>
                                                    </button>
                                                    <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                                                      {formatHours(app.volunteer?.volunteeredHours)}
                                                    </span>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          )}
                                        </section>
                                      </>
                                    );
                                  })()}
                                </>
                              )}

                              {/* Before running selection, show the pending applicants list for review */}
                              {selectionRuns.length === 0 && (
                                <section>
                                  <div className="section-head">
                                    <h3>Applicants to Review</h3>
                                    {pendingApps.length > 0 && <span className="section-action tag tag-warn">{pendingApps.length}</span>}
                                  </div>
                                  <ApplicantReview
                                    applications={pendingApps}
                                    onViewVolunteer={onViewVolunteerProfile}
                                    busy={submitting}
                                  />
                                </section>
                              )}
                            </>
                          )}
                        </>
                      )}

                      {/* Persistent Audit Log History for Organizers/Admins */}
                      {selectionRuns.length > 0 && (
                        <section style={{ marginTop: 'var(--s4)' }}>
                          <div className="card" style={{ padding: 'var(--s3) var(--s4)', background: 'var(--ink-5)', border: '1px solid var(--ink-4)', borderRadius: 8 }}>
                            <h4 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: 'var(--ink-2)' }}>Audit Log History</h4>
                            <div className="stack-xs" style={{ marginTop: 8 }}>
                              {selectionRuns.map(run => (
                                <div key={run.id} className="small dim row" style={{ gap: 8, justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--ink-4)' }}>
                                  <span style={{ color: run.isConfirmed ? 'var(--ok)' : 'inherit', fontWeight: run.isConfirmed ? 600 : 'normal' }}>
                                    {run.isConfirmed ? 'Confirmed Run ' : 'Run '}#{run.runNumber}
                                  </span>
                                  <span>{new Date(run.createdAt).toLocaleString()}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </section>
                      )}
                    </>
                  ) : (
                    <>
                      <section>
                        <div className="section-head">
                          <h3>Waiting on your decision</h3>
                          {pendingApps.length > 0 && <span className="section-action tag tag-warn">{pendingApps.length}</span>}
                        </div>
                        <ApplicantReview
                          applications={pendingApps}
                          onDecide={decide}
                          onViewVolunteer={onViewVolunteerProfile}
                          busy={submitting}
                        />
                      </section>

                      {waitlistApps.length > 0 && (
                        <section>
                          <div className="section-head">
                            <h3>Waitlist</h3>
                            <span className="section-action small dim">{waitlistApps.length}</span>
                          </div>
                          <p className="small muted" style={{ marginTop: -8, marginBottom: 'var(--s3)' }}>
                            These volunteers are next in line. Accept one if a spot opens up.
                          </p>
                          <div className="list">
                            {waitlistApps.map(app => (
                              <div key={app.id} className="list-row">
                                <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                                  <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                                  <span className="truncate">
                                    <span className="person-name truncate">{app.volunteer?.name}</span>
                                    <span className="person-meta truncate">
                                      {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                                    </span>
                                  </span>
                                </button>
                                <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                                  {formatHours(app.volunteer?.volunteeredHours)}
                                </span>
                                <div className="row" style={{ gap: 4, marginLeft: 'auto' }}>
                                  <button className="btn btn-primary btn-sm" disabled={submitting}
                                    onClick={() => decide(app.id, app.volunteer?.name, 'accepted')}>
                                    <Check size={13} /> Accept
                                  </button>
                                  <button className="btn btn-danger btn-sm btn-icon" title="Reject" disabled={submitting}
                                    onClick={() => decide(app.id, app.volunteer?.name, 'rejected')}>
                                    <Clock4 size={13} />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                    </>
                  )}
                </div>
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
    </div>
  );
}
