import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateEventPayload } from './validation.js';
import { startTestServer } from './testServer.js';

// --- Pure unit tests: no server, no DB. ---------------------------------

/** A payload that passes every rule; tests override one field at a time. */
function validPayload(overrides = {}) {
  const start = new Date(Date.now() + 10 * 864e5).toISOString();
  const end = new Date(Date.now() + 10 * 864e5 + 3 * 3600e3).toISOString();
  const deadline = new Date(Date.now() + 5 * 864e5).toISOString();
  return {
    title: 'Valid Event',
    description: 'A perfectly ordinary event.',
    location: 'Community Center',
    instructions: 'Bring gloves.',
    applicationDeadline: deadline,
    slots: [
      { name: 'Shift 1', description: 'Main shift', startDatetime: start, endDatetime: end, maxSpots: 5 }
    ],
    ...overrides
  };
}

describe('validateEventPayload: valid input', () => {
  it('passes a fully valid payload', () => {
    expect(validateEventPayload(validPayload())).toEqual({ ok: true });
  });
});

describe('validateEventPayload: deadline rules', () => {
  it('rejects a deadline in the past', () => {
    const result = validateEventPayload(validPayload({
      applicationDeadline: new Date(Date.now() - 864e5).toISOString()
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/deadline/i);
  });

  it('rejects an unparseable deadline', () => {
    const result = validateEventPayload(validPayload({ applicationDeadline: 'not-a-date' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/deadline/i);
  });

  it('rejects a deadline after the first shift starts', () => {
    const start = new Date(Date.now() + 5 * 864e5).toISOString();
    const end = new Date(Date.now() + 5 * 864e5 + 3 * 3600e3).toISOString();
    const result = validateEventPayload(validPayload({
      applicationDeadline: new Date(Date.now() + 6 * 864e5).toISOString(),
      slots: [{ name: 'Shift 1', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 5 }]
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/first shift/i);
  });

  it('allows a deadline exactly at the first shift start', () => {
    const start = new Date(Date.now() + 5 * 864e5).toISOString();
    const end = new Date(Date.now() + 5 * 864e5 + 3 * 3600e3).toISOString();
    const result = validateEventPayload(validPayload({
      applicationDeadline: start,
      slots: [{ name: 'Shift 1', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 5 }]
    }));
    expect(result.ok).toBe(true);
  });
});

describe('validateEventPayload: slot time rules', () => {
  it('rejects a slot whose end is before its start', () => {
    const start = new Date(Date.now() + 10 * 864e5).toISOString();
    const end = new Date(Date.now() + 9 * 864e5).toISOString();
    const result = validateEventPayload(validPayload({
      slots: [{ name: 'Shift 1', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 5 }]
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/end after it starts/i);
  });

  it('rejects a slot whose end equals its start', () => {
    const start = new Date(Date.now() + 10 * 864e5).toISOString();
    const result = validateEventPayload(validPayload({
      slots: [{ name: 'Shift 1', description: 'd', startDatetime: start, endDatetime: start, maxSpots: 5 }]
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/end after it starts/i);
  });

  it('rejects an unparseable slot date', () => {
    const result = validateEventPayload(validPayload({
      slots: [{ name: 'Shift 1', description: 'd', startDatetime: 'nope', endDatetime: 'also-nope', maxSpots: 5 }]
    }));
    expect(result.ok).toBe(false);
  });

  it('rejects an empty slots array', () => {
    const result = validateEventPayload(validPayload({ slots: [] }));
    expect(result.ok).toBe(false);
  });
});

describe('validateEventPayload: maxSpots rules', () => {
  const withMaxSpots = (maxSpots) => {
    const start = new Date(Date.now() + 10 * 864e5).toISOString();
    const end = new Date(Date.now() + 10 * 864e5 + 3 * 3600e3).toISOString();
    return validPayload({
      slots: [{ name: 'Shift 1', description: 'd', startDatetime: start, endDatetime: end, maxSpots }]
    });
  };

  it('rejects maxSpots of 0', () => {
    const result = validateEventPayload(withMaxSpots(0));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/between 1 and 100/i);
  });

  it('rejects a negative maxSpots', () => {
    const result = validateEventPayload(withMaxSpots(-5));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/between 1 and 100/i);
  });

  it('rejects maxSpots over 100', () => {
    const result = validateEventPayload(withMaxSpots(101));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/between 1 and 100/i);
  });

  it('rejects a non-integer maxSpots', () => {
    const result = validateEventPayload(withMaxSpots(1.5));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/between 1 and 100/i);
  });

  it('allows the boundary values 1 and 100', () => {
    expect(validateEventPayload(withMaxSpots(1)).ok).toBe(true);
    expect(validateEventPayload(withMaxSpots(100)).ok).toBe(true);
  });
});

describe('validateEventPayload: length caps', () => {
  it('rejects an over-long title', () => {
    const result = validateEventPayload(validPayload({ title: 'x'.repeat(201) }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/title/i);
  });

  it('rejects an over-long description', () => {
    const result = validateEventPayload(validPayload({ description: 'x'.repeat(5001) }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/description/i);
  });

  it('rejects an over-long location', () => {
    const result = validateEventPayload(validPayload({ location: 'x'.repeat(301) }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/location/i);
  });

  it('rejects over-long instructions', () => {
    const result = validateEventPayload(validPayload({ instructions: 'x'.repeat(5001) }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/instructions/i);
  });

  it('allows empty/undefined instructions', () => {
    expect(validateEventPayload(validPayload({ instructions: '' })).ok).toBe(true);
    expect(validateEventPayload(validPayload({ instructions: undefined })).ok).toBe(true);
  });

  it('rejects an over-long slot name', () => {
    const start = new Date(Date.now() + 10 * 864e5).toISOString();
    const end = new Date(Date.now() + 10 * 864e5 + 3 * 3600e3).toISOString();
    const result = validateEventPayload(validPayload({
      slots: [{ name: 'x'.repeat(121), description: 'd', startDatetime: start, endDatetime: end, maxSpots: 5 }]
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/shift name/i);
  });

  it('rejects an over-long slot description', () => {
    const start = new Date(Date.now() + 10 * 864e5).toISOString();
    const end = new Date(Date.now() + 10 * 864e5 + 3 * 3600e3).toISOString();
    const result = validateEventPayload(validPayload({
      slots: [{ name: 'Shift 1', description: 'x'.repeat(1001), startDatetime: start, endDatetime: end, maxSpots: 5 }]
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/shift description/i);
  });
});

// --- Route-level tests: exercise the wiring through the real HTTP API. --
// Exactly one startTestServer() call in this file, per the task brief.

describe('POST/PUT /api/events: server-side validation wiring', () => {
  let srv, orgToken;

  beforeAll(async () => {
    srv = await startTestServer();
    orgToken = await srv.login('jkatzenback@vikings.org');
  });
  afterAll(async () => { await srv.close(); });

  const futureStart = new Date(Date.now() + 10 * 864e5).toISOString();
  const futureEnd = new Date(Date.now() + 10 * 864e5 + 3 * 3600e3).toISOString();
  const futureDeadline = new Date(Date.now() + 5 * 864e5).toISOString();

  const basePayload = (overrides = {}) => ({
    title: 'Route Validation Event',
    description: 'Exercises the server-side validator through the API.',
    category: 'Other',
    location: 'Test Hall',
    applicationDeadline: futureDeadline,
    slots: [{ name: 'Shift', description: 'd', startDatetime: futureStart, endDatetime: futureEnd, maxSpots: 5 }],
    ...overrides
  });

  it('rejects create with an inverted-time slot', async () => {
    const res = await srv.call('POST', '/api/events', basePayload({
      slots: [{ name: 'Shift', description: 'd', startDatetime: futureEnd, endDatetime: futureStart, maxSpots: 5 }]
    }), orgToken);
    expect(res.status).toBe(400);
  });

  it('rejects create with a negative maxSpots', async () => {
    const res = await srv.call('POST', '/api/events', basePayload({
      slots: [{ name: 'Shift', description: 'd', startDatetime: futureStart, endDatetime: futureEnd, maxSpots: -5 }]
    }), orgToken);
    expect(res.status).toBe(400);
  });

  it('rejects create with a past deadline', async () => {
    const res = await srv.call('POST', '/api/events', basePayload({
      applicationDeadline: new Date(Date.now() - 864e5).toISOString()
    }), orgToken);
    expect(res.status).toBe(400);
  });

  it('accepts a fully valid create', async () => {
    const res = await srv.call('POST', '/api/events', basePayload(), orgToken);
    expect(res.status).toBe(201);
  });

  it('rejects update with an invalid payload', async () => {
    const created = await srv.call('POST', '/api/events', basePayload(), orgToken);
    expect(created.status).toBe(201);
    const eventId = created.body.id;

    const res = await srv.call('PUT', `/api/events/${eventId}`, basePayload({
      slots: [{ name: 'Shift', description: 'd', startDatetime: futureStart, endDatetime: futureStart, maxSpots: 5 }]
    }), orgToken);
    expect(res.status).toBe(400);
  });
});

/**
 * ── A shift has a maximum length ──
 *
 * `end > start` was the whole duration rule, so a slot of any span was
 * accepted. That is a typo surface rather than an attack surface: one wrong
 * digit in a year turns a two-hour shift into a year-long one, and the moment
 * it ends it credits about seventeen thousand hours to everybody on it.
 * `MAX_CREDITABLE_HOURS` never saw that number — it only ever bounded a manual
 * override, never the automatically computed default.
 */
describe('slot duration bounds', () => {
  const at = (iso) => new Date(iso).toISOString();
  const base = (startIso, endIso) => ({
    title: 'T', description: 'D', location: 'L',
    applicationDeadline: at('2030-01-01T00:00:00.000Z'),
    slots: [{
      name: 'Shift', description: '', maxSpots: 5,
      startDatetime: at(startIso), endDatetime: at(endIso),
    }],
  });

  it('accepts a shift of ordinary length', () => {
    expect(validateEventPayload(base('2030-06-01T09:00:00.000Z', '2030-06-01T12:00:00.000Z')).ok).toBe(true);
  });

  /* The longest shift in the pilot data is fifteen hours, so the bound has to
     clear that comfortably — an overnight event is a real thing. */
  it('accepts a long but plausible shift, and the boundary exactly', () => {
    expect(validateEventPayload(base('2030-06-01T18:00:00.000Z', '2030-06-02T09:00:00.000Z')).ok).toBe(true);
    expect(validateEventPayload(base('2030-06-01T00:00:00.000Z', '2030-06-02T00:00:00.000Z')).ok).toBe(true);
  });

  it('refuses a shift longer than a day', () => {
    const res = validateEventPayload(base('2030-06-01T00:00:00.000Z', '2030-06-02T00:00:01.000Z'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cannot be longer than 24 hours/i);
    expect(res.error, 'says what to do instead').toMatch(/one shift per day/i);
  });

  /* The error this rule exists for: a mistyped year. */
  it('refuses the year typo that motivated the rule', () => {
    const res = validateEventPayload(base('2030-06-01T09:00:00.000Z', '2031-06-01T11:00:00.000Z'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/longer than 24 hours/i);
  });

  it('still refuses a shift that ends before it starts', () => {
    const res = validateEventPayload(base('2030-06-01T12:00:00.000Z', '2030-06-01T09:00:00.000Z'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/end after it starts/i);
  });
});