/**
 * The precision a coordinate is allowed to leave the device at.
 *
 * ── This is a published promise, not a preference ──
 *
 * `docs/legal/policies/01-privacy-policy.md`, "Your device location":
 * coordinates "do reach our servers, **blurred**, in two cases: rounded to
 * about a kilometre to sort a list by distance, and rounded to about 110 metres
 * to ask a route planner for a driving time."
 *
 * Two decimal places of latitude is ~1.1 km, which is the first of those. It is
 * enough to answer "is this nearby" and not enough to place somebody.
 *
 * ── Why it is shared rather than defined where it is used ──
 *
 * It was a `const` inside `views/BrowseEvents.jsx`, and Welly reached the same
 * endpoint without it — `WellyView` builds `{lat, lng}` straight from
 * `LocationContext`, which stores `position.coords` verbatim, and the assistant
 * copied them into the tool arguments. So the one surface that offers location
 * with the words "It stays on your device" was the one sending a full-precision
 * GPS fix to `GET /api/events`.
 *
 * A promise made in a published document and kept in one component is a promise
 * the next caller breaks by default. One definition, imported by both.
 *
 * ── What this must NOT be applied to ──
 *
 * The exact position stays on the device and is still used there. `EventModal`
 * computes the miles a reader actually sees from it, and `assistant.js` does
 * the same for `distance_to_event`, both deliberately: "this one is exact
 * because it is computed where the exact position already is". Coarsen at the
 * boundary where a value crosses to the server, not at the source.
 */

/** One coordinate, rounded to ~1.1 km. */
export const coarsen = (deg) => Math.round(deg * 100) / 100;

/**
 * A `{lat, lng}` pair at the same precision, or `null`.
 *
 * Returns null for a missing or non-numeric pair rather than emitting `NaN`:
 * `Math.round(undefined * 100)` is `NaN`, and `lat=NaN` in a query string is a
 * filter the server cannot refuse meaningfully.
 */
export function coarsePosition(position) {
  const lat = Number(position?.lat ?? position?.latitude);
  const lng = Number(position?.lng ?? position?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat: coarsen(lat), lng: coarsen(lng) };
}
