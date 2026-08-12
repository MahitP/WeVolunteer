import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The basemap is drawn dark, never a light one turned inside out.
 *
 * ── The bug ──
 *
 * Both the organizer's event-creation picker and the student's event map render
 * the same `LeafletMap`, which served CARTO **Voyager** at every theme and, in
 * dark mode, laid `filter: invert(100%) hue-rotate(180deg)` over it. Voyager is
 * a light pastel cartography. Inverting it does not make a dark map — it makes a
 * photographic negative: parks magenta, water the colour of sand, and every
 * white label halo becomes a black smear around black text.
 *
 * CARTO publishes `dark_all` for this. These pin the swap so nobody
 * reintroduces the filter, and pin the attribution, which is a licence
 * condition of both OpenStreetMap and CARTO rather than a design choice.
 */

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const MAP = read('src/components/location/LeafletMap.jsx');
/* Comments stripped: the rule this file forbids is quoted verbatim in the
   comment that replaced it, and a scanner that cannot tell prose from a
   declaration would fail on its own gravestone. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const MAP_CSS = stripComments(read('src/components/location/LocationDisplay.css'));

describe('map tiles', () => {
  it('requests a purpose-built dark basemap in dark mode', () => {
    expect(MAP).toMatch(/basemaps\.cartocdn\.com\/dark_all\//);
  });

  it('keeps Voyager for light mode', () => {
    expect(MAP).toMatch(/basemaps\.cartocdn\.com\/rastertiles\/voyager\//);
  });

  it('chooses between them on the theme', () => {
    /* Both URLs present but not switched on would ship one of them dead. */
    expect(MAP).toMatch(/isDark\s*\n?\s*\?\s*'https:\/\/\{s\}\.basemaps\.cartocdn\.com\/dark_all/);
  });

  it('remounts the layer when the theme changes', () => {
    /* Leaflet caches the tile URL on the layer instance; without a changing
       `key` the swap does not take effect until the map is destroyed. */
    expect(MAP).toMatch(/key=\{isDark \? 'dark' : 'light'\}/);
  });

  it('never inverts the tiles again', () => {
    expect(MAP_CSS).not.toMatch(/\.map-dark-mode[^{]*\{[^}]*filter:\s*invert/);
    expect(MAP).not.toMatch(/map-dark-mode/);
  });

  it('keeps the OpenStreetMap and CARTO attribution', () => {
    /* A licence condition of both providers, not a design decision. */
    expect(MAP).toMatch(/openstreetmap\.org\/copyright/);
    expect(MAP).toMatch(/carto\.com\/attributions/);
  });

  it('does not hide the attribution control in CSS', () => {
    const hidden = /\.leaflet-control-attribution[^{]*\{[^}]*display:\s*none/;
    expect(MAP_CSS).not.toMatch(hidden);
  });
});
