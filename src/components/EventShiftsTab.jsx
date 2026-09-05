import React, { useMemo, useState } from 'react';
import { Info, CalendarClock, CalendarPlus, QrCode } from 'lucide-react';
import { formatDay, formatTime, formatHours, usesAutoSelect } from '../utils/helpers';
import { Seats } from './Seats';
import EmptyState from './common/EmptyState';
import CheckInCodeModal from './CheckInCodeModal';

/**
 * How long before a shift the downloaded calendar entry should sound an alarm.
 *
 * A fixed default rather than a picker in the row. That row already carries the
 * seat count, the status pill, this button and the release control; a fifth control for a
 * decision most people will not make is clutter — and the one place changing an
 * alert is genuinely easy is the calendar application it just landed in.
 *
 * The .ics also carries GEO, so on a calendar that supports departure alerts
 * (iOS "Time to Leave") the device works out the real leaving time from live
 * traffic and the volunteer's actual position, which is something this
 * application cannot do and should not pretend to.
 */
const CALENDAR_REMINDER_MINUTES = 60;

export default function EventShiftsTab({
  event,
  eventApps,
  currentUser,
  isStudent,
  isOwner,
  isAdmin,
  signupsClosed,
  selectedSlots,
  handleSlotSelect,
  sendApplication,
  submitting,
  onRelease
}) {
  /* The slot whose code is being shown, or null. Per slot, so a two-day event
     cannot present Saturday's code on Sunday. */
  const [qrFor, setQrFor] = useState(null);

  /**
   * Whether this reader is refused this event before they press anything.
   *
   * Two reasons, both decided by the server and carried on the event: an active
   * ban from the organization running it, and a members-only event they are not
   * a member of. The modal explains each of them in its own notice above; this
   * is what stops the shift rows from offering a button underneath that notice
   * whose only possible outcome is a 403.
   *
   * `viewerIsMember === false` and not `!viewerIsMember` — the field is `null`
   * for an event that belongs to no organization, and a nullish test would read
   * that as "not a member" and disable every ordinary event on the platform.
   */
  const refused = Boolean(event?.viewerBan?.banned)
    || (event?.audience === 'organization' && event?.viewerIsMember === false);

  const days = useMemo(() => {
    if (!event?.slots) return [];
    const grouped = {};
    for (const s of event.slots) {
      const date = new Date(s.startDatetime);
      const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      if (!grouped[dayKey]) grouped[dayKey] = [];
      grouped[dayKey].push(s);
    }
    return Object.entries(grouped)
      .map(([day, slots]) => ({
        day,
        slots: slots.sort((a, b) => new Date(a.startDatetime) - new Date(b.startDatetime))
      }))
      .sort((a, b) => new Date(a.slots[0].startDatetime) - new Date(b.slots[0].startDatetime));
  }, [event?.slots]);

  return (
    <>
      {/* The how-selection-works note is addressed to somebody who is about to
          apply. Under a notice saying they cannot, it reads as instructions for
          a thing that will not work. */}
      {isStudent && !signupsClosed && !refused && (
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
              /* Named when we know the name. An event whose organizer has been
                 tombstoned has no `organizerName`, and interpolating it
                 unguarded put the literal word "undefined" in a sentence about
                 who decides whether a student gets a place. */
              `Choose the shifts you want and send an application. ${event.organizerName || 'The organizer'} decides who gets each spot, and you'll be notified either way.`
            )}
          </span>
        </div>
      )}

      {isStudent && signupsClosed && eventApps.some(a => a.status === 'waitlisted' && a.userId === currentUser?.id) && (
        <div className="alert alert-info" style={{ marginBottom: 'var(--s4)' }}>
          <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            <div>
              <strong>You are on the waitlist</strong>
              <div style={{ marginTop: '0.25rem' }}>
                {usesAutoSelect(event) 
                  ? `Due to high demand (${event.applicantCount} applicants for ${event.maxSpots} spots), selection was handled by the Auto Select system to ensure fairness. `
                  : `Demand exceeded available spots for this event. `}
                Students are promoted automatically if accepted volunteers withdraw and spots become available. There is no numbered queue.
              </div>
            </div>
          </span>
        </div>
      )}

      <div className="section-head">
        <h3>Shifts</h3>
        {/**
          * The count only when there is something to count.
          *
          * An event with no shifts yet has no `maxSpots` and no
          * `spotsRemaining`, so this read `undefined - undefined` and rendered
          * the literal string "NaN of  spots filled" — directly above an empty
          * state that says, correctly, "No shifts yet". Found in the browser on
          * a seeded event, not by a test.
          *
          * Guarded on the numbers rather than on `days.length`, because a
          * malformed event with shifts but no spot totals produces exactly the
          * same nonsense and would slip past a length check.
          */}
        {Number.isFinite(event.maxSpots) && Number.isFinite(event.spotsRemaining) && (
          <span className="section-action small dim tnum">
            {event.maxSpots - event.spotsRemaining} of {event.maxSpots} spots filled
          </span>
        )}
      </div>

      {days.length === 0 ? (
        <EmptyState 
          icon={CalendarClock} 
          title="No shifts yet" 
          message="This event doesn't have any shifts set up." 
        />
      ) : (
        <div className="sheet">
          {days.map(({ day, slots }) => (
            <div key={day} className="sheet-daygroup">
              <div className="sheet-dayhead">
                <CalendarClock size={12} />
                {formatDay(slots[0].startDatetime)}
              </div>

              {slots.map(slot => {
                const mine = eventApps.find(a => a.slotId === slot.id && a.userId === currentUser?.id && a.status !== 'withdrawn');
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
                      <div className="stack-sm" style={{ alignItems: 'flex-end', gap: 4 }}>
                        <Seats
                          filled={slot.maxSpots - slot.spotsRemaining}
                          total={slot.maxSpots}
                          mine={mine && mine.status === 'accepted' ? 1 : 0}
                          showLabel={false}
                        />
                        {slot.applicantCount > 0 && (
                          <span className="small dim tnum">
                            {slot.applicantCount} applied
                          </span>
                        )}
                        {(isOwner || isAdmin) && (
                          <a 
                            href={`/api/events/${event.id}/slots/${slot.id}/ics?remind=${CALENDAR_REMINDER_MINUTES}`} 
                            className="btn btn-ghost btn-sm" 
                            style={{ marginTop: 4 }}
                            download
                          >
                            Add to Calendar
                          </a>
                        )}
                      </div>
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
                                rejected: 'Not accepted'
                              }[mine.status]}
                            </span>
                            {/**
                              * The two utilities are icons; the destructive one
                              * keeps its word.
                              *
                              * This row carried four full-width controls — a
                              * status pill, "Add to Calendar", "Check in with
                              * QR" and the release control — and on a phone
                              * `.sheet-action .btn { width: 100% }` stacked all
                              * four into a column taller than the shift it
                              * belonged to. Multiply by a three-shift event and
                              * the page is nothing but buttons.
                              *
                              * Calendar and QR are recognisable as glyphs, are
                              * safe to press by accident, and are the two a
                              * volunteer reaches for repeatedly — they compress
                              * well. Giving up a place does not: it gives up a place
                              * somebody else wanted, it is pressed once, and an
                              * unlabelled icon for a destructive action is how
                              * people lose their shift by mis-tapping. It stays
                              * a word.
                              *
                              * Both icons carry `title` AND `aria-label`, the
                              * house pattern (there is no Tooltip component —
                              * `title` is the browser's own and is read out).
                              * The labels name the shift, so a screen reader on
                              * a three-shift event hears which one.
                              */}
                            {mine.status === 'accepted' && (
                              <a
                                href={`/api/events/${event.id}/slots/${slot.id}/ics?remind=${CALENDAR_REMINDER_MINUTES}`}
                                className="btn btn-secondary btn-sm btn-icon shift-util"
                                download
                                title="Add to calendar"
                                aria-label={`Add ${slot.name} to your calendar`}
                              >
                                <CalendarPlus size={16} aria-hidden="true" />
                              </a>
                            )}
                            {/* Per slot, because check-in is per slot: on a
                                two-day festival a Sunday volunteer's code must
                                not work on Saturday. The button is always
                                offered; the server decides whether a code can
                                exist yet and says so in the dialog. */}
                            {mine.status === 'accepted' && (
                              <button
                                className="btn btn-secondary btn-sm btn-icon shift-util"
                                type="button"
                                onClick={() => setQrFor({ application: mine, slot })}
                                title="Check in with QR"
                                aria-label={`Show your check-in code for ${slot.name}`}
                              >
                                <QrCode size={16} aria-hidden="true" />
                              </button>
                            )}
                            {(mine.status === 'accepted' || mine.status === 'pending' || mine.status === 'waitlisted') && (
                              <button className="btn btn-ghost btn-sm"
                                disabled={submitting}
                                onClick={() => onRelease(mine, slot.name)}>
                                {/* ── "Can't make it", not "Release" ──
                                    Giving up a CONFIRMED place had two names in
                                    two places: "Release" here and "Can't make
                                    it" on the volunteer dashboard, for the same
                                    act through the same endpoint. The
                                    dashboard's is the one that survived, because
                                    it is what the student is communicating
                                    rather than what the seat model does about
                                    it — "Release" is domain language borrowed
                                    from the capacity code.

                                    "Withdraw" stays for pending and waitlisted,
                                    and that is a real distinction rather than a
                                    leftover: taking back an application nobody
                                    has answered yet is not the same act as
                                    dropping a place somebody was counting on,
                                    and each opens a different confirmation. */}
                                {mine.status === 'accepted' ? "Can't make it" : 'Withdraw'}
                              </button>
                            )}
                          </div>
                        ) : (
                          /**
                            * ── The word is "Select", because that is all
                            *    pressing it does ──
                            *
                            * It read "Request", and "Request" is the name of the
                            * thing the button at the bottom of this list does.
                            * Pressing it changed the label to "Selected", which
                            * a reader takes as the past tense of the verb they
                            * just performed — so the row said, in the two words
                            * it has, that the application had been sent. It had
                            * not. Nothing leaves this screen until "Send
                            * application" is pressed, and a volunteer who closed
                            * the page here had applied for nothing.
                            *
                            * "Select" → "Selected" is the same pair of words
                            * describing an act this control actually performs.
                            * The states that mean a real application — "Awaiting
                            * decision", "Waitlisted", "You're confirmed", each
                            * with Withdraw or "Can't make it" beside it — are rendered
                            * from `mine` in the branch above, which comes from
                            * the server. So the two are no longer expressible in
                            * the same words, and a reload (which empties
                            * `selectedSlots` and refetches `mine`) can only ever
                            * show the truthful one.
                            */
                          <button
                            className="btn btn-secondary btn-sm"
                            aria-pressed={isFull && !isSelected ? undefined : isSelected}
                            disabled={refused || signupsClosed || (isFull && !isSelected)}
                            onClick={() => handleSlotSelect(slot.id)}>
                            {isSelected ? 'Selected' : isFull ? 'Full' : 'Select'}
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {selectedSlots.length > 0 && (
        <div style={{ marginTop: 'var(--s4)' }} className="row-between">
          <button className="btn btn-primary" onClick={() => sendApplication()} disabled={submitting}>
            {submitting ? 'Sending…' : `Send application for ${selectedSlots.length} shift${selectedSlots.length !== 1 ? 's' : ''}`}
          </button>
          <span className="small dim">
            {formatHours(selectedSlots.reduce((sum, id) => sum + (event.slots.find(s => s.id === id)?.hours || 0), 0))} total
          </span>
        </div>
      )}
      {qrFor && (
        <CheckInCodeModal
          application={qrFor.application}
          slot={qrFor.slot}
          event={event}
          onClose={() => setQrFor(null)}
        />
      )}
    </>
  );
}
