# Location System V2 (Interactive Map & Geocoding)

## Architecture Overview

The location system in WeVolunteer provides an interactive, location-aware experience without relying on paid APIs (e.g., Google Maps). The implementation is 100% free and open-source, built upon **OpenStreetMap (OSM)** and **Nominatim**.

### Key Components

#### 1. Geocoding Proxy (`server/routes/geocodeRoutes.js`)
- Server-side proxy for Nominatim to search addresses.
- Implements strict rate-limiting (30 reqs/min) to respect OSM policies.
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
- **Event Modal**: Shows a full-width visual map using `react-leaflet` with a marker, and provides a one-click "Get Directions" link straight to Google Maps / Apple Maps using geographic coordinates.

## Privacy & Costs
- Zero vendor lock-in. No billing accounts required.
- Student geolocation is entirely ephemeral, requested only via an explicit banner, and stored solely in React state.
- Addresses are stored securely in our SQLite database.

## Testing & Reliability
- Backend tests cover authentication, rate-limiting, missing queries, and successful Nominatim proxy logic using `testServer.js` mock integrations.
- Frontend gracefully falls back to plain-text locations if geographic metadata is missing (e.g. for legacy events).
