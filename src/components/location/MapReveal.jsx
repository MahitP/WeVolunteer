import React, { useState } from 'react';
import { Map as MapIcon } from 'lucide-react';
import MapPreview from './MapPreview';
import './LocationDisplay.css';

/**
 * A map that loads when somebody asks for it.
 *
 * ── Why this is not just `<MapPreview>` ──
 *
 * Map tiles used to be fetched by the student's own browser, directly from the
 * tile provider — the one third party in this application that saw a student's
 * IP address. The compliance review named click-to-load as the interim and a
 * server-side proxy as the fix; the proxy now exists (server/routes/tileRoutes.js),
 * so no outside provider sees the reader at all.
 *
 * Click-to-load stays anyway. A map is still a dozen requests and a 154 kB
 * Leaflet chunk that most readers of an event never want, and the note under the
 * button still says where the map data comes from, because that is true and
 * worth knowing.
 *
 * It also happens to keep a 154 kB Leaflet chunk off the critical path, but
 * that is a side effect, not the reason.
 *
 * ── The choice is deliberately NOT remembered ──
 *
 * Persisting "yes" to sessionStorage would restore eager loading for every
 * subsequent event in the session without a fresh act of consent, which is
 * precisely the behaviour this control exists to prevent. If that ever looks
 * like an optimisation worth making, it is not.
 */
export default function MapReveal({ latitude, longitude, label, height = 220 }) {
  const [shown, setShown] = useState(false);

  if (latitude == null || longitude == null) return null;

  if (!shown) {
    return (
      <div className="map-reveal">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShown(true)}>
          <MapIcon size={14} aria-hidden="true" /> Show map
        </button>
        <span className="map-reveal-note">
          Map data from OpenStreetMap, loaded through WeVolunteer — the map provider does not see your device.
        </span>
      </div>
    );
  }

  return (
    <div className="map-reveal is-shown">
      <MapPreview
        latitude={latitude}
        longitude={longitude}
        label={label}
        height={height}
        interactive
      />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown(false)}>
        Hide map
      </button>
    </div>
  );
}
