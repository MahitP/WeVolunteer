import React, { Suspense, lazy, useMemo } from 'react';
import './LocationPicker.css';

/**
 * Lazy-loaded wrapper for the actual Leaflet map.
 * Only fetches react-leaflet + leaflet when first rendered.
 */
const LeafletMap = lazy(() => import('./LeafletMap.jsx'));

/**
 * Small informational map preview. All interactions disabled.
 * Clicking opens directions to the location.
 */
export default function MapPreview({ latitude, longitude, label, height = 180, onClick, interactive = false }) {
  if (latitude == null || longitude == null) return null;

  const style = useMemo(() => ({ height, width: '100%' }), [height]);
  
  // If the map itself is interactive, don't intercept clicks to open directions
  const containerClick = interactive ? undefined : onClick;

  return (
    <div
      className="map-preview"
      style={style}
      onClick={containerClick}
      role="img"
      aria-label={`Map showing event location${label ? ` at ${label}` : ''}`}
      tabIndex={containerClick ? 0 : undefined}
      onKeyDown={containerClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); containerClick(); } } : undefined}
    >
      <Suspense fallback={<div className="map-fallback" style={style}>Loading map...</div>}>
        <LeafletMap latitude={latitude} longitude={longitude} label={label} interactive={interactive} />
      </Suspense>
    </div>
  );
}
