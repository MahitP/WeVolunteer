/**
 * Which tiles a map requests, and what it must credit.
 *
 * Tiles come from this application's own `/tiles` route, never from a map
 * provider directly: the provider would otherwise see every student's IP address,
 * and CARTO's basemaps now need a key that must not ship in the bundle. The
 * server chooses the upstream (server/routes/tileRoutes.js) and tells the client
 * which one through `/tiles/provider`, because the attribution is a licence
 * condition and has to name what is actually being drawn.
 *
 * Kept separate from `LeafletMap.jsx` so the choice can be asserted as behaviour
 * without rendering Leaflet.
 */

const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO_CREDIT = '&copy; <a href="https://carto.com/attributions">CARTO</a>';

/**
 * @param {{ isDark: boolean, provider: 'carto' | 'osm' | null }} options
 *   `provider` is null until `/tiles/provider` answers; the map still renders,
 *   crediting OpenStreetMap, whose data every provider here draws.
 */
export function basemapFor({ isDark, provider }) {
  const theme = isDark ? 'dark' : 'light';
  const carto = provider === 'carto';
  return {
    url: `/tiles/${theme}/{z}/{x}/{y}.png`,
    attribution: carto ? `${OSM_CREDIT} ${CARTO_CREDIT}` : OSM_CREDIT,
    /**
     * OpenStreetMap publishes no dark style. Dimmed, never inverted: an inverted
     * light map is a photographic negative (see LocationDisplay.css). CARTO's
     * `dark_all` is drawn dark and needs nothing.
     */
    className: isDark && !carto ? 'map-tiles-dimmed' : '',
  };
}
