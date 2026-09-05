import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, ShieldCheck, ShieldAlert } from 'lucide-react';
import { organizationPath } from '../../utils/organizationUrl';

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
              <Link to={organizationPath(o)} className="strong">
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

    /**
     * ── The kinds that had no card ──
     *
     * Twelve of twenty-four tool kinds reached `default` and rendered nothing.
     * Seven of those also had no summary sentence, so a successful lookup
     * answered "Here is what I found." with nothing under it — three of Welly's
     * own suggestion chips among them.
     *
     * The sentences were added first, because a sentence is the answer and a
     * card is the evidence. These are the kinds where the evidence is worth
     * showing: a list somebody scans, a set of figures somebody compares, a
     * record somebody clicks through to.
     *
     * Five kinds still have no card and should not have one. `application_
     * withdrawn`, `preferences_updated`, `profile_updated` and `event_created`
     * are confirmations of something that just happened — the sentence says it
     * completely, and a card repeating it in a box adds furniture rather than
     * information. `system_health` is two numbers already in the sentence.
     */
    case 'next_shift':
      if (!data.next) return null;
      return (
        <dl className="ai-card">
          <dt className="dim small">Next shift</dt>
          <dd className="strong">{data.next.eventTitle || 'Shift'}</dd>
          {data.next.startsAt && (
            <>
              <dt className="dim small">When</dt>
              <dd className="strong">{data.next.startsAt}</dd>
            </>
          )}
          {data.next.slotName && (
            <>
              <dt className="dim small">Role</dt>
              <dd className="strong">{data.next.slotName}</dd>
            </>
          )}
        </dl>
      );

    case 'waitlists':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Shifts you are waitlisted for">
          {data.items.map((w, i) => (
            <li key={i}>
              <span className="strong">{w.eventTitle || 'Shift'}</span>
              <span className="dim small ai-card-meta">
                {w.slotName ? `${w.slotName} · ` : ''}
                {w.position ? `Number ${w.position} in the queue` : 'On the waitlist'}
              </span>
            </li>
          ))}
        </ul>
      );

    /**
     * How far away the places just shown are.
     *
     * ── Why the card exists rather than the sentence carrying it ──
     *
     * The sentence names the closest one, which is the answer to "how far is
     * it?" when there is one thing on screen and the useful half of it when
     * there are several. The rest belong in a list: reading six distances out
     * in a paragraph is worse than a column of them, and the column is also
     * what makes the ordering visible.
     *
     * Sorted nearest-first by `assistant.js`; the order is not re-derived here,
     * so the sentence and the first row cannot disagree.
     */
    case 'distances':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="How far away these are">
          {data.items.map((d, i) => (
            <li key={`${d.title}-${i}`}>
              <span className="strong">{d.title}</span>
              <span className="dim small ai-card-meta">
                {d.miles} {d.miles === 1 ? 'mile' : 'miles'} away
                {d.location ? ` · ${d.location}` : ''}
              </span>
            </li>
          ))}
        </ul>
      );

    case 'my_events':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Events you run">
          {data.items.map(e => (
            <li key={e.id}>
              <Link to={`/discover?event=${encodeURIComponent(e.id)}`} className="strong">
                {e.title}
              </Link>
              <span className="dim small ai-card-meta">
                {e.status}
                {e.spotsRemaining != null ? ` · ${e.spotsRemaining} spots left` : ''}
                {e.deadline ? ` · Closes ${e.deadline}` : ''}
              </span>
            </li>
          ))}
        </ul>
      );

    case 'event_details':
      return (
        <div className="ai-card stack-xs">
          <Link to={`/discover?event=${encodeURIComponent(data.id)}`} className="strong">
            {data.title}
          </Link>
          <span className="dim small">
            {[data.category, data.location].filter(Boolean).join(' · ')}
            {data.deadline ? ` · Closes ${data.deadline}` : ''}
          </span>
          {data.slots?.length > 0 && (
            <ul className="stack-xs" aria-label="Shifts">
              {data.slots.map((slot, i) => (
                <li key={i} className="dim small">
                  {slot.name}
                  {slot.startsAt ? ` · ${slot.startsAt}` : ''}
                  {slot.maxSpots ? ` · ${slot.maxSpots} spots` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case 'organizer_summary':
      return (
        <dl className="ai-card">
          <dt className="dim small">Events</dt>
          <dd className="strong">{data.events}</dd>
          <dt className="dim small">Volunteers</dt>
          <dd className="strong">{data.volunteers}</dd>
          <dt className="dim small">Hours credited</dt>
          <dd className="strong">{data.hours}</dd>
          <dt className="dim small">Awaiting review</dt>
          <dd className="strong">{data.pending}</dd>
        </dl>
      );

    case 'platform_stats':
      return (
        <dl className="ai-card">
          <dt className="dim small">Members</dt>
          <dd className="strong">{data.users}</dd>
          <dt className="dim small">Events</dt>
          <dd className="strong">{data.events}</dd>
          <dt className="dim small">Hours credited</dt>
          <dd className="strong">{data.hours}</dd>
          <dt className="dim small">Open reports</dt>
          <dd className="strong">{data.openReports}</dd>
        </dl>
      );

    case 'recent_audit':
      if (!data.items?.length) return null;
      return (
        <ul className="ai-card stack-xs" aria-label="Recent audit entries">
          {data.items.map((entry, i) => (
            <li key={i}>
              <span className="strong">{entry.action}</span>
              {entry.at && <span className="dim small ai-card-meta">{entry.at}</span>}
            </li>
          ))}
        </ul>
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
    next_shift: 'Your applications',
    waitlists: 'Your applications',
    my_events: 'Your events',
    event_details: 'WeVolunteer opportunities',
    /* Measured in this browser from a location that never left it — see
       LocationContext. Naming the source matters more here than elsewhere
       because a distance sounds like something a server worked out. */
    distances: 'Measured on your device',
    organizer_summary: 'Your events',
    platform_stats: 'Platform analytics',
    recent_audit: 'The audit trail',
    system_health: 'Platform error reporting',
  };
  const label = SOURCES[kind];
  if (!label) return null;
  return <span className="dim small ai-source">Source: {label}</span>;
}
