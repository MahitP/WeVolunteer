import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  fetchVolunteerStats: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchApplications: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  fetchEvent: vi.fn(),
  verifyCertificate: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { routeIntent } = await import('./router.js');
const { ask } = await import('./assistant.js');

/**
 * "How far is it?"
 *
 * ── The report ──
 *
 *     Welly:   I found 1 opportunity.  [Softball Tournament Snack Shack]
 *     Student: How far is it?
 *     Welly:   I can't help with that one. I can look up opportunities, your
 *              volunteer hours, your certificates, …
 *
 * A list of abilities that does not include the thing just asked for, about
 * the thing on screen, one turn after showing it.
 *
 * ── Why it needs no lookup ──
 *
 * The opportunity card carries the event's coordinates and the app has the
 * reader's, so the answer is arithmetic over the transcript. That also means it
 * works in the order people actually do things: search without location, grant
 * it from the offer under the answer, then ask — no second search needed,
 * because the places are still on screen.
 */

const STUDENT = { id: 'u1', role: 'student', name: 'Leo Chen' };

/* Santa Barbara-ish. Roughly 3.4 miles apart, which is far enough that a
   rounding change would not silently make these pass. */
const HERE = { lat: 34.4208, lng: -119.6982 };
const NEAR = { latitude: 34.4285, lng: null, longitude: -119.7150 };
const FAR = { latitude: 34.4700, longitude: -119.7500 };

const opportunitiesTurn = items => ([
  { role: 'user', text: 'find volunteering opportunities' },
  {
    role: 'assistant',
    text: `I found ${items.length} opportunities.`,
    card: { kind: 'opportunities', data: { total: items.length, items } },
  },
]);

const SNACK_SHACK = {
  id: 'e1', title: 'Softball Tournament Snack Shack', location: 'Reichler Park',
  latitude: NEAR.latitude, longitude: NEAR.longitude,
};
const BEACH = {
  id: 'e2', title: 'Beach Cleanup', location: 'Arroyo Burro',
  latitude: FAR.latitude, longitude: FAR.longitude,
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the question reaches a rule at all', () => {
  for (const text of [
    'How far is it?', 'how far away is that', 'is it far', 'is it close',
    'how close is it', 'distance to it', 'how long to get there', 'how far are they',
  ]) {
    it(`routes "${text}"`, () => {
      expect(routeIntent(text).intent).toBe('distance_to_event');
    });
  }

  it('leaves questions that are not about places alone', () => {
    /* "How far" is also how somebody asks about progress. Those belong to the
       hours and milestone answers, and a greedy rule here would take them. */
    for (const text of [
      'how many hours do I have',
      'how far am I from my goal',
      'how far through the term am I',
      'how far along are my hours',
    ]) {
      expect(routeIntent(text).intent, text).not.toBe('distance_to_event');
    }
  });
});

describe('answering it', () => {
  it('measures the event Welly just showed', async () => {
    const res = await ask('How far is it?', {
      runtime: null, position: HERE, user: STUDENT,
      history: opportunitiesTurn([SNACK_SHACK]),
    });

    expect(res.answer).toMatch(/^Softball Tournament Snack Shack is about [\d.]+ miles? away\.$/);
    expect(res.card.kind).toBe('distances');
    expect(res.card.data.items[0].title).toBe('Softball Tournament Snack Shack');
    /* Not a lookup. Nothing was fetched to answer this. */
    expect(apiMock.fetchEventsFiltered).not.toHaveBeenCalled();
    expect(apiMock.fetchEvent).not.toHaveBeenCalled();
  });

  it('names the closest when several were shown, and orders the rest', async () => {
    const res = await ask('how far are they', {
      runtime: null, position: HERE, user: STUDENT,
      history: opportunitiesTurn([BEACH, SNACK_SHACK]),
    });

    expect(res.answer).toMatch(/^The closest is Softball Tournament Snack Shack/);
    const miles = res.card.data.items.map(d => d.miles);
    expect(miles).toEqual([...miles].sort((a, b) => a - b));
    expect(res.card.data.items[0].title).toBe('Softball Tournament Snack Shack');
  });

  it('agrees with the sentence about which one is nearest', async () => {
    /* The sentence and the first row are the same answer written twice. They
       are derived from one sorted list so they cannot drift. */
    const res = await ask('How far is it?', {
      runtime: null, position: HERE, user: STUDENT,
      history: opportunitiesTurn([BEACH, SNACK_SHACK]),
    });
    expect(res.answer).toContain(res.card.data.items[0].title);
    expect(res.answer).toContain(String(res.card.data.items[0].miles));
  });

  it('works for a single event opened by name', async () => {
    const res = await ask('is it far', {
      runtime: null, position: HERE, user: STUDENT,
      history: [
        { role: 'user', text: 'tell me about the snack shack' },
        { role: 'assistant', text: 'Softball Tournament Snack Shack', card: { kind: 'event_details', data: SNACK_SHACK } },
      ],
    });
    expect(res.answer).toMatch(/Softball Tournament Snack Shack is about/);
  });

  it('reads the most recent card, not the first one', async () => {
    const res = await ask('How far is it?', {
      runtime: null, position: HERE, user: STUDENT,
      history: [...opportunitiesTurn([BEACH]), ...opportunitiesTurn([SNACK_SHACK])],
    });
    expect(res.answer).toMatch(/^Softball Tournament Snack Shack/);
    expect(res.card.data.total).toBe(1);
  });
});

describe('the three ways it has no answer are three different sentences', () => {
  /**
   * Each needs something different from the reader — grant location, ask about
   * something, or accept that this event has no address on it. One "I can't
   * work that out" for all three is the failure this file exists to undo.
   */
  it('offers the permission button when there is no location', async () => {
    const res = await ask('How far is it?', {
      runtime: null, position: null, user: STUDENT,
      history: opportunitiesTurn([SNACK_SHACK]),
    });

    expect(res.needsLocation).toBe(true);
    expect(res.answer).toMatch(/don’t have your location/);
    /* And never asks for one to be typed. */
    expect(res.answer).not.toMatch(/address|zip|what city/i);
  });

  it('says which part is missing when nothing has been shown yet', async () => {
    const res = await ask('How far is it?', {
      runtime: null, position: HERE, user: STUDENT, history: [],
    });

    expect(res.answer).toMatch(/not sure which place you mean/i);
    expect(res.card).toBeNull();
    /* Marked as the interface speaking, so the model does not learn to
       reproduce it as an answer. See sanitizeHistory. */
    expect(res.systemNotice).toBe(true);
  });

  it('does not measure to an older event when the newest has no coordinates', async () => {
    /**
     * The subtle one. An event created without a geocoded address has no
     * coordinates, and "it" still means that event — so looking further back
     * for something measurable would answer confidently about the wrong place.
     */
    const noCoords = { id: 'e3', title: 'Library Help', location: 'Main Library' };
    const res = await ask('How far is it?', {
      runtime: null, position: HERE, user: STUDENT,
      history: [...opportunitiesTurn([SNACK_SHACK]), ...opportunitiesTurn([noCoords])],
    });

    expect(res.answer).toMatch(/not sure which place you mean/i);
    expect(res.answer).not.toMatch(/Softball/);
  });
});
