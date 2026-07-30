import React from 'react';
import { MapPin, Layers, CalendarClock, ShieldCheck, Star } from 'lucide-react';
import { formatHours, formatDay, formatTimeRange, countdown } from '../utils/helpers';
import { Seats, DateChip } from './Seats';
import { LocationThumbnail } from './location';
export default function EventCard({
  event,
  currentUser,
  applications = [],
  onViewDetails,
  isFavorited,
  onToggleFavorite
}) {
  const isCompleted = event.status === 'completed';
  const isCancelled = event.status === 'cancelled';
  const isClosed = event.status === 'closed';
  const deadlinePassed = new Date() > new Date(event.applicationDeadline);
  const isOpen = !isCompleted && !isCancelled && !isClosed && !deadlinePassed;
  const myApps = applications.filter(a => a.eventId === event.id && a.userId === currentUser?.id);
  const accepted = myApps.some(a => a.status === 'accepted');
  const pending = myApps.some(a => a.status === 'pending');
  const waitlisted = myApps.some(a => a.status === 'waitlisted');
  const filled = event.maxSpots - event.spotsRemaining;
  const slotCount = event.slots?.length || 0;
  const dayCount = event.slots ? new Set(event.slots.map(s => new Date(s.startDatetime).toDateString())).size : 0;

  // One status line, chosen by precedence: my involvement first, then the
  // event's own state. Never both — two badges make people hunt.
  const myStatus = accepted ? {
    cls: 'status-ok',
    text: "You're in"
  } : pending ? {
    cls: 'status-pending',
    text: 'Application pending'
  } : waitlisted ? {
    cls: 'status-info',
    text: 'Waitlisted'
  } : null;
  const eventStatus = isCancelled ? {
    cls: 'status-danger',
    text: 'Cancelled'
  } : isCompleted ? {
    cls: 'status-muted',
    text: 'Completed'
  } : isClosed || deadlinePassed ? {
    cls: 'status-muted',
    text: 'Applications closed'
  } : event.spotsRemaining <= 0 ? {
    cls: 'status-danger',
    text: 'Full'
  } : null;
  const status = myStatus || eventStatus;
  return <article className={`eventcard ${isOpen ? '' : 'is-closed'}`}>
      <div className="eventcard-top">
        <DateChip iso={event.startDatetime} />
        {/* min-width:0 (not .truncate) so the title can clamp to two lines
            instead of inheriting nowrap from a truncating parent. */}
        <div className="s-7b2db8">
          <h3 className="eventcard-title" title={event.title}>{event.title}</h3>
          <p className="eventcard-meta truncate">
            <span className="tag">{event.category}</span>
            <span className="truncate">{event.organizerName}</span>
            {event.organizerVerified && <ShieldCheck size={13} aria-label="Verified organizer" className="s-733461" />}
          </p>
        </div>
        {currentUser?.role === 'student' && onToggleFavorite && <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={e => {
        e.stopPropagation();
        onToggleFavorite(event.id);
      }} style={{
        color: isFavorited ? 'var(--accent)' : 'var(--ink-3)',
        alignSelf: 'flex-start',
        marginLeft: 'var(--s2)'
      }} title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}>
            <Star size={16} fill={isFavorited ? 'var(--accent)' : 'none'} />
          </button>}
      </div>

      <div className="eventcard-body">
        <div className="eventcard-facts">
          <span className="eventcard-fact">
            <CalendarClock size={14} />
            <span className="tnum">
              {formatDay(event.startDatetime)} · {formatTimeRange(event.startDatetime, event.endDatetime)}
            </span>
          </span>
          <LocationThumbnail 
            location={event.location}
            latitude={event.latitude}
            longitude={event.longitude}
            distance={event.distance}
            onClick={onViewDetails}
          />
          {slotCount > 0 && <span className="eventcard-fact">
              <Layers size={14} />
              {slotCount} shift{slotCount !== 1 ? 's' : ''}
              {dayCount > 1 && ` across ${dayCount} days`}
              {' · up to '}
              <span className="strong">{formatHours(event.hoursAwarded)}</span>
            </span>}
        </div>

        {!isCompleted && !isCancelled && <Seats filled={filled} total={event.maxSpots} />}
      </div>

      <div className="eventcard-foot">
        {status ? <span className={`status ${status.cls}`}>{status.text}</span> : <span className="small dim tnum">
            Closes {countdown(event.applicationDeadline).toLowerCase()}
          </span>}
        <button className={`btn btn-sm ${isOpen && !myApps.length ? 'btn-primary' : 'btn-secondary'} s-dc310e`} onClick={() => onViewDetails(event)}>
          {myApps.length ? 'View sign-up' : isOpen ? 'View shifts' : 'View details'}
        </button>
      </div>
    </article>;
}