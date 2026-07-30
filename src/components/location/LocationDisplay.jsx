import React from 'react';
import MapPreview from './MapPreview';
import WeatherSummary from './WeatherSummary';
import './LocationDisplay.css';

/**
 * Read-only location display for students viewing event details.
 * Rendered inline alongside other event metadata.
 */
export default function LocationDisplay({ location, address, latitude, longitude, distance, datetime }) {
  const hasCoords = latitude != null && longitude != null;

  const openDirections = () => {
    if (!hasCoords) return;
    window.open(
      `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  if (!hasCoords) {
    // Legacy fallback: plain text, no map
    return (
      <div className="location-inline">
        <div className="location-inline-name">{location}</div>
      </div>
    );
  }

  return (
    <div className="location-inline" onClick={openDirections} style={{ cursor: 'pointer' }} title="Get directions">
      <div className="location-inline-details">
        <div className="location-inline-name">{location}</div>
        {address && <div className="location-inline-address">{address}</div>}
        {distance != null && (
          <div className="location-inline-distance">{distance.toFixed(1)} miles away</div>
        )}
        <WeatherSummary latitude={latitude} longitude={longitude} datetime={datetime} />
      </div>
      
      <div className="location-inline-map">
        <MapPreview
          latitude={latitude}
          longitude={longitude}
          height={100}
          interactive={false}
        />
        {/* Dark overlay gradient and text label to match the premium design */}
        <div className="location-inline-map-overlay">
          <span className="location-inline-map-label">{location}</span>
        </div>
        {/* Invisible overlay to prevent map interactions blocking the click */}
        <div style={{ position: 'absolute', inset: 0, zIndex: 10 }}></div>
      </div>
    </div>
  );
}
