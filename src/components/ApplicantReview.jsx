import React, { useState, useMemo } from 'react';
import { Check, Clock4, Ban, ArrowUpDown, Sparkles, AlertCircle } from 'lucide-react';
import { formatHours, formatDay, gradeLabel } from '../utils/helpers';
import { organizerBadges } from '../utils/badgeOrder';
import { MIN_EVIDENCE } from '../reliabilityEvidence';
import { rowTransitionStyle, withViewTransition } from '../utils/motion';

/**
 * What a badge means, on hover (ruling 4).
 *
 * The Reliable badge in words the owner chose, and never as a percentage: the
 * smoothing behind it puts a steady 90% attender just below the line, so "90%"
 * would be false about exactly the people nearest to it. Its stored
 * description is written to the student ("you signed up for"); this is the
 * organizer reading about somebody else. Other badges use their description.
 */
const RELIABLE_HOVER = 'Consistently shows up for the shifts they take';
const FIRST_TIMER_HOVER = 'Their first event on WeVolunteer';
const badgeHover = (b) => (b?.criteria_type === 'attendance_rate' ? RELIABLE_HOVER : (b?.description || undefined));

/**
 * The screen where an organizer decides who gets a spot.
 *
 * Everything shown is decision-relevant: how many hours someone already has,
 * how many events they've completed, and when they last volunteered. Sorting
 * defaults to fewest hours first because that is the fairness question most
 * school programmes are actually trying to answer — but it is a default, not
 * a rule, and the organizer can re-sort freely.
 */
const SORTS = {
  fewestHours: {
    label: 'Fewest hours first',
    hint: 'Prioritises volunteers who have had the least opportunity so far',
    compare: (a, b) => (a.volunteer?.volunteeredHours || 0) - (b.volunteer?.volunteeredHours || 0) || new Date(a.appliedAt) - new Date(b.appliedAt)
  },
  newest: {
    label: 'New volunteers first',
    hint: 'Students who have not completed an event yet',
    compare: (a, b) => (a.volunteer?.completedEvents || 0) - (b.volunteer?.completedEvents || 0) || new Date(a.appliedAt) - new Date(b.appliedAt)
  },
  experienced: {
    label: 'Most experienced first',
    hint: 'Useful when a shift needs someone who has done it before',
    compare: (a, b) => (b.volunteer?.completedEvents || 0) - (a.volunteer?.completedEvents || 0) || (b.volunteer?.volunteeredHours || 0) - (a.volunteer?.volunteeredHours || 0)
  },
  applied: {
    label: 'Applied earliest first',
    hint: 'Order the applications arrived',
    compare: (a, b) => new Date(a.appliedAt) - new Date(b.appliedAt)
  }
};
export default function ApplicantReview({
  applications,
  onDecide,
  onBulkDecide,
  onViewVolunteer,
  onMessage,
  busy
}) {
  const [sortKey, setSortKey] = useState('fewestHours');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const sorted = useMemo(() => [...applications].sort(SORTS[sortKey].compare), [applications, sortKey]);
  if (applications.length === 0) {
    return <div className="empty s-ffedc8">
        <span className="empty-icon"><Check size={18} /></span>
        <h3>No applications waiting</h3>
        <p>When students apply for a shift, they'll appear here for you to review.</p>
      </div>;
  }
  return <div>
      <div className="toolbar s-450599">
        <label className="row small s-a19c85">
          <ArrowUpDown size={14} className="s-c4c3e3" />
          <span className="dim nowrap">Order by</span>
          <select className="select" value={sortKey} onChange={e => { const next = e.target.value; withViewTransition(() => setSortKey(next)); }} aria-label="Order applicants by">
            {Object.entries(SORTS).map(([key, {
            label
          }]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <span className="small dim">{SORTS[sortKey].hint}</span>
      </div>

      {selectedIds.size > 0 && onBulkDecide && <div className="card row-between s-257e7a">
          <span className="small strong s-1ee043">
            {selectedIds.size} volunteer{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div className="row s-65ce96">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => {
          onBulkDecide(Array.from(selectedIds), 'accepted');
          setSelectedIds(new Set());
        }}>
              <Check size={14} /> Accept all
            </button>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => {
          onBulkDecide(Array.from(selectedIds), 'waitlisted');
          setSelectedIds(new Set());
        }}>
              <Clock4 size={14} /> Waitlist all
            </button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => {
          onBulkDecide(Array.from(selectedIds), 'rejected');
          setSelectedIds(new Set());
        }}>
              <Ban size={14} /> Reject all
            </button>
          </div>
        </div>}

      {onBulkDecide && <div className="toolbar s-b9c417">
          <input type="checkbox" checked={selectedIds.size === sorted.length && sorted.length > 0} onChange={e => {
        if (e.target.checked) {
          setSelectedIds(new Set(sorted.map(a => a.id)));
        } else {
          setSelectedIds(new Set());
        }
      }} aria-label="Select all applicants" className="s-3fcc6c" />
          <span className="small dim">Select all {sorted.length} volunteers</span>
        </div>}

      <div className="list">
        {sorted.map(app => {
        const v = app.volunteer || {};
        /**
         * Too little history to say anything, rather than nothing at all.
         *
         * This was `completedEvents === 0`, so a volunteer with exactly one
         * completed commitment showed "0 of 1 attended" — which reads as a
         * damning fact and is one shift's worth of evidence. Below three, the
         * honest thing to show an organizer is that there is no record yet, not
         * a ratio they cannot help reading as a verdict.
         */
        /**
         * CONFIRMED commitments, against the model's own floor.
         *
         * This read `eventsSignedUp` against a hardcoded 3, and both halves
         * were wrong. `reliability.js` abolished the three-commitment floor by
         * name — "three numbers answering one question, in three files,
         * disagreeing … `MIN_EVIDENCE` is the one that remains, and every
         * surface reads it" — and this surface went on not reading it.
         *
         * The quantity mattered more than the number. `eventsSignedUp` counts
         * every commitment whose shift has ENDED, confirmed or not, so four
         * shifts nobody had got round to recording read as four shifts missed:
         * the row said "0 of 4 attended" about a volunteer with no record
         * either way. `eventsAwaitingRecord` is published in this payload
         * precisely to keep those apart, "because reading the second as the
         * first is the specific unfairness this whole set of definitions exists
         * to prevent."
         *
         * Attended plus absent is what the server's `reliability.recorded`
         * counts, arrived at from the two fields the payload already carries
         * rather than by adding a third.
         */
        const confirmedCommitments = (v.eventsAttended ?? 0) + (v.eventsAbsent ?? 0);
        const completedCommitments = v.eventsSignedUp ?? v.completedEvents ?? 0;
        const isNew = confirmedCommitments < MIN_EVIDENCE;
        /* No past commitment at all: nothing to count, so the first-time
           volunteer badge stands in for "0 of 0 attended" (ruling 4). */
        const isFirstTimer = completedCommitments === 0;
        /* A new volunteer's row is a status line, so it carries no other
           badges — an Early Supporter chip beside the first-timer badge would
           read as experience they do not have. */
        const shown = isNew ? [] : organizerBadges(v.badges);
        const isSelected = selectedIds.has(app.id);
        /* Named so a re-sort moves each applicant to their new place. */
        return <div key={app.id} className={`list-row ${isSelected ? 'selected' : ''}`} style={{
          ...rowTransitionStyle('app', app.id),
          ...(isSelected ? { backgroundColor: 'var(--brand-tint)' } : {})
        }}>
              {onBulkDecide && <input type="checkbox" checked={isSelected} onChange={e => {
            const next = new Set(selectedIds);
            if (e.target.checked) next.add(app.id);else next.delete(app.id);
            setSelectedIds(next);
          }} aria-label={`Select ${v.name || 'applicant'}`} className="s-5d6488" />}
              
              <button className="person s-934a84" onClick={() => onViewVolunteer(v)} title={`View ${v.name}'s profile`}>
                <span className="avatar sm">{v.avatar || '👤'}</span>
                <span className="truncate">
                  <span className="person-name truncate">{v.name}</span>
                  <span className="person-meta truncate">
                    {[gradeLabel(v.grade), v.school].filter(Boolean).join(' · ')}
                  </span>
                  {app.hasConflict && (
                    <span className="tag tag-danger" style={{ marginTop: 2, display: 'inline-flex', padding: '1px 4px', fontSize: 10 }}>
                      <AlertCircle size={10} style={{ marginRight: 2 }} /> Conflict
                    </span>
                  )}
                  {/**
                    * At most three badges, chosen by `organizerBadges`.
                    *
                    * Not the volunteer's whole cabinet. An organizer with twenty
                    * places is asking "have they done this before, and do they
                    * turn up" — a row of nine hour tiers answers neither and
                    * buries the reliability badge that answers the second. The
                    * icon is decorative; the name carries the meaning, so both
                    * are rendered rather than the glyph alone.
                    */}
                  {(shown.length > 0 || isFirstTimer) && (
                    <span style={{ marginTop: 2, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {isFirstTimer && (
                        <span className="tag" style={{ padding: '1px 4px', fontSize: 10 }} title={FIRST_TIMER_HOVER}>
                          <Sparkles size={10} aria-hidden="true" /> First-time volunteer
                        </span>
                      )}
                      {shown.map(b => (
                        <span key={b.name} className="tag" style={{ padding: '1px 4px', fontSize: 10 }} title={badgeHover(b)}>
                          <span aria-hidden="true">{b.icon}</span> {b.name}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
              
              <div className="small truncate s-40e91a">{app.slot?.name}</div>
              
              <div className="s-821378">
                <span className={`hourspill ${!v.volunteeredHours ? 'zero' : ''}`}>
                  {formatHours(v.volunteeredHours)}
                </span>
              </div>
              
              <div className="s-0c206e">
                {/**
                  * The counts, always (ruling 18).
                  *
                  * Below `MIN_EVIDENCE` confirmed commitments this column used
                  * to hide them behind a "New volunteer" tag, so one missed
                  * shift could not read as a verdict. That served the owner's
                  * fairness concern and worked against his request for raw
                  * counts; he ruled for the counts, with the tag beside them.
                  * The unconfirmed-shifts line below is what still keeps
                  * paperwork from reading as absence. A first-timer has nothing
                  * to count and carries the first-time badge instead.
                  */}
                {isFirstTimer ? <div className="small dim">No past shifts</div> : <>
                    {/**
                      * Signed up versus attended — the follow-through question.
                      *
                      * "3 events" alone said how many somebody had ATTENDED and
                      * nothing about how many they had committed to, so a
                      * volunteer who turned up to three of three looked exactly
                      * like one who turned up to three of eleven. That is the
                      * one thing an organizer holding twenty places actually
                      * wants to know.
                      *
                      * Two counts and deliberately never a percentage: "1 of 2
                      * — 50%" reads as a verdict on a person when the evidence
                      * is one missed shift, and a reader cannot un-see the
                      * number. `signedUp` counts only commitments whose shift
                      * has ENDED, so an upcoming one is never held against
                      * somebody who has not had the chance to attend it yet.
                      */}
                    <div className="small tnum">
                      {v.eventsAttended ?? v.completedEvents} of {v.eventsSignedUp ?? v.completedEvents} attended
                    </div>
                    {isNew && (
                      <span className="tag tag-brand">
                        <Sparkles size={10} aria-hidden="true" /> New volunteer
                      </span>
                    )}
                    {/**
                      * Why the gap is what it is.
                      *
                      * "7 of 9" invites one reading — that somebody missed two
                      * — and that reading is wrong whenever an organizer simply
                      * never confirmed attendance. The volunteer has no way to
                      * make it happen and no way to see it being held against
                      * them. Naming the unconfirmed shifts is the difference
                      * between evidence and an accusation, so it is shown
                      * whenever there are any.
                      */}
                    {v.eventsAwaitingRecord > 0 && (
                      <div className="small dim tnum">
                        {v.eventsAwaitingRecord} not confirmed by an organizer
                      </div>
                    )}
                    {/**
                      * When they last served, or a neutral sentence when never.
                      *
                      * This was `last {formatDay(v.lastVolunteeredDate)}`
                      * unconditionally, and `formatDay` returns an em dash for a
                      * missing date — so a volunteer with three commitments and
                      * no confirmed attendance read "last —". That is not
                      * neutral, it is a blank an organizer fills in themselves,
                      * and the likeliest guess is the unkindest one. Both cases
                      * are said in words instead.
                      *
                      * Neither line is framed as a lapse. A gap since March is a
                      * fact about a calendar, not a character reference — a
                      * student sits exams, breaks an ankle, moves house. The
                      * date is given; the reading is left to the person who
                      * knows the context.
                      */}
                    <div className="small dim tnum">
                      {v.lastVolunteeredDate
                        ? `last ${formatDay(v.lastVolunteeredDate)}`
                        : 'no confirmed shifts yet'}
                    </div>
                  </>}
              </div>
              
              <div className="small dim tnum s-48fd77">
                {formatDay(app.appliedAt)}
              </div>
              
              {onDecide && <div className="row s-9814e5">
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onDecide(app.id, v.name, 'accepted')}>
                    <Check size={13} /> Accept
                  </button>
                  <button className="btn btn-secondary btn-sm btn-icon" title="Move to waitlist" aria-label={`Waitlist ${v.name}`} disabled={busy} onClick={() => onDecide(app.id, v.name, 'waitlisted')}>
                    <Clock4 size={13} />
                  </button>
                  <button className="btn btn-danger btn-sm btn-icon" title="Reject" aria-label={`Reject ${v.name}`} disabled={busy} onClick={() => onDecide(app.id, v.name, 'rejected')}>
                    <Ban size={13} />
                  </button>
                  {onMessage && <button className="btn btn-ghost btn-sm btn-icon" title="Message" aria-label={`Message ${v.name}`} disabled={busy} onClick={() => onMessage(v.id)}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
                  </button>}
                </div>}
            </div>;
      })}
      </div>
    </div>;
}