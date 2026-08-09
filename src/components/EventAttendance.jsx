import React, { useState, useEffect } from 'react';
import { Info, Users } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from './common/LoadingSkeleton';
import EmptyState from './common/EmptyState';
import { formatHours, formatTimeRange } from '../utils/helpers';
export default function EventAttendance({
  event,
  acceptedApps,
  onClose,
  onComplete,
  addToast
}) {
  const [submitting, setSubmitting] = useState(false);
  const [attendanceMap, setAttendanceMap] = useState({});
  /**
   * Actual hours, keyed by application id, only for rows the organizer edited.
   *
   * Sparse on purpose: an untouched row sends nothing, and the server prices it
   * from the slot exactly as it always has. Sending every row's current value
   * would turn opening this screen into an edit of everybody's record.
   */
  const [hoursMap, setHoursMap] = useState({});
  const [touchedIds, setTouchedIds] = useState(new Set());
  const [attendanceReason, setAttendanceReason] = useState('');
  const [loading, setLoading] = useState(true);
  const now = new Date();
  const markableApps = acceptedApps.filter(a => a.slot?.endDatetime && new Date(a.slot.endDatetime) <= now);
  useEffect(() => {
    let isMounted = true;
    async function loadInitialData() {
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
            initial[a.id] = mark;
            touched.add(a.id);
          }
        }
      } catch {
        // Check-in marks are a convenience; the screen still works without them.
      }
      if (!isMounted) return;
      setAttendanceMap(initial);
      setTouchedIds(touched);

      // Merge with any unsaved localStorage state
      try {
        const draft = localStorage.getItem(`wev_draft_attendance_${event.id}`);
        if (draft) {
          const {
            draftMap,
            draftTouched
          } = JSON.parse(draft);
          setAttendanceMap(prev => ({
            ...prev,
            ...draftMap
          }));
          setTouchedIds(prev => new Set([...prev, ...draftTouched]));
        }
      } catch (e) {
        console.warn('Failed to load draft attendance', e);
      }
      setLoading(false);
    }
    loadInitialData();
    return () => {
      isMounted = false;
    };
  }, [event.id, acceptedApps]);
  useEffect(() => {
    if (!loading && touchedIds.size > 0) {
      localStorage.setItem(`wev_draft_attendance_${event.id}`, JSON.stringify({
        draftMap: attendanceMap,
        draftTouched: Array.from(touchedIds)
      }));
    }
  }, [attendanceMap, touchedIds, event.id, loading]);
  const setMark = (appId, value) => {
    setAttendanceMap(m => ({
      ...m,
      [appId]: value
    }));
    setTouchedIds(prev => new Set(prev).add(appId));
  };
  const markAll = (apps, value) => {
    setAttendanceMap(m => ({
      ...m,
      ...Object.fromEntries(apps.map(a => [a.id, value]))
    }));
    setTouchedIds(prev => new Set([...prev, ...apps.map(a => a.id)]));
  };
  const submitAttendance = async () => {
    setSubmitting(true);
    try {
      const payload = Object.fromEntries([...touchedIds].filter(id => id in attendanceMap).map(id => [id, !!attendanceMap[id]]));
      /* Only rows that were actually edited, and only ones marked present —
         hours on an absent volunteer are meaningless and the server ignores
         them anyway. */
      const hours = Object.fromEntries(
        Object.entries(hoursMap)
          .filter(([id, v]) => v !== '' && v != null && attendanceMap[id])
          .map(([id, v]) => [id, Number(v)])
      );
      const res = await api.submitAttendance(
        event.id, payload, attendanceReason, Object.keys(hours).length ? hours : undefined
      );
      const credited = res.credited?.length || 0;
      const revoked = res.revoked?.length || 0;
      localStorage.removeItem(`wev_draft_attendance_${event.id}`);
      addToast([credited ? `${credited} volunteer${credited !== 1 ? 's' : ''} credited` : '', revoked ? `${revoked} record${revoked !== 1 ? 's' : ''} corrected` : '', !credited && !revoked ? 'No changes to save' : ''].filter(Boolean).join(' · '), credited || revoked ? 'success' : 'info');
      if (res.eventCompleted) addToast('Every shift is accounted for — this event is now complete.', 'info');
      onComplete();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };
  if (loading) {
    return <LoadingSkeleton heights={[44, 44, 44]} />;
  }
  const markedCount = markableApps.filter(a => touchedIds.has(a.id)).length;
  const presentCount = markableApps.filter(a => touchedIds.has(a.id) && attendanceMap[a.id]).length;
  /**
   * A correction is any change to a record that already exists — including an
   * hours-only change. The server refuses one without a reason (400
   * `reason_required`), so the field has to appear for it here too, or the
   * organizer meets a refusal with no way to satisfy it.
   */
  const correctionCount = markableApps.filter(a => {
    if (!touchedIds.has(a.id) || !a.attendance) return false;
    if (a.attendance.present !== !!attendanceMap[a.id]) return true;
    const edited = hoursMap[a.id];
    return edited !== undefined && edited !== '' && Number(edited) !== a.attendance.hoursAwarded;
  }).length;
  return <>
      <div className="modal-body">
        <div className="alert alert-brand s-22c500">
          <Info size={15} className="s-d1467f" />
          <span>
            <span className="alert-title">Only ticked volunteers are credited</span>
            <span className="s-734389">
              Anyone you leave untouched keeps whatever is already recorded — nothing is set to absent
              on your behalf. Changing a record that already exists needs a reason.
            </span>
          </span>
        </div>

        {markableApps.length === 0 ? <EmptyState icon={Users} title={acceptedApps.length === 0 ? 'No confirmed volunteers' : 'No shifts have ended yet'} message={acceptedApps.length === 0 ? 'Accept applicants first, then come back to record who attended.' : 'Hours can only be finalised once a shift is over. Use check-in during the event.'} /> : <>
            <div className="row-between row-wrap s-6cce54">
              <span className="small muted tnum">
                <span className="strong">{markedCount}</span> of {markableApps.length} marked
                {presentCount > 0 && <> · <span className="strong">{presentCount}</span> present</>}
              </span>
              <div className="row s-65ce96">
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
            return <label key={app.id} className="check" data-checked={isTouched && isPresent ? 'true' : 'false'}>
                    <input type="checkbox" checked={isPresent} onChange={e => setMark(app.id, e.target.checked)} />
                    <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                    <span className="s-7b2db8">
                      <span className="check-title">{app.volunteer?.name}</span>
                      <span className="check-desc tnum">
                        {app.slot?.name} · {formatTimeRange(app.slot?.startDatetime, app.slot?.endDatetime)}
                      </span>
                    </span>
                    {!isTouched && <span className="status status-muted">Not marked</span>}
                    {changesExisting && <span className="status status-pending">Changes record</span>}
                    {/**
                      * The number is EDITABLE when the volunteer is marked
                      * present, and the scheduled duration is only its default.
                      * A volunteer rostered for four hours who left after two
                      * and a half did two and a half.
                      *
                      * There is deliberately no "left early" checkbox on its
                      * own: a boolean cannot say how early, so it would either
                      * credit nothing or guess. The input is the source of
                      * truth, and the hint below the list explains it.
                      *
                      * `onClick`/`onKeyDown` stopPropagation because this sits
                      * inside a <label> whose click toggles the checkbox —
                      * without it, typing a number would un-mark the volunteer.
                      */}
                    {isPresent && event.creditsHours !== false ? (
                      <input
                        type="number" className="input hoursedit" min="0" max="24" step="0.25"
                        aria-label={`Hours credited to ${app.volunteer?.name}`}
                        value={hoursMap[app.id] ?? (app.attendance?.hoursAwarded ?? app.slot?.hours ?? '')}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => e.stopPropagation()}
                        onChange={e => setHoursMap(prev => ({ ...prev, [app.id]: e.target.value }))}
                      />
                    ) : (
                      <span className="hourspill">
                        {event.creditsHours === false
                          ? 'Participation'
                          : formatHours(app.attendance?.hoursAwarded ?? app.slot?.hours)}
                      </span>
                    )}
                  </label>;
          })}
            </div>

            {event.creditsHours !== false && (
              <p className="dim small attendance-hourshint">
                Hours default to the length of the shift. Change the number if a volunteer left
                early or stayed on — what you enter here is what gets credited.
              </p>
            )}

            {correctionCount > 0 && <div className="field s-fc751d">
                <label htmlFor="att-reason">
                  Reason for changing {correctionCount} existing record{correctionCount !== 1 ? 's' : ''}
                </label>
                <input id="att-reason" className="input" value={attendanceReason} onChange={e => setAttendanceReason(e.target.value)} />
              </div>}
          </>}
      </div>

      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>Back</button>
        {markableApps.length > 0 && <button className="btn btn-primary" onClick={submitAttendance} disabled={submitting || markedCount === 0 || correctionCount > 0 && !attendanceReason.trim()}>
            {submitting ? 'Saving…' : `Credit hours to ${presentCount} volunteer${presentCount !== 1 ? 's' : ''}`}
          </button>}
      </div>
    </>;
}