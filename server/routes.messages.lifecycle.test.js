import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
let db;
beforeAll(async () => { 
  srv = await startTestServer(); 
  const dbModule = await import('./db.js');
  db = dbModule.db;
});
afterAll(async () => { await srv.close(); });

describe('messaging lifecycle enforcement', () => {
  let studentToken, orgToken;
  let studentId, orgId;

  beforeAll(async () => {
    studentToken = await srv.login('leo.chen28@gmail.com');
    orgToken = await srv.login('jkatzenback@vikings.org');
    studentId = 'user-student-1';
    orgId = 'user-org-1';
  });

  const setupConversation = async (eventStatus, slotEndDaysOffset, appStatus, appAppliedDaysOffset) => {
    // 1. Create an event
    const futureStart = new Date(Date.now() + 20 * 864e5).toISOString();
    const futureEnd = new Date(Date.now() + 20 * 864e5 + 108e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Lifecycle Test Event', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: futureStart,
      slots: [{ name: 'Shift', description: 'd', startDatetime: futureStart, endDatetime: futureEnd, maxSpots: 3 }]
    }, orgToken);
    const evId = mk.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === evId).slots[0];
    
    // 2. Student applies
    await srv.call('POST', `/api/events/${evId}/apply`, { slotId: slot.id }, studentToken);
    
    // 3. Resolve conversation
    const convRes = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: evId, studentId }, studentToken);
    const convId = convRes.body.conversation.id;

    // 4. Force DB state
    const now = Date.now();
    const endDatetime = new Date(now + slotEndDaysOffset * 864e5).toISOString();
    const appliedAt = new Date(now + appAppliedDaysOffset * 864e5).toISOString();

    db.prepare('UPDATE events SET status = ? WHERE id = ?').run(eventStatus, evId);
    db.prepare('UPDATE slots SET end_datetime = ? WHERE event_id = ?').run(endDatetime, evId);
    db.prepare('UPDATE applications SET status = ?, applied_at = ? WHERE event_id = ?').run(appStatus, appliedAt, evId);

    return convId;
  };

  const sendMessage = async (convId) => {
    return srv.call('POST', `/api/messages/conversations/${convId}/messages`, { body: 'Test message' }, studentToken);
  };

  it('accepted application -> send succeeds', async () => {
    const convId = await setupConversation('open', 10, 'accepted', -1);
    const res = await sendMessage(convId);
    expect(res.status).toBe(201);
  });

  it('completed event + 29 days -> send succeeds', async () => {
    const convId = await setupConversation('completed', -29, 'accepted', -30);
    const res = await sendMessage(convId);
    expect(res.status).toBe(201);
  });

  it('completed event + 31 days -> send rejected', async () => {
    const convId = await setupConversation('completed', -31, 'accepted', -32);
    const res = await sendMessage(convId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conversation_read_only');
  });

  it('withdrawn application + 6 days -> send succeeds', async () => {
    const convId = await setupConversation('open', 10, 'withdrawn', -6);
    const res = await sendMessage(convId);
    expect(res.status).toBe(201);
  });

  it('withdrawn application + 8 days -> send rejected', async () => {
    const convId = await setupConversation('open', 10, 'withdrawn', -8);
    const res = await sendMessage(convId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conversation_read_only');
  });

  it('rejected application + 8 days -> send rejected', async () => {
    const convId = await setupConversation('open', 10, 'rejected', -8);
    const res = await sendMessage(convId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conversation_read_only');
  });
});
