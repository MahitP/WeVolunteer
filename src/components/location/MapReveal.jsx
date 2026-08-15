import React, { useState } from 'react';
import { Map as MapIcon } from 'lucide-react';
import MapPreview from './MapPreview';
import './LocationDisplay.css';

/**
 * A map that loads when somebody asks for it.
 *
 * ── Why this is not just `<MapPreview>` ──
 *
 * Map tiles are fetched by the student's own browser, directly from the tile
 * provider. That makes the provider the one third party in this application
 * that sees a student's IP address — the geocoder and the forecast service are
 * both called server-side and never learn who is asking. The compliance review
 * flagged it and named click-to-load as the accepted interim answer while a
 * server-side tile proxy remains unbuilt.
 *
 * So: rendering a map because a page happened to open is a disclosure nobody
 * asked for. Rendering one because somebody pressed "Show map" is one they did.
 * The note under the button says which provider, because a consent nobody can
 * read is not one.
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
          Loads map tiles from CARTO, an outside map provider.
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
