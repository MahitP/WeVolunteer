# Location System V2 (Interactive Map & Geocoding)

## Architecture Overview

The location system in WeVolunteer provides an interactive, location-aware experience without relying on paid APIs (e.g., Google Maps). The implementation is 100% free and open-source, built upon **OpenStreetMap (OSM)** and **Nominatim**.

### Key Components

#### 1. Geocoding Proxy (`server/routes/geocodeRoutes.js`)
- Server-side proxy for Nominatim to search addresses.
- Two limits, doing two different jobs: a per-IP limiter (30 reqs/min) bounds
  what one client may ask for, and an application-wide reservation bucket
  (`reserveUpstreamSlot`) holds the *upstream* call to Nominatim's published
  1 req/s. Only the first existed until 2026-08-11 — see TD-19.
- In-memory LRU cache with 1-hour TTL to reduce redundant upstream requests and improve perceived latency.
- Protected by `authenticateToken` and role checks (Organizers & Admins only).
- When a user's location is known, applies `viewbox` parameters to bias search results within ~35 miles of the user.

#### 2. Organizer Experience (`LocationPicker.jsx`)
- Replaces the simple text field in `CreateEvent.jsx` with an interactive autocomplete component.
- Emits structured data: `address`, `latitude`, `longitude`, alongside the raw `location` name.
- Stores data natively in the `events` SQLite table.

#### 3. Student Experience (`LocationDisplay.jsx` & `LocationContext.jsx`)
- **LocationContext**: Manages browser Geolocation API state at the application root (`main.jsx`). Never stores user coordinates persistently (privacy-first).
- **Distance Calculation**: The Haversine formula (`utils/helpers.js`) calculates exact miles between the student and events.
- **Browse Events**: Events can be sorted by "Nearest to me", and include a "Distance from me" filter (e.g., < 5 miles, < 10 miles).
- **Event Modal**: The location is a link, the street address sits beneath it,
  and a "Get directions" pill and forecast sit below. The map is **click to
  reveal** ("Show map"), because tiles are fetched by the student's own browser
  and the tile provider is the only third party that would otherwise see a
  student's IP address on page load. See R-18.
- **Directions** go wherever the operating system prefers: a `geo:` URI on
  Android (which raises the system app chooser), `maps.apple.com` on Apple
  platforms, and Google Maps everywhere else. See `src/utils/mapsLink.js`.

## Privacy & Costs
- Zero vendor lock-in. No billing accounts required.
- Student geolocation is entirely ephemeral, requested only via an explicit
  banner (`LocationPrompt`, built 2026-08-11 — the context had exposed the
  hooks for it since it was written, with no consumer), and stored solely in
  React state.
- That banner's markup and styling moved into `components/notifications/`
  (`NoticeBanner` + `AppNotices`) when the legal change notice needed the same
  treatment. Nothing about its appearance or behaviour changed; the notice slot
  now decides which of the two shows, and the location offer is the lower
  priority of the two — suppressed while a legal change is pending, and back the
  moment that is dismissed.
- The exact position never leaves the device. Distance filtering sends a centre
  coarsened to two decimal places (~1.1km); the distance a volunteer READS is
  computed in the browser at full precision.
- Addresses are stored securely in our SQLite database.

## Testing & Reliability
- Backend tests cover authentication, rate-limiting, missing queries, and successful Nominatim proxy logic using `testServer.js` mock integrations.
- Frontend gracefully falls back to plain-text locations if geographic metadata is missing (e.g. for legacy events).
