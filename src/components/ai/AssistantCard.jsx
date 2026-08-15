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
export default function AssistantCard({ card }) {
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

    case 'certificate':
      /**
       * The verdict shown is the verification service's, repeated. The
       * assistant never forms an opinion about whether a certificate is
       * genuine — that would be a claim about a real document.
       */
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
  };
  const label = SOURCES[kind];
  if (!label) return null;
  return <span className="dim small ai-source">Source: {label}</span>;
}
