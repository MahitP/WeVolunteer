import React from 'react';
import { Navigation } from 'lucide-react';
import { mapsDirectionsUrl } from '../../utils/mapsLink';
import './LocationDisplay.css';

/**
 * "Get directions", as a pill.
 *
 * The prominent sibling of `LocationLink`: same destination logic, used where
 * directions are an action in their own right rather than a property of a line
 * of text.
 *
 * ── Two things changed from the version that shipped ──
 *
 * It used to return `null` without coordinates, so the majority of events —
 * every one whose organizer typed a place name instead of opening the picker —
 * got no directions affordance at all, even though a street address is a
 * perfectly good destination. It now falls back to the address, then to the
 * place name.
 *
 * And it used to hardcode a Google Maps URL while its own comment claimed the
 * OS would offer a choice. `mapsDirectionsUrl` is where that is now actually
 * true; see the reasoning there.
 */
export default function DirectionsButton({ latitude, longitude, address, label, location }) {
  const name = label || location;
  const href = mapsDirectionsUrl({ latitude, longitude, address, location: name });

  if (!href) return null;

  const isAppHandoff = href.startsWith('geo:');

  return (
    <a
      className="directions-btn"
      href={href}
      {...(isAppHandoff ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
      aria-label={`Get directions to ${name || 'the event location'}`}
    >
      <Navigation size={14} aria-hidden="true" />
      Get directions
      <span className="sr-only">
        {isAppHandoff ? ' (opens in your maps app)' : ' (opens in a new tab)'}
      </span>
    </a>
  );
}
