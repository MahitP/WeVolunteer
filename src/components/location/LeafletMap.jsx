import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix the default marker icon issue with bundlers.
// Vite resolves these imports to hashed asset URLs in dist/, so they
// work without touching the Content Security Policy.
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

const customIcon = L.divIcon({
  className: 'custom-map-pin',
  html: '<div class="custom-map-pin-inner"></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  popupAnchor: [0, -12]
});

/**
 * Actual Leaflet map component. Rendered inside a Suspense boundary.
 * Interactive interactions can be enabled via the `interactive` prop.
 */
export default function LeafletMap({ latitude, longitude, label, interactive = false }) {
  const [isDark, setIsDark] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark');

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'data-theme') {
          setIsDark(document.documentElement.getAttribute('data-theme') === 'dark');
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });
    
    // Catch cases where the theme was applied before the observer attached
    setIsDark(document.documentElement.getAttribute('data-theme') === 'dark');
    
    return () => observer.disconnect();
  }, []);

  return (
    <MapContainer
      center={[latitude, longitude]}
      zoom={15}
      scrollWheelZoom={interactive}
      dragging={interactive}
      doubleClickZoom={interactive}
      zoomControl={interactive}
      keyboard={interactive}
      touchZoom={interactive}
      attributionControl={true}
      style={{ height: '100%', width: '100%' }}
    >
      {/**
        * A basemap drawn dark, rather than a light one turned inside out.
        *
        * This used to serve Voyager at every theme and, in dark mode, put
        * `filter: invert(100%) hue-rotate(180deg)` over it. Voyager is a light
        * pastel cartography; inverting it does not produce a dark map, it
        * produces a photographic negative — parks turn magenta, water turns
        * sand, and the label halos that were white become black smears around
        * black text. That is the "ugly, high-contrast" map, and it was on the
        * organizer's event-creation picker and the student's event map alike,
        * because both render this one component.
        *
        * CARTO publishes `dark_all` for exactly this purpose: the same street
        * network, drawn for a dark background, with labels designed to be
        * legible on it. Swapping the URL is also cheaper than compositing a
        * full-tile filter on every pan.
        *
        * `{r}` is Leaflet's retina suffix and both basemaps honour it.
        * Attribution is identical and non-negotiable — OpenStreetMap's licence
        * and CARTO's terms both require it, and it is rendered by the control,
        * not by this string alone.
        */}
      <TileLayer
        key={isDark ? 'dark' : 'light'}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url={isDark
          ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
          : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'}
      />
      <Marker position={[latitude, longitude]} icon={customIcon}>
        {label && <Popup>{label}</Popup>}
      </Marker>
    </MapContainer>
  );
}
