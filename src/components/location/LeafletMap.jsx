import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { basemapFor } from './basemap';

/**
 * The upstream the server chose, asked once per page load and shared by every
 * map on it. A failure is not an error the reader needs to see: the map still
 * draws, crediting OpenStreetMap, whose data every provider here renders.
 */
let providerRequest = null;
function loadTileProvider() {
  if (!providerRequest) {
    providerRequest = fetch('/tiles/provider', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(body => (body?.provider === 'carto' || body?.provider === 'osm' ? body.provider : null))
      .catch(() => null);
  }
  return providerRequest;
}

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
  const [provider, setProvider] = useState(null);

  useEffect(() => {
    let live = true;
    loadTileProvider().then(p => { if (live) setProvider(p); });
    return () => { live = false; };
  }, []);

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

  const basemap = basemapFor({ isDark, provider });

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
        * Tiles come from this application's `/tiles` route, which proxies the
        * provider server-side — see basemap.js and server/routes/tileRoutes.js.
        *
        * A basemap drawn dark, rather than a light one turned inside out: CARTO's
        * `dark_all` when the server has a CARTO key, and the light OpenStreetMap
        * style dimmed (never inverted) when it does not. Attribution is a licence
        * condition of both providers and is rendered by the control.
        *
        * `key` changes with theme and provider because Leaflet caches the tile
        * URL on the layer instance; without it a swap would not take effect until
        * the map was destroyed.
        */}
      <TileLayer
        key={`${isDark ? 'dark' : 'light'}-${provider ?? 'pending'}`}
        attribution={basemap.attribution}
        url={basemap.url}
        className={basemap.className}
      />
      <Marker position={[latitude, longitude]} icon={customIcon}>
        {label && <Popup>{label}</Popup>}
      </Marker>
    </MapContainer>
  );
}
