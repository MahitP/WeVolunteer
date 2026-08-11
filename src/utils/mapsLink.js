/**
 * Where "open directions" should point, given the device asking.
 *
 * ── Why this is not just a Google Maps URL ──
 *
 * Everywhere in the app used to build
 * `https://www.google.com/maps/dir/?api=1&destination=…` and rely on a comment
 * claiming the OS would intercept it and offer a choice. On Android it does not
 * offer a choice — it opens Google Maps, because that URL belongs to Google
 * Maps. On iOS it opens Google Maps if installed and a web page if not. A
 * volunteer who navigates with Waze or with Apple Maps was overruled either way.
 *
 * There is no single URL that means "open whatever map application this person
 * prefers". So this picks the closest thing each platform actually has:
 *
 *   Android  `geo:` — the real thing. Android resolves a geo: URI through the
 *            system app chooser, so Waze, Organic Maps and Google Maps all get
 *            offered. The cost is that geo: drops a pin rather than starting a
 *            route, so the volunteer taps "Directions" once inside the app they
 *            chose. That is the trade this makes deliberately: one extra tap in
 *            exchange for not overruling their choice of app.
 *
 *   Apple    `maps.apple.com` — iOS and macOS expose no chooser to the web at
 *            all, so the OS default IS Apple Maps, and this is how you reach it.
 *            `dirflg=d` starts a driving route rather than dropping a pin. On a
 *            non-Apple device the same URL degrades to a working web page, so a
 *            wrong guess costs nothing.
 *
 *   Anything Google Maps directions over https, which is what shipped before and
 *   else     works in every desktop browser.
 *
 * ── Why the detection is deliberately crude ──
 *
 * Two boolean questions — "is this Apple?" and "is this Android?" — rather than
 * parsing a version out of a user-agent string. Version parsing is what breaks
 * silently the year an OS changes its format. Every branch here degrades to a
 * working link, so the cost of guessing wrong is one unexpected map app rather
 * than a dead button.
 */

/**
 * @param {Navigator} [nav] injectable for tests; there is no other reason
 * @returns {'apple'|'android'|'other'}
 */
export function detectMapsPlatform(nav) {
  const source = nav ?? (typeof navigator === 'undefined' ? null : navigator);
  if (!source) return 'other';

  /* userAgentData is the non-deprecated route and reports a clean platform
     name; navigator.platform is the fallback for the browsers without it. */
  const platform = String(source.userAgentData?.platform || source.platform || '');
  const ua = String(source.userAgent || '');

  if (/android/i.test(platform) || /android/i.test(ua)) return 'android';

  /* iPadOS reports itself as MacIntel with a touch screen, which is why
     maxTouchPoints appears here — but both branches land on Apple Maps anyway,
     so it only matters for anyone reading this expecting iPad to be missing. */
  if (/mac|iphone|ipad|ipod/i.test(platform) || /iphone|ipad|ipod/i.test(ua)) return 'apple';

  return 'other';
}

/**
 * The destination string, in the order of how unambiguous each option is.
 *
 * Coordinates first because `validateEventPayload` guarantees they travel as a
 * validated pair, so they cannot point at the wrong town. A free-text address
 * can and does — "Main Street" resolves in about forty states. The bare place
 * name is last because it is the least likely to geocode, but it is still
 * better than a button that does nothing.
 */
function destinationFor({ latitude, longitude, address, location }) {
  if (latitude != null && longitude != null) return { value: `${latitude},${longitude}`, isCoords: true };
  if (address) return { value: address, isCoords: false };
  if (location) return { value: location, isCoords: false };
  return null;
}

/**
 * A directions URL for this destination on this platform.
 *
 * @returns {string|null} null when there is nothing to navigate to, so callers
 *   render plain text rather than a link that goes nowhere.
 */
export function mapsDirectionsUrl(target, platform = detectMapsPlatform()) {
  const dest = destinationFor(target || {});
  if (!dest) return null;

  const label = target.location || target.address || 'Event location';

  if (platform === 'android') {
    /* `0,0` is the documented placeholder for "the point is in q, not here".
       The parenthesised label is what the chooser and the map pin display; it
       is encoded because an apostrophe in a school name is otherwise a
       malformed URI. */
    const q = dest.isCoords
      ? `${dest.value}(${encodeURIComponent(label)})`
      : encodeURIComponent(dest.value);
    return `geo:0,0?q=${q}`;
  }

  if (platform === 'apple') {
    return `https://maps.apple.com/?daddr=${encodeURIComponent(dest.value)}&dirflg=d`;
  }

  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest.value)}`;
}

/**
 * Whether a destination exists at all.
 *
 * Callers use this to decide between a link and plain text without building a
 * URL they may not use.
 */
export function hasMapsDestination(target) {
  return destinationFor(target || {}) !== null;
}
