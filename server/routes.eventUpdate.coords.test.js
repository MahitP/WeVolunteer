import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `PUT /api/events/:id` must not throw away geo data it was never sent.
 *
 * ── The bug this pins ──
 *
 * The UPDATE wrote `address`, `latitude` and `longitude` unconditionally from
 * the request body. `OrganizerDashboard`'s quick-edit form sends title,
 * description, location and category and nothing else — so every quick save
 * nulled the coordinates the organizer had picked on the map, and with them
 * that event's distance filtering, its directions link and its forecast.
 *
 * The symptom was not an error. The map simply stopped appearing, through a
 * form that never mentions maps, which is why it survived so long: the seeds
 * carried no coordinates either, so the whole feature looked unbuilt rather
 * than broken.
 *
 * An absent field means "not editing it". An explicit `null` still clears, so
 * "remove the pin" stays expressible — that distinction is the point, and the
 * two tests below are the two halves of it.
 */

const ORGANIZER = 'jordan.whitfield@example.org';

const PIN = {
  address: '100 Reichler Park Drive, Example Valley, NJ 08824',
  latitude: 40.386,
  longitude: -74.556,
};

describe('event update preserves coordinates it was not sent', () => {
  let srv;
  let organizer;

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login(ORGANIZER);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const payload = (over = {}) => ({
    title: `Pinned event ${Math.random().toString(36).slice(2, 8)}`,
    description: 'A description long enough to pass validation for this event.',
    category: 'School',
    location: 'Reichler Park',
    applicationDeadline: '2027-01-01',
    slots: [{
      name: 'Morning',
      description: 'The morning shift',
      startDatetime: '2027-02-01T09:00:00.000Z',
      endDatetime: '2027-02-01T12:00:00.000Z',
      maxSpots: 5,
    }],
    ...over,
  });

  /** An event that already carries a pin, plus the payload that created it. */
  const createPinned = async () => {
    const body = payload(PIN);
    const res = await srv.call('POST', '/api/events', body, organizer);
    expect(res.status).toBe(201);
    const id = res.body.eventId ?? res.body.id ?? res.body.event?.id;
    expect(id).toBeTruthy();
    return { id, body };
  };

  const readBack = async (id) => {
    const res = await srv.call('GET', `/api/events/${id}`, undefined, organizer);
    expect(res.status).toBe(200);
    return res.body.event;
  };

  /** What the quick-edit form actually sends: no geo fields at all. */
  const quickEdit = (body, over = {}) => {
    const next = { ...body, ...over };
    delete next.address;
    delete next.latitude;
    delete next.longitude;
    return next;
  };

  it('stores the pin on creation', async () => {
    const { id } = await createPinned();
    const event = await readBack(id);

    expect(event.address).toBe(PIN.address);
    expect(event.latitude).toBeCloseTo(PIN.latitude, 6);
    expect(event.longitude).toBeCloseTo(PIN.longitude, 6);
  });

  it('keeps the pin when an edit omits the geo fields entirely', async () => {
    const { id, body } = await createPinned();

    const res = await srv.call(
      'PUT',
      `/api/events/${id}`,
      quickEdit(body, { title: 'Renamed by the quick-edit form' }),
      organizer,
    );
    expect(res.status).toBe(200);

    const event = await readBack(id);
    expect(event.title).toBe('Renamed by the quick-edit form');
    /* The edit succeeded AND the pin survived it. Asserting the title too
       matters: a test that only checked the coordinates would pass against an
       endpoint that had silently rejected the whole request. */
    expect(event.address).toBe(PIN.address);
    expect(event.latitude).toBeCloseTo(PIN.latitude, 6);
    expect(event.longitude).toBeCloseTo(PIN.longitude, 6);
  });

  it('still clears the pin when the geo fields are sent as null', async () => {
    const { id, body } = await createPinned();

    const res = await srv.call(
      'PUT',
      `/api/events/${id}`,
      { ...body, address: null, latitude: null, longitude: null },
      organizer,
    );
    expect(res.status).toBe(200);

    const event = await readBack(id);
    expect(event.address).toBeNull();
    expect(event.latitude).toBeNull();
    expect(event.longitude).toBeNull();
  });

  it('replaces the pin when new coordinates are sent', async () => {
    const { id, body } = await createPinned();

    const res = await srv.call(
      'PUT',
      `/api/events/${id}`,
      { ...body, address: '8 Library Road, Example Valley, NJ 08824', latitude: 40.3744, longitude: -74.5205 },
      organizer,
    );
    expect(res.status).toBe(200);

    const event = await readBack(id);
    expect(event.address).toBe('8 Library Road, Example Valley, NJ 08824');
    expect(event.latitude).toBeCloseTo(40.3744, 6);
    expect(event.longitude).toBeCloseTo(-74.5205, 6);
  });

  it('leaves an unpinned event unpinned rather than inventing one', async () => {
    const res = await srv.call('POST', '/api/events', payload(), organizer);
    expect(res.status).toBe(201);
    const id = res.body.eventId ?? res.body.id ?? res.body.event?.id;

    const put = await srv.call(
      'PUT',
      `/api/events/${id}`,
      quickEdit(payload(), { title: 'Still unpinned' }),
      organizer,
    );
    expect(put.status).toBe(200);

    const event = await readBack(id);
    expect(event.latitude).toBeNull();
    expect(event.longitude).toBeNull();
  });
});
