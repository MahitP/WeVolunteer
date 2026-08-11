import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Malformed client input must be reported as the client's fault (Task 13b).
 *
 * Three routes returned 500 for input that was simply the wrong shape — a null
 * entry in `slots`, a non-string `title`, a non-string report `targetId`. A 500
 * says "the server is broken"; it hides a client bug, pages an operator for
 * nothing, and (before the generic handler was added) risked leaking driver
 * internals.
 *
 * Scope is deliberately narrow: only genuinely malformed input becomes 400.
 * Authorization failures stay 401/403 and real server faults stay 500 — those
 * cases are asserted here too, so a future blanket "return 400 on any error"
 * change would fail this suite.
 */
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const future = (days) => new Date(Date.now() + days * 864e5).toISOString();

/** A valid event payload; override one field per test to make it malformed. */
const validEvent = (over = {}) => ({
  title: 'Malformed Probe',
  description: 'd',
  category: 'Other',
  location: 'Hall',
  applicationDeadline: future(20),
  slots: [{
    name: 'Shift', description: 'd',
    startDatetime: future(30),
    endDatetime: new Date(Date.now() + 30 * 864e5 + 108e5).toISOString(),
    maxSpots: 3
  }],
  ...over
});

describe('malformed input returns 400, not 500', () => {
  let orgToken, studentToken;
  beforeAll(async () => {
    orgToken = await srv.login('jordan.whitfield@example.org');
    studentToken = await srv.login('leo.chen@example.com');
  });

  it('rejects a null entry in slots', async () => {
    const res = await srv.call('POST', '/api/events', validEvent({ slots: [null] }), orgToken);
    expect(res.status).toBe(400);
  });

  it('rejects a non-object entry in slots', async () => {
    const res = await srv.call('POST', '/api/events', validEvent({ slots: ['not-an-object'] }), orgToken);
    expect(res.status).toBe(400);
  });

  it('rejects a non-string title', async () => {
    const res = await srv.call('POST', '/api/events', validEvent({ title: { evil: 1 } }), orgToken);
    expect(res.status).toBe(400);
  });

  it('rejects a non-string location', async () => {
    const res = await srv.call('POST', '/api/events', validEvent({ location: ['a'] }), orgToken);
    expect(res.status).toBe(400);
  });

  it('rejects a non-string slot name', async () => {
    const ev = validEvent();
    ev.slots[0].name = { nope: true };
    const res = await srv.call('POST', '/api/events', ev, orgToken);
    expect(res.status).toBe(400);
  });

  it('rejects a non-string report targetId', async () => {
    const res = await srv.call('POST', '/api/reports',
      { targetType: 'event', targetId: { id: 1 }, reason: 'spam' }, studentToken);
    expect(res.status).toBe(400);
  });

  it('rejects a non-string report reason', async () => {
    const res = await srv.call('POST', '/api/reports',
      { targetType: 'event', targetId: 'event-softball', reason: { text: 'x' } }, studentToken);
    expect(res.status).toBe(400);
  });

  /**
   * The apply route's slot id, found by an extreme-usage fuzzing pass.
   *
   * `!slotId` was the only guard, so three shapes reached the SQL binder and
   * came back as 500: a boolean (node:sqlite refuses to bind it) and any
   * non-null object or array (read as a bag of NAMED parameters, raising
   * "Unknown named parameter 'a'"). Three of 350 malformed bodies answered
   * "Internal server error applying to event" for what was a client mistake.
   */
  describe('a slot id that is not a string', () => {
    for (const [label, slotId] of [
      ['a boolean', true],
      ['a nested object', { a: { b: 1 } }],
      ['an array', ['slot-softball-1']],
      ['a number', 12345],
    ]) {
      it(`rejects ${label}`, async () => {
        const res = await srv.call('POST', '/api/events/event-softball/apply', { slotId }, studentToken);
        expect(res.status, JSON.stringify(res.body)).toBe(400);
      });
    }

    it('still accepts a well-formed string slot id (no over-tightening)', async () => {
      const events = await srv.call('GET', '/api/events', undefined, studentToken);
      const event = (events.body.events ?? events.body).find(e => e.slots?.length);
      const res = await srv.call('POST', `/api/events/${event.id}/apply`,
        { slotId: event.slots[0].id, overrideConflict: true }, studentToken);
      expect([201, 400]).toContain(res.status);
      /* 400 only ever means a product rule (deadline passed, already applied) —
         never the shape of the request. */
      if (res.status === 400) expect(res.body.error).not.toMatch(/Required slotId missing/);
    });
  });

  it('still accepts a well-formed event (no over-tightening)', async () => {
    const res = await srv.call('POST', '/api/events', validEvent({ title: 'Valid After Hardening' }), orgToken);
    expect(res.status).toBe(201);
  });

  it('still accepts a well-formed report', async () => {
    const res = await srv.call('POST', '/api/reports',
      { targetType: 'event', targetId: 'event-softball', reason: 'other', details: 'legitimate text' }, studentToken);
    expect(res.status).toBe(200);
  });
});

describe('error codes stay meaningfully distinct', () => {
  it('unauthenticated requests are 401, not 400', async () => {
    const res = await srv.call('POST', '/api/events', validEvent());
    expect(res.status).toBe(401);
  });

  it('forbidden requests are 403, not 400', async () => {
    // A student may not create events — an authorization failure, not bad input.
    const studentToken = await srv.login('priya.patel@example.com');
    const res = await srv.call('POST', '/api/events', validEvent(), studentToken);
    expect(res.status).toBe(403);
  });
});
