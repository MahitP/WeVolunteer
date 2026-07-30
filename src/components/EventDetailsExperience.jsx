import React from 'react';
import {
  ArrowRight,
  Calendar,
  CheckCircle,
  Clock,
  CloudSun,
  Flag,
  Heart,
  Info,
  ListChecks,
  MapPin,
  Share2,
  ShieldCheck,
  Sparkles,
  Users
} from 'lucide-react';
import {
  countdown,
  formatDay,
  formatHours,
  formatTime,
  formatTimeRange,
  selectionMethodLabel,
  usesAutoSelect
} from '../utils/helpers';
import LocationCard from './location/LocationCard';
import WeatherSummary from './location/WeatherSummary';
import './EventDetailsExperience.css';

function totalShiftHours(event) {
  return formatHours(event.hoursAwarded || event.slots?.reduce((sum, slot) => sum + (slot.hours || 0), 0) || 0);
}

function firstUsefulSlotDescription(event) {
  return event.slots?.map(slot => slot.description?.trim()).find(Boolean) || '';
}

function InfoPill({ icon: Icon, label, value, detail }) {
  return (
    <div className="event-info-pill">
      <span className="event-info-pill-icon" aria-hidden="true"><Icon size={17} /></span>
      <span>
        <span className="event-info-pill-label">{label}</span>
        <strong>{value}</strong>
        {detail && <span className="event-info-pill-detail">{detail}</span>}
      </span>
    </div>
  );
}

function Section({ eyebrow, title, children, className = '' }) {
  return (
    <section className={`event-story-section ${className}`} aria-labelledby={`${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-heading`}>
      <div className="event-story-heading">
        <span className="eyebrow">{eyebrow}</span>
        <h3 id={`${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-heading`}>{title}</h3>
      </div>
      {children}
    </section>
  );
}

function ApplicationPanel({
  event,
  currentUser,
  iAmConfirmed,
  myApps,
  signupsClosed,
  onApplyClick,
  onShare,
  onMessageOrganizer
}) {
  const isStudent = currentUser?.role === 'student';
  const hasApplied = myApps.length > 0;

  if (!isStudent) return null;

  const status = iAmConfirmed
    ? { icon: CheckCircle, title: 'You are confirmed', text: 'This opportunity is on your schedule.', className: 'is-confirmed' }
    : hasApplied
      ? { icon: Clock, title: 'Application sent', text: 'Watch for a decision from the organizer.', className: 'is-pending' }
      : null;

  const StatusIcon = status?.icon;

  return (
    <aside className="event-apply-panel" aria-label="Application actions">
      {status && (
        <div className={`event-apply-status ${status.className}`}>
          <StatusIcon size={18} />
          <span>
            <strong>{status.title}</strong>
            <span>{status.text}</span>
          </span>
        </div>
      )}

      <div className="event-apply-main">
        <span className="eyebrow">Participate</span>
        <h3>{signupsClosed ? 'Applications are closed' : hasApplied ? 'Manage your shifts' : 'Ready to help?'}</h3>
        <p>
          {signupsClosed
            ? 'You can still review the event details and updates.'
            : hasApplied
              ? 'Review your requested shifts or withdraw from a shift below.'
              : 'Choose the shift that works for you and send your application.'}
        </p>
      </div>

      {!signupsClosed && !iAmConfirmed && (
        <button className="btn btn-primary btn-lg event-apply-button" onClick={onApplyClick}>
          {hasApplied ? 'View Shifts' : 'Apply Now'} <ArrowRight size={16} />
        </button>
      )}

      {hasApplied && onMessageOrganizer && (
        <button className="btn btn-secondary btn-block event-apply-button" style={{ marginTop: 'var(--s2)' }} onClick={() => onMessageOrganizer(event.organizerId)}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg> Message Organizer
        </button>
      )}

      <div className="event-apply-meta">
        <span>Closes</span>
        <strong>{formatDay(event.applicationDeadline)}, {formatTime(event.applicationDeadline)}</strong>
        <em>{countdown(event.applicationDeadline)}</em>
      </div>

      <button className="btn btn-secondary btn-sm event-share-button" type="button" onClick={onShare}>
        <Share2 size={14} /> Share
      </button>
    </aside>
  );
}

function WeatherCard({ event }) {
  const hasCoords = event.latitude != null && event.longitude != null;

  return (
    <div className="event-weather-card">
      <div className="event-weather-icon" aria-hidden="true"><CloudSun size={22} /></div>
      <div>
        <span className="eyebrow">{formatDay(event.startDatetime)} Conditions</span>
        {hasCoords ? (
          <>
            <WeatherSummary latitude={event.latitude} longitude={event.longitude} datetime={event.startDatetime} />
            <p>Forecast helps you plan what to wear and bring.</p>
          </>
        ) : (
          <p>Weather will appear when this event has a mapped location.</p>
        )}
      </div>
    </div>
  );
}

function VolunteerDetails({ event, instructionsVisible }) {
  const slotCount = event.slots?.length || 0;
  const usefulSlotDescription = firstUsefulSlotDescription(event);

  const details = [
    {
      label: 'Hours',
      value: `Up to ${totalShiftHours(event)}`,
      detail: slotCount > 1 ? `Across ${slotCount} shifts` : 'Single shift'
    },
    {
      label: 'Requirements',
      value: instructionsVisible && event.instructions ? event.instructions : 'No special requirements listed',
      detail: instructionsVisible && event.instructions ? 'Shared with confirmed volunteers' : 'Check updates before attending'
    },
    {
      label: 'Age restrictions',
      value: 'Open to eligible student volunteers',
      detail: 'Organizer will note exceptions in updates'
    },
    {
      label: 'What to bring',
      value: usefulSlotDescription || 'Bring anything the organizer posts in updates',
      detail: usefulSlotDescription ? 'From the shift notes' : 'No supplies listed yet'
    }
  ];

  return (
    <div className="event-detail-grid">
      {details.map(item => (
        <div className="event-detail-tile" key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <em>{item.detail}</em>
        </div>
      ))}
    </div>
  );
}

export default function EventDetailsExperience({
  event,
  currentUser,
  signupsClosed,
  deadlinePassed,
  iAmConfirmed,
  isOwner,
  isAdmin,
  myApps,
  distance,
  selectedTab,
  tabs,
  tabRefs,
  onTabChange,
  onTabKeyDown,
  onApplyClick,
  onShare,
  onReport,
  isFavorited,
  onToggleFavorite,
  organizerTools,
  onMessageOrganizer,
  children
}) {
  const instructionsVisible = Boolean(event.instructions && (iAmConfirmed || isOwner || isAdmin));
  const spotsLabel = `${event.spotsRemaining} of ${event.maxSpots} open`;
  const shortDescription = event.description || 'A local volunteer opportunity posted by your community.';

  return (
    <div className="event-details-experience">
      <header className="event-detail-hero">
        <div className="event-detail-hero-main">
          <div className="event-detail-tags">
            <span className="tag tag-brand">{event.category}</span>
            <span className="tag tag-ok">{selectionMethodLabel(event)}</span>
            {signupsClosed && <span className="tag tag-warn">Applications closed</span>}
          </div>

          <h2>{event.title}</h2>
          <p className="event-detail-summary">{shortDescription}</p>

          <div className="event-detail-org">
            <span>Hosted by <strong>{event.organizerName}</strong></span>
            {event.organizerVerified && (
              <span className="tag tag-ok" title="This organizer has been verified by school staff">
                <ShieldCheck size={11} /> Verified organizer
              </span>
            )}
          </div>
        </div>

        <div className="event-detail-hero-actions">
          {currentUser?.role === 'student' && onToggleFavorite && (
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => onToggleFavorite(event.id)}
              title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
              aria-label={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Heart size={16} fill={isFavorited ? 'currentColor' : 'none'} />
            </button>
          )}
          {currentUser && currentUser.id !== event.organizerId && (
            <button type="button" className="btn btn-secondary btn-icon btn-sm" onClick={onReport} title="Report this event" aria-label="Report this event">
              <Flag size={16} />
            </button>
          )}
        </div>
      </header>

      <div className="event-quick-grid" aria-label="Key event information">
        <InfoPill icon={Calendar} label="Date" value={formatDay(event.startDatetime)} />
        <InfoPill icon={Clock} label="Time" value={formatTimeRange(event.startDatetime, event.endDatetime)} />
        <InfoPill icon={MapPin} label="Location" value={event.location} detail={distance != null ? `${distance.toFixed(1)} miles away` : undefined} />
        <InfoPill icon={Users} label="Spots" value={spotsLabel} detail={`${event.maxSpots - event.spotsRemaining} filled`} />
      </div>

      <div className="event-detail-layout">
        <main className="event-detail-story">
          <Section eyebrow="About" title="About This Opportunity">
            <div className="event-about-copy">
              <p>{shortDescription}</p>
              <div className="event-why-row">
                <span aria-hidden="true"><Sparkles size={17} /></span>
                <p>
                  {usesAutoSelect(event)
                    ? 'Applications stay open until the deadline, then Auto Select helps assign spots fairly.'
                    : `${event.organizerName} will review applications and notify volunteers when decisions are made.`}
                </p>
              </div>
            </div>
          </Section>

          <Section eyebrow="When and where" title="Where You'll Be">
            <LocationCard
              location={event.location}
              address={event.address}
              latitude={event.latitude}
              longitude={event.longitude}
              distance={distance}
            />
          </Section>

          <Section eyebrow="Conditions" title="Plan for the Day">
            <WeatherCard event={event} />
          </Section>

          {instructionsVisible && (
            <div className="event-arrival-note">
              <Info size={16} />
              <span>
                <strong>Before you go</strong>
                <span>{event.instructions}</span>
              </span>
            </div>
          )}

          <Section eyebrow="Details" title="Volunteer Details">
            <VolunteerDetails event={event} instructionsVisible={instructionsVisible} />
          </Section>

          {organizerTools}

          <section className="event-workspace" aria-label="Event workspace">
            <div className="event-workspace-head">
              <div>
                <span className="eyebrow">Next steps</span>
                <h3>Choose shifts and follow updates</h3>
              </div>
              {deadlinePassed && <span className="tag tag-warn">Deadline passed</span>}
            </div>

            <div className="tabs" role="tablist" aria-label="Event sections" onKeyDown={onTabKeyDown}>
              {tabs.map(({ id, label, icon: Icon, count }) => (
                <button
                  key={id}
                  id={`tab-${id}`}
                  role="tab"
                  aria-selected={selectedTab === id}
                  aria-controls={`tabpanel-${id}`}
                  tabIndex={selectedTab === id ? 0 : -1}
                  ref={el => {
                    tabRefs.current[id] = el;
                  }}
                  className="tab"
                  onClick={() => onTabChange(id)}
                >
                  <Icon size={14} />
                  {label}
                  {count > 0 && (
                    <>
                      <span className="tab-count" aria-hidden="true">{count}</span>
                      <span className="sr-only">({count} awaiting your decision)</span>
                    </>
                  )}
                </button>
              ))}
            </div>

            <div className="tabpanel" role="tabpanel" id={`tabpanel-${selectedTab}`} aria-labelledby={`tab-${selectedTab}`} tabIndex={0}>
              {children}
            </div>
          </section>
        </main>

        <ApplicationPanel
          event={event}
          currentUser={currentUser}
          iAmConfirmed={iAmConfirmed}
          myApps={myApps}
          signupsClosed={signupsClosed}
          onApplyClick={onApplyClick}
          onShare={onShare}
          onMessageOrganizer={onMessageOrganizer}
        />
      </div>
    </div>
  );
}
