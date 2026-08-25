import React, { useState, useEffect } from 'react';
import { Info, Lock, ShieldCheck, Users } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from './common/LoadingSkeleton';
import ConfirmDialog from './common/ConfirmDialog';
import EmptyState from './common/EmptyState';
import { formatDay, formatHours, formatTimeRange } from '../utils/helpers';
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
  /**
   * The three states this screen can be in, and what each one means.
   *
   *   correctable   the ordinary case. Marks and hours can be changed, with a
   *                 reason, exactly as they always could.
   *   ready         the event is `completed` — every shift ended, every accepted
   *                 volunteer accounted for — so the numbers can be made final.
   *                 Still fully correctable until somebody says otherwise.
   *   closedOut     `hours_closed_out_at` is set. Nothing here can change again.
   *
   * `closedOut` is read from the column, NOT from `status === 'completed'`.
   * Completion is a side effect of ticking the last checkbox; freezing a
   * student's service record is a decision, and the two are deliberately not
   * the same event. See the note in `server/attendance.js`.
   *
   * Mirrored here so the screen does not offer an edit whose only outcome is a
   * refusal. It is a mirror and not the rule: the server decides (409
   * `hours_locked`), and this can only ever say the same thing earlier. See
   * src/authz.js for why the client half of a rule is written that way round.
   */
  const closedOut = Boolean(event.hoursClosedOutAt);
  const readyToCloseOut = !closedOut && event.status === 'completed';
  /** Rows whose record is already final: an existing credit, once closed out. */
  const isLocked = (app) => closedOut && Boolean(app.attendance);
  const [confirmingCloseOut, setConfirmingCloseOut] = useState(false);
  const [closingOut, setClosingOut] = useState(false);
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
      /**
       * ── Only rows this screen can actually SHOW may be submitted ──
       *
       * `touchedIds` is seeded from `acceptedApps` — every slot of the event —
       * while the list renders `markableApps`, the slots that have ended. A
       * check-in mark on a shift that has not happened yet therefore entered the
       * payload without ever appearing on screen, and the server refuses the
       * WHOLE submission if any row's shift is still to come.
       *
       * On a two-day event that is a dead end with no way out of it: the
       * organizer ticks Sunday's volunteers off at Check-In on Saturday morning,
       * tries to credit Saturday's hours on Saturday night, and is told "2 of the
       * shifts you submitted are still to come" — with no control on the page to
       * untick them, because those rows are not rendered. The draft in
       * localStorage restores the same set on reload, and it is cleared only on
       * a successful save, so refreshing does not escape it either. Saturday's
       * volunteers cannot be credited until Sunday is over.
       *
       * Filtering HERE rather than at the three places that write `touchedIds`
       * (initial load, check-in merge, draft merge) because this is the single
       * boundary every one of them passes through, and because a row becomes
       * markable with the passage of time — a set filtered at load would be
       * wrong by the end of a long session, and this is evaluated at submit.
       */
      const submittable = new Set(markableApps.map(a => a.id));
      const payload = Object.fromEntries(
        [...touchedIds]
          .filter(id => submittable.has(id) && id in attendanceMap)
          .map(id => [id, !!attendanceMap[id]])
      );
      /* Only rows that were actually edited, and only ones marked present.
         The `attendanceMap[id]` test is what keeps hours off an absent
         volunteer — the server accepts them on an absent row, so this is a real
         constraint rather than a restatement of one. */
      const hours = Object.fromEntries(
        Object.entries(hoursMap)
          .filter(([id, v]) => v !== '' && v != null && attendanceMap[id] && submittable.has(id))
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
  /**
   * Makes the hours permanent.
   *
   * Behind `ConfirmDialog` rather than `window.confirm`, matching the other
   * deliberate actions in this app, and behind a confirmation at all because
   * this is the only irreversible thing an organizer can do to a student's
   * service record. `onComplete()` refetches, so the screen comes back in its
   * locked state rather than being told to render one.
   */
  const closeOutHours = async () => {
    setClosingOut(true);
    try {
      await api.closeOutHours(event.id);
      addToast('Hours closed out. This event’s service records are now final.', 'success');
      setConfirmingCloseOut(false);
      onComplete();
    } catch (err) {
      addToast(err.message, 'error');
      setConfirmingCloseOut(false);
    } finally {
      setClosingOut(false);
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
  /**
   * Volunteers this save would credit for the first time.
   *
   * The server marks an event complete once every accepted volunteer has a
   * record, so if nobody is left over after this save, this is the save that
   * completes it — which is what makes closing out available. Worth saying on
   * the button rather than in a toast afterwards.
   *
   * Deliberately conservative: it counts against `acceptedApps`, the whole
   * roster, not against `markableApps`. A volunteer on a shift that has not
   * ended yet keeps the event open, and mistaking that for a close-out would
   * put a warning in front of somebody it does not apply to.
   */
  const remainingAfterSave = acceptedApps.filter(a => {
    if (a.attendance) return false;
    return !(touchedIds.has(a.id) && markableApps.some(m => m.id === a.id));
  }).length;
  const wouldCompleteEvent = !closedOut && !readyToCloseOut
    && remainingAfterSave === 0 && markedCount > 0;
  /**
   * How many volunteers the close-out would make permanent.
   *
   * Counted from stored records rather than from the checkboxes: the dialog is
   * about what IS credited, not about what this screen would credit if it were
   * saved. Anything unsaved is not part of the decision being confirmed.
   */
  const creditedCount = acceptedApps.filter(a => a.attendance?.present).length;
  return <>
      <div className="modal-body">
        {/**
          * ── Closed out: the record is the school's now, not the organizer's ──
          *
          * Shown INSTEAD of the "only ticked volunteers are credited" note,
          * because that note is advice for somebody who is about to change
          * something and nothing on this screen can change any more. The server
          * refuses a change to an existing record with 409 `hours_locked`; this
          * is the same sentence, said before the press rather than after it.
          */}
        {closedOut ? (
          <div className="alert alert-warn s-22c500" role="status">
            <Lock size={15} className="s-d1467f" />
            <span>
              <span className="alert-title">Hours for this event are final</span>
              <span className="s-734389">
                These hours were closed out{event.hoursClosedOutAt
                  ? ` on ${formatDay(event.hoursClosedOutAt)}`
                  : ''}, so they are part of each student&rsquo;s permanent record
                and can no longer be changed &mdash; by you or by anyone else.
              </span>
            </span>
          </div>
        ) : readyToCloseOut ? (
          /**
            * The middle state, and the one the whole design exists for.
            *
            * The event is complete, so the numbers CAN be made final — and they
            * are not yet, so a mistake is still fixable. Saying both things here
            * is what turns "no takebacksies" from a trap into a decision:
            * whoever reads this knows the record is still theirs to correct and
            * knows exactly which button ends that.
            */
          <div className="alert alert-brand s-22c500" role="status">
            <ShieldCheck size={15} className="s-d1467f" />
            <span>
              <span className="alert-title">Everyone is accounted for &mdash; check the hours</span>
              <span className="s-734389">
                You can still correct anything below. When the numbers are right, close the
                hours out to make them final; that cannot be undone.
              </span>
            </span>
          </div>
        ) : (
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
        )}

        {markableApps.length === 0 ? <EmptyState icon={Users} title={acceptedApps.length === 0 ? 'No confirmed volunteers' : 'No shifts have ended yet'} message={acceptedApps.length === 0 ? 'Accept applicants first, then come back to record who attended.' : 'Hours can only be finalised once a shift is over. Use check-in during the event.'} /> : <>
            <div className="row-between row-wrap s-6cce54">
              <span className="small muted tnum">
                <span className="strong">{markedCount}</span> of {markableApps.length} marked
                {presentCount > 0 && <> · <span className="strong">{presentCount}</span> present</>}
              </span>
              {/* Nothing to mark in bulk when every row is final. */}
              {!closedOut && (
                <div className="row s-65ce96">
                  <button className="btn btn-secondary btn-sm" onClick={() => markAll(markableApps, true)}>
                    All present
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => markAll(markableApps, false)}>
                    All absent
                  </button>
                </div>
              )}
            </div>

            <div className="stack-sm">
              {markableApps.map(app => {
            const isTouched = touchedIds.has(app.id);
            const isPresent = !!attendanceMap[app.id];
            const changesExisting = app.attendance && app.attendance.present !== isPresent;
            const locked = isLocked(app);
            return <label key={app.id} className="check" data-checked={isTouched && isPresent ? 'true' : 'false'}>
                    <input type="checkbox" checked={isPresent} disabled={locked} onChange={e => setMark(app.id, e.target.checked)} />
                    <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                    <span className="s-7b2db8">
                      <span className="check-title">{app.volunteer?.name}</span>
                      <span className="check-desc tnum">
                        {app.slot?.name} · {formatTimeRange(app.slot?.startDatetime, app.slot?.endDatetime)}
                      </span>
                    </span>
                    {!isTouched && !locked && <span className="status status-muted">Not marked</span>}
                    {changesExisting && !locked && <span className="status status-pending">Changes record</span>}
                    {/* Says WHY the row cannot be touched, beside the row. A
                        disabled checkbox with no explanation reads as a fault. */}
                    {locked && (
                      <span className="status status-muted" title="This event is closed out">
                        <Lock size={11} aria-hidden="true" /> Final
                      </span>
                    )}
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
                    {isPresent && event.creditsHours !== false && !locked ? (
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

            {/* Not on a closed-out event: "change the number" is instructions
                for a control that is no longer there, sitting under a banner
                that has just said the numbers are final. */}
            {event.creditsHours !== false && !closedOut && (
              <p className="dim small attendance-hourshint">
                Hours default to the length of the shift. Change the number if a volunteer left
                early or stayed on — what you enter here is what gets credited.
              </p>
            )}

            {correctionCount > 0 && !closedOut && <div className="field s-fc751d">
                <label htmlFor="att-reason">
                  Reason for changing {correctionCount} existing record{correctionCount !== 1 ? 's' : ''}
                </label>
                <input id="att-reason" className="input" value={attendanceReason} onChange={e => setAttendanceReason(e.target.value)} />
              </div>}

            {/**
              * Said before the press, and deliberately NOT as a warning.
              *
              * This save completes the event; it does not freeze anything. That
              * distinction is the design: the irreversible step is a separate
              * button, so the save an organizer performs at the end of every
              * event stays an ordinary save. Telling them what happens next is
              * useful; telling them it is permanent would be false, and a false
              * warning in a routine place is how people learn to ignore the
              * real one.
              */}
            {wouldCompleteEvent && (
              <p className="dim small attendance-hourshint" role="status">
                <ShieldCheck size={12} aria-hidden="true" />{' '}
                This accounts for everyone, so the event will be marked complete. You can
                still correct these hours afterwards, until you close them out.
              </p>
            )}
          </>}
      </div>

      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose} disabled={submitting || closingOut}>
          {closedOut ? 'Close' : 'Back'}
        </button>

        {/* No save control at all once the hours are closed out: every row that
            could change is final, so the only thing the button could produce is
            a 409. */}
        {markableApps.length > 0 && !closedOut && (
          <button className="btn btn-secondary" onClick={submitAttendance} disabled={submitting || closingOut || markedCount === 0 || correctionCount > 0 && !attendanceReason.trim()}>
            {submitting
              ? 'Saving…'
              : `Credit hours to ${presentCount} volunteer${presentCount !== 1 ? 's' : ''}`}
          </button>
        )}

        {/**
          * The irreversible step, and the only one on this screen.
          *
          * Offered only when the event is complete, because before that the
          * roster is not finished and freezing it would leave somebody
          * uncreditable for ever. It is the primary button at that point —
          * closing out IS the remaining task — but it is the ONLY control here
          * that opens a confirmation, so it cannot be reached by the muscle
          * memory of pressing save.
          */}
        {readyToCloseOut && (
          <button
            className="btn btn-primary"
            onClick={() => setConfirmingCloseOut(true)}
            disabled={submitting || closingOut}
          >
            <Lock size={13} aria-hidden="true" /> Close out hours
          </button>
        )}
      </div>

      {confirmingCloseOut && (
        <ConfirmDialog
          title="Close out hours for this event?"
          confirmLabel="Close out hours"
          cancelLabel="Keep them editable"
          destructive
          busy={closingOut}
          onCancel={() => setConfirmingCloseOut(false)}
          onConfirm={closeOutHours}
        >
          {/* Names the number and the consequence, in that order. "This cannot
              be undone" under a count of the people it applies to is a different
              sentence from "this cannot be undone" on its own. */}
          <p>
            <strong>{creditedCount} volunteer{creditedCount !== 1 ? 's' : ''}</strong> will
            have their hours for &ldquo;{event.title}&rdquo; made permanent.
          </p>
          <p>
            After this, nobody can change them &mdash; not you, and not an administrator.
            Check the hours above first if you have not already.
          </p>
        </ConfirmDialog>
      )}
    </>;
}