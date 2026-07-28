import React, { useMemo } from 'react';
import { Info, CalendarClock } from 'lucide-react';
import { formatDay, formatTime, formatHours, usesAutoSelect } from '../utils/helpers';
import { Seats } from './Seats';
import EmptyState from './common/EmptyState';

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
        <span className="section-action small dim tnum">
          {event.maxSpots - event.spotsRemaining} of {event.maxSpots} spots filled
        </span>
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
                            {(mine.status === 'accepted' || mine.status === 'pending' || mine.status === 'waitlisted') && (
                              <button className="btn btn-ghost btn-sm"
                                disabled={submitting}
                                onClick={() => onRelease(mine, slot.name)}>
                                {mine.status === 'accepted' ? 'Release' : 'Withdraw'}
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={signupsClosed || (isFull && !isSelected)}
                            onClick={() => handleSlotSelect(slot.id)}>
                            {isSelected ? 'Selected' : isFull ? 'Full' : 'Request'}
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
          <button className="btn btn-primary" onClick={sendApplication} disabled={submitting}>
            {submitting ? 'Sending…' : `Send application for ${selectedSlots.length} shift${selectedSlots.length !== 1 ? 's' : ''}`}
          </button>
          <span className="small dim">
            {formatHours(selectedSlots.reduce((sum, id) => sum + (event.slots.find(s => s.id === id)?.hours || 0), 0))} total
          </span>
        </div>
      )}
    </>
  );
}
