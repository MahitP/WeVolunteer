import React from 'react';
import { ExternalLink } from 'lucide-react';
import { mapsDirectionsUrl } from '../../utils/mapsLink';
import './LocationDisplay.css';

/**
 * An event's location, as something you can obviously press.
 *
 * Every surface in the app rendered a location as plain text — the modal, the
 * dashboard's next-shift card, the calendar rows — so the single most useful
 * thing a volunteer can do with an address, get directions to it, was available
 * nowhere. This is the inline version of that affordance, for places where the
 * location sits in a line of text rather than in a card of its own.
 *
 * ── A real anchor, not a button with an onClick ──
 *
 * Middle-click, cmd-click, "copy link address", and the correct role in a
 * screen reader all come free with `<a href>` and all have to be rebuilt badly
 * with a button. The href is a real destination, so it should be one.
 *
 * ── It must never be rendered inside a button ──
 *
 * An anchor nested in a button is invalid HTML with genuinely broken keyboard
 * behaviour. `CalendarView`'s `EntryRow` has a `<button>` root, which is why the
 * calendar shows distance instead of a link.
 */
export default function LocationLink({
  location,
  address,
  latitude,
  longitude,
  className = '',
}) {
  const text = location || address;
  const href = mapsDirectionsUrl({ location, address, latitude, longitude });

  /* Nothing to show and nowhere to go. An event with no location at all is
     rare but real, and the honest answer is to say so rather than render an
     affordance that leads nowhere. */
  if (!text && !href) {
    return <span className="dim">Location to be announced</span>;
  }

  /* Text but no destination should not happen — `mapsDirectionsUrl` falls back
     all the way to the bare place name — but a component that renders a dead
     link if that assumption ever changes is worse than one that renders text. */
  if (!href) return <span>{text}</span>;

  /**
   * `geo:` hands off to a native app rather than a tab, so it takes neither
   * `target` nor the "new tab" warning. Announcing "opens in a new tab" for a
   * URI that opens Waze would be a lie told only to screen-reader users.
   */
  const isAppHandoff = href.startsWith('geo:');

  return (
    <a
      className={`location-link ${className}`.trim()}
      href={href}
      {...(isAppHandoff ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
    >
      <span>{text}</span>
      <ExternalLink size={11} className="location-link-glyph" aria-hidden="true" />
      <span className="sr-only">
        {isAppHandoff ? ' (opens directions in your maps app)' : ' (opens directions in a new tab)'}
      </span>
    </a>
  );
}
