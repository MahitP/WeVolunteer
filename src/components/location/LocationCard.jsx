import React from 'react';
import { MapPin, Navigation } from 'lucide-react';
import MapPreview from './MapPreview';
import './LocationCard.css';

export default function LocationCard({ location, address, latitude, longitude, distance }) {
  const hasCoords = latitude != null && longitude != null;

  const openDirections = () => {
    if (!hasCoords && !address && !location) return;
    const dest = hasCoords ? `${latitude},${longitude}` : encodeURIComponent(address || location);
    window.open(
      `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  return (
    <div className="location-card">
      <div className="location-card-header">
        <span className="location-card-icon" aria-hidden="true"><MapPin size={18} /></span>
        <div>
          <span className="eyebrow">Location</span>
          <h3>{location || 'Location to be announced'}</h3>
        </div>
      </div>
      
      <div className="location-card-body">
        <div className="location-card-info">
          {address ? <div className="location-card-address">{address}</div> : <div className="location-card-address">The organizer has not added a street address yet.</div>}
          
          <div className="location-card-meta">
            {distance != null && (
              <span className="location-card-distance">{distance.toFixed(1)} miles from you</span>
            )}
            {!hasCoords && <span className="location-card-distance">Map preview unavailable</span>}
          </div>

          <button className="btn btn-secondary btn-sm location-directions-btn" onClick={openDirections}>
            <Navigation size={14} /> Get Directions
          </button>
        </div>

        {hasCoords && (
          <div className="location-card-map-wrapper">
            <MapPreview
              latitude={latitude}
              longitude={longitude}
              label={location}
              height={220}
              onClick={openDirections}
              interactive={false}
            />
            <div className="location-card-map-label">{location}</div>
          </div>
        )}
      </div>
    </div>
  );
}
