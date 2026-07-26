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
    orgToken = await srv.login('jkatzenback@vikings.org');
    studentToken = await srv.login('leo.chen28@gmail.com');
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

  it('still accepts a well-formed event (no over-tightening)', async () => {
    const res = await srv.call('POST', '/api/events', validEvent({ title: 'Valid After Hardening' }), orgToken);
    expect(res.status).toBe(201);
  });

  it('still accepts a well-formed report', async () => {
    const res = await srv.call('POST', '/api/reports',
      { targetType: 'event', targetId: 'event-softball', reason: 'legitimate concern' }, studentToken);
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
    const studentToken = await srv.login('priya.patel.nhs@outlook.com');
    const res = await srv.call('POST', '/api/events', validEvent(), studentToken);
    expect(res.status).toBe(403);
  });
});
