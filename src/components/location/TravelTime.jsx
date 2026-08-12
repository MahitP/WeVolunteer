import React, { useEffect, useState } from 'react';
import { Car } from 'lucide-react';
import { api } from '../../utils/api';
import { useLocationContext } from '../../contexts/LocationContext';

/**
 * "About 14 min by car."
 *
 * ── What it says, and what it refuses to say ──
 *
 * A typical driving time, and it is labelled as one. The provider behind
 * `/api/travel-time` returns a free-flow figure from the road network: it does
 * not know the parkway is backed up this afternoon. So the wording is "about N
 * by car" and never "arrive by 3:47", never a leave-by time, and never a
 * countdown — those would be a number we made up wearing the clothes of one we
 * measured, which is the specific thing this feature was told not to ship.
 *
 * The live-traffic answer is one tap away and always has been: the directions
 * button beside this hands the destination to the maps app, which routes from
 * where the student actually is, in the mode they actually travel, with current
 * traffic, on-device. This is here so somebody can tell "twenty minutes away"
 * from "an hour away" without leaving the page and losing their place.
 *
 * ── Silence is the default ──
 *
 * Renders nothing at all when: location has not been granted, the event has no
 * coordinates, the deployment has no routing provider configured, the request
 * fails, times out, or the two points are absurdly far apart. No "travel time
 * unavailable", no error text, no empty box — the same rule `WeatherSummary`
 * follows, and for the same reason: a student who did not ask for this should
 * never be shown its failure.
 *
 * ── The origin ──
 *
 * Sent once, to our own server, in a POST body — never a query string, where a
 * proxy or an access log would keep a copy. The server coarsens it to ~110 m
 * before it reaches the provider and writes it nowhere. Nothing about the
 * student's position is stored on the device either; it lives in the location
 * context for the session and is gone with the tab.
 */
export default function TravelTime({ latitude, longitude }) {
  const { location } = useLocationContext() ?? {};
  const [label, setLabel] = useState(null);

  useEffect(() => {
    /* Guarded rather than aborted. Two of these can share a page and an
       AbortController belonging to one would cancel the other's request — the
       bug `WeatherSummary` was rewritten to remove. */
    let cancelled = false;
    setLabel(null);

    if (latitude == null || longitude == null) return undefined;
    if (!location?.latitude || !location?.longitude) return undefined;

    api.getTravelTime(location.latitude, location.longitude, latitude, longitude)
      .then(res => { if (!cancelled) setLabel(res?.result?.label ?? null); })
      /* Every failure is silence: no provider configured, no route, too far,
         timed out, rate limited, offline. */
      .catch(() => {});

    return () => { cancelled = true; };
  }, [latitude, longitude, location?.latitude, location?.longitude]);

  if (!label) return null;

  return (
    <span className="small dim row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
      <Car size={14} aria-hidden="true" />
      {/* "About" is doing real work: it is the difference between an estimate
          and a promise, and it is the only honest framing for a figure that
          cannot see traffic. */}
      <span>About {label} by car</span>
    </span>
  );
}
