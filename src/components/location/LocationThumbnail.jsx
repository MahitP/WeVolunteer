import React from 'react';
import { MapPin } from 'lucide-react';
import './LocationDisplay.css';

/**
 * Lightweight location thumbnail for event cards and list views.
 * Displays the location name and distance, without rendering a map.
 */
export default function LocationThumbnail({ location, latitude, longitude, distance, onClick }) {
  const hasCoords = latitude != null && longitude != null;

  return (
    <span className="eventcard-fact" onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <MapPin size={14} />
      <span className="truncate" title={location}>
        {location}
        {hasCoords && distance != null && (
          <span className="s-775d10" style={{ opacity: 0.8 }}> · {distance.toFixed(1)} mi away</span>
        )}
      </span>
    </span>
  );
}
