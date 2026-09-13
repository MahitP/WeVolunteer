import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { basemapFor } from './basemap';

/**
 * The basemap: where tiles come from, what they credit, and how dark mode draws.
 *
 * ── History this file guards ──
 *
 * 1. Dark mode once laid `filter: invert(100%) hue-rotate(180deg)` over CARTO
 *    Voyager, a light pastel map — producing a photographic negative. Never again.
 * 2. The browser fetched tiles from CARTO directly, which showed every student's
 *    IP address to a third party (compliance register R-18), and CARTO then began
 *    requiring a key, printing "API KEY REQUIRED" across every tile. Tiles now
 *    come from this application's `/tiles` proxy, which holds any key server-side.
 */

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const MAP = stripComments(read('src/components/location/LeafletMap.jsx'));
const MAP_CSS = stripComments(read('src/components/location/LocationDisplay.css'));

describe('basemapFor', () => {
  it('always requests tiles from this application, never a provider host', () => {
    for (const isDark of [false, true]) {
      for (const provider of ['carto', 'osm', null]) {
        const { url } = basemapFor({ isDark, provider });
        expect(url.startsWith('/tiles/')).toBe(true);
        expect(url).not.toMatch(/cartocdn|openstreetmap\.org|https?:/);
      }
    }
  });

  it('asks for the dark style in dark mode and the light one otherwise', () => {
    expect(basemapFor({ isDark: true, provider: 'carto' }).url).toBe('/tiles/dark/{z}/{x}/{y}.png');
    expect(basemapFor({ isDark: false, provider: 'carto' }).url).toBe('/tiles/light/{z}/{x}/{y}.png');
  });

  it('credits CARTO only when CARTO is drawing, and OpenStreetMap always', () => {
    const carto = basemapFor({ isDark: false, provider: 'carto' }).attribution;
    const osm = basemapFor({ isDark: false, provider: 'osm' }).attribution;
    const pending = basemapFor({ isDark: false, provider: null }).attribution;
    expect(carto).toMatch(/openstreetmap\.org\/copyright/);
    expect(carto).toMatch(/carto\.com\/attributions/);
    expect(osm).toMatch(/openstreetmap\.org\/copyright/);
    expect(osm).not.toMatch(/carto/i);
    expect(pending).toMatch(/openstreetmap\.org\/copyright/);
  });

  it('dims OpenStreetMap in dark mode, and leaves a purpose-built dark map alone', () => {
    expect(basemapFor({ isDark: true, provider: 'osm' }).className).toBe('map-tiles-dimmed');
    expect(basemapFor({ isDark: true, provider: 'carto' }).className).toBe('');
    expect(basemapFor({ isDark: false, provider: 'osm' }).className).toBe('');
  });
});

describe('the map component and its stylesheet', () => {
  it('draws the tiles basemapFor chooses', () => {
    expect(MAP).toMatch(/basemapFor\(\{ isDark, provider \}\)/);
    expect(MAP).toMatch(/url=\{basemap\.url\}/);
    expect(MAP).toMatch(/attribution=\{basemap\.attribution\}/);
  });

  it('remounts the layer when the theme or the provider changes', () => {
    /* Leaflet caches the URL and attribution on the layer instance. */
    expect(MAP).toMatch(/key=\{`\$\{isDark \? 'dark' : 'light'\}-\$\{provider \?\? 'pending'\}`\}/);
  });

  it('never inverts the tiles', () => {
    expect(MAP_CSS).not.toMatch(/filter:\s*[^;]*invert/);
  });

  it('does not hide the attribution control in CSS', () => {
    const hidden = /\.leaflet-control-attribution[^{]*\{[^}]*display:\s*none/;
    expect(MAP_CSS).not.toMatch(hidden);
  });
});
