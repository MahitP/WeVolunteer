import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  fetchVolunteerStats: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchApplications: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  verifyCertificate: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { ask } = await import('./assistant.js');

/**
 * What precision Welly's "near me" sends to the server.
 *
 * ── The promise this is measured against ──
 *
 * It is published, not internal. `docs/legal/policies/01-privacy-policy.md`,
 * "Your device location": coordinates "do reach our servers, **blurred**, in
 * two cases: rounded to about a kilometre to sort a list by distance, and
 * rounded to about 110 metres to ask a route planner for a driving time."
 *
 * The codebase states the same invariant in its own words —
 * `components/EventModal.jsx`: "the volunteer's exact position never leaves the
 * device. The browse filter sends a coordinate coarsened to about a kilometre."
 * And `utils/api.js` on `fetchRecommendations`: "the same 2-decimal-place
 * centre the browse filter sends — enough for 'is this nearby', not enough to
 * place somebody."
 *
 * ── What was wrong ──
 *
 * `views/BrowseEvents.jsx` applies `coarsen()` — `Math.round(deg * 100) / 100`,
 * about 1.1 km — on all three of its paths. Welly reaches the SAME endpoint and
 * applied nothing: `WellyView` built `{lat, lng}` straight from
 * `LocationContext`, which stores `position.coords` verbatim, and
 * `assistant.js` copied them into the tool arguments. So the one surface whose
 * audience is told "it stays on your device" was the one sending a
 * full-precision GPS fix.
 *
 * The exact position is still used on the device — `distance_to_event` computes
 * the miles a reader sees from it, for the same reason EventModal does. Only
 * what crosses to the server is blurred.
 */

const STUDENT = { id: 'u1', role: 'student', name: 'Leo' };

/* Deliberately more precise than any policy allows, and not already round. */
const EXACT = { lat: 34.42081234, lng: -119.69823456 };

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchEventsFiltered.mockResolvedValue({ events: [], pagination: { total: 0 } });
});

const sentArgs = () => apiMock.fetchEventsFiltered.mock.calls.at(-1)?.[0] ?? {};

describe('a "near me" search', () => {
  it('sends coordinates at all, or this file is measuring nothing', async () => {
    await ask('volunteering opportunities near me', { runtime: null, position: EXACT, user: STUDENT });

    expect(apiMock.fetchEventsFiltered).toHaveBeenCalled();
    expect(typeof sentArgs().lat).toBe('number');
    expect(typeof sentArgs().lng).toBe('number');
  });

  it('blurs them to about a kilometre, as the Privacy Policy says it does', async () => {
    await ask('volunteering opportunities near me', { runtime: null, position: EXACT, user: STUDENT });

    const { lat, lng } = sentArgs();
    expect(lat, 'Welly sent a finer latitude than the policy promises').toBe(34.42);
    expect(lng, 'Welly sent a finer longitude than the policy promises').toBe(-119.7);
  });

  it('does not send the exact device position', async () => {
    /* The failure stated as itself: a full-precision fix places somebody at
       their front door, and the audience here is minors. */
    await ask('volunteering opportunities near me', { runtime: null, position: EXACT, user: STUDENT });

    expect(sentArgs().lat).not.toBe(EXACT.lat);
    expect(sentArgs().lng).not.toBe(EXACT.lng);
  });

  it('matches what the browse filter sends for the same position', async () => {
    /* One endpoint, one precision. `coarsen` in BrowseEvents is the definition
       both are measured against; drift between them is the defect. */
    const coarsen = (deg) => Math.round(deg * 100) / 100;
    await ask('volunteering opportunities near me', { runtime: null, position: EXACT, user: STUDENT });

    expect(sentArgs().lat).toBe(coarsen(EXACT.lat));
    expect(sentArgs().lng).toBe(coarsen(EXACT.lng));
  });

  it('sends nothing at all when there is no position', async () => {
    await ask('volunteering opportunities near me', { runtime: null, position: null, user: STUDENT });

    expect(sentArgs().lat).toBeUndefined();
    expect(sentArgs().lng).toBeUndefined();
  });
});
