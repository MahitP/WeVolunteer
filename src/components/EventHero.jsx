import React from 'react';
import { Calendar, Clock, MapPin, ShieldCheck } from 'lucide-react';
import { formatDay, formatTimeRange, selectionMethodLabel } from '../utils/helpers';
import './EventHero.css';

export default function EventHero({ event }) {
  const isClosed = event.status !== 'open' || new Date() > new Date(event.applicationDeadline);

  return (
    <div className="event-hero">
      <div className="event-hero-tags">
        <span className="tag tag-brand">{event.category}</span>
        <span className="tag tag-ok">{selectionMethodLabel(event)}</span>
        {isClosed && <span className="tag">Applications closed</span>}
      </div>
      
      <h1 className="event-hero-title">{event.title}</h1>
      
      <div className="event-hero-org">
        Hosted by <span className="org-name">{event.organizerName}</span>
        {event.organizerVerified && (
          <span className="org-verified-badge" title="Verified Organizer">
            <ShieldCheck size={14} /> Verified
          </span>
        )}
      </div>

      <div className="event-hero-quickinfo">
        <div className="quickinfo-item">
          <Calendar size={16} className="quickinfo-icon" />
          <span>{formatDay(event.startDatetime)}</span>
        </div>
        <div className="quickinfo-item">
          <Clock size={16} className="quickinfo-icon" />
          <span>{formatTimeRange(event.startDatetime, event.endDatetime)}</span>
        </div>
        <div className="quickinfo-item">
          <MapPin size={16} className="quickinfo-icon" />
          <span>{event.location}</span>
        </div>
      </div>
    </div>
  );
}
