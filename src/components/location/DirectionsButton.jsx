import React from 'react';
import { Navigation } from 'lucide-react';

/**
 * Opens directions to a location. On mobile, the OS intercepts the
 * Google Maps URL and offers native navigation apps.
 */
export default function DirectionsButton({ latitude, longitude, label }) {
  if (latitude == null || longitude == null) return null;

  const url = `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`;

  return (
    <a
      className="directions-btn"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Get directions to ${label || 'event location'}`}
    >
      <Navigation size={14} />
      Get Directions
    </a>
  );
}
