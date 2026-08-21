import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, ShieldCheck, ShieldAlert } from 'lucide-react';

/**
 * The authoritative half of an answer.
 *
 * Everything here is rendered from tool data by plain code. The sentence above
 * it in the transcript may have been written by the model; this was not. When
 * the two disagree — which at these model sizes occasionally happens — this is
 * the one that is right, and it is the one carrying the numbers, codes and
 * links somebody would act on.
 *
 * Nothing here is `dangerouslySetInnerHTML`, and no value is interpolated into
 * markup. Event titles and organization names are written by other people, so
 * they are rendered as text by React and escaped in the ordinary way.
 */
export default function AssistantCard({ card, onAction }) {
  if (!card) return null;
  const { kind, data } = card;

  switch (kind) {
    case 'hours':
      return (
        <dl className="ai-card">
          <dt className="dim small">Verified hours</dt>
          <dd className="strong">{data.hours}</dd>
          {data.events > 0 && (
            <>
              <dt className="dim small">Events attended</dt>
              <dd className="strong">{data.events}</dd>
            </>
          )}
        </dl>
      );

    case 'opportunities':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Matching opportunities">
          {data.items.map(item => (
            <li key={item.id}>
              <Link to={`/discover?event=${encodeURIComponent(item.id)}`} className="strong">
                {item.title}
              </Link>
              <span className="dim small ai-card-meta">
                {item.location}
                {typeof item.distance === 'number' && (
                  <>
                    {' '}
                    <MapPin size={12} aria-hidden="true" />
                    {' '}
                    {item.distance.toFixed(1)} mi
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      );

    case 'certificates':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Your certificates">
          {data.items.map(c => (
            <li key={c.code}>
              <span className="strong">{c.eventTitle}</span>
              <span className="dim small ai-card-meta">
                {c.hours} hours · {c.code}
              </span>
            </li>
          ))}
        </ul>
      );

    case 'organizations':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Your organizations">
          {data.items.map(o => (
            <li key={o.slug}>
              <Link to={`/organizations/${encodeURIComponent(o.slug)}`} className="strong">
                {o.name}
              </Link>
            </li>
          ))}
        </ul>
      );

    case 'applications':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="What you have applied to">
          {data.items.map((a, i) => (
            <li key={`${a.eventTitle}-${i}`}>
              <span className="strong">{a.eventTitle}</span>
              <span className="dim small ai-card-meta">{a.status}</span>
            </li>
          ))}
        </ul>
      );

    case 'notifications':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Recent notifications">
          {data.items.map(n => (
            <li key={n.id}>
              <span className="strong">{n.title}</span>
              {n.body && <p className="dim small" style={{ margin: 0 }}>{n.body}</p>}
              <span className="dim small ai-card-meta">{n.at}</span>
            </li>
          ))}
        </ul>
      );

    case 'profile':
      return (
        <dl className="ai-card">
          <dt className="dim small">Name</dt>
          <dd className="strong">{data.name || 'Anonymous'}</dd>
          <dt className="dim small">Role</dt>
          <dd className="strong" style={{ textTransform: 'capitalize' }}>{data.role || 'Volunteer'}</dd>
          {data.school && (
            <>
              <dt className="dim small">School</dt>
              <dd className="strong">{data.school}</dd>
            </>
          )}
          <dt className="dim small">Verified hours</dt>
          <dd className="strong">{data.hours || 0}</dd>
        </dl>
      );

    case 'navigate':
      return (
        <div className="ai-card stack-xs">
          <Link
            to={data.path}
            className="btn btn-primary btn-sm"
            style={{ display: 'inline-flex', alignSelf: 'flex-start' }}
          >
            Open {data.label}
          </Link>
        </div>
      );

    case 'draft':
      return (
        <div className="ai-card stack-xs" style={{ borderLeft: '3px solid var(--green-600)' }}>
          <span className="strong dim small" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Pending Confirmation
          </span>
          <p className="strong" style={{ margin: 0 }}>{data.preview || data.summary}</p>
          <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onAction && onAction('confirm')}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onAction && onAction('cancel')}
            >
              Cancel
            </button>
          </div>
        </div>
      );

    case 'vacant_events':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Events needing volunteers">
          {data.items.map(e => (
            <li key={e.id}>
              <Link to={`/discover?event=${encodeURIComponent(e.id)}`} className="strong">
                {e.title}
              </Link>
              <span className="dim small ai-card-meta">
                {e.spotsRemaining} spots left · Deadline {e.deadline}
              </span>
            </li>
          ))}
        </ul>
      );

    case 'event_roster':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Event roster">
          {data.items.map((r, i) => (
            <li key={i}>
              <span className="strong">{r.name}</span>
              <span className="dim small ai-card-meta">
                {r.status} {r.slotName ? `· ${r.slotName}` : ''}
              </span>
            </li>
          ))}
        </ul>
      );

    case 'admin_reports':
      return (
        <dl className="ai-card">
          <dt className="dim small">Open safety reports</dt>
          <dd className="strong">{data.openReports}</dd>
          <dt className="dim small">Platform members</dt>
          <dd className="strong">{data.totalUsers}</dd>
          <dt className="dim small">Total events</dt>
          <dd className="strong">{data.totalEvents}</dd>
        </dl>
      );

    case 'admin_appeals':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Pending appeals">
          {data.items.map(a => (
            <li key={a.id}>
              <span className="strong">{a.subject}</span>
              <span className="dim small ai-card-meta">{a.status} · {a.at}</span>
            </li>
          ))}
        </ul>
      );

    case 'certificate':
      return (
        <div className="ai-card stack-xs">
          <span className="strong row" style={{ gap: 'var(--s2)' }}>
            {data.valid
              ? <><ShieldCheck size={16} aria-hidden="true" /> Verified</>
              : <><ShieldAlert size={16} aria-hidden="true" /> No match</>}
          </span>
          {data.valid && (
            <span className="dim small">
              {data.eventTitle} · {data.hours} hours
              {data.organizerName ? ` · ${data.organizerName}` : ''}
            </span>
          )}
        </div>
      );

    default:
      return null;
  }
}

/** Where an answer came from, so a factual claim is attributable. */
export function AssistantSource({ kind }) {
  const SOURCES = {
    hours: 'Your volunteer record',
    certificates: 'Your certificates',
    organizations: 'Your organizations',
    applications: 'Your applications',
    opportunities: 'WeVolunteer opportunities',
    certificate: 'WeVolunteer certificate verification',
    notifications: 'Your notifications',
    profile: 'Your profile',
    vacant_events: 'Your events',
    event_roster: 'Event roster',
    admin_reports: 'Platform moderation',
    admin_appeals: 'Platform appeals',
  };
  const label = SOURCES[kind];
  if (!label) return null;
  return <span className="dim small ai-source">Source: {label}</span>;
}
