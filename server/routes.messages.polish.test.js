import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('messaging UX polish', () => {
  let orgToken, studentToken;
  let evId, slotId, studentId, orgId;
  let conversationId;

  beforeAll(async () => {
    orgToken = await srv.login('jkatzenback@vikings.org');
    studentToken = await srv.login('leo.chen28@gmail.com');
    studentId = (await srv.call('GET', '/api/users/me', undefined, studentToken)).body.id;
    orgId = (await srv.call('GET', '/api/users/me', undefined, orgToken)).body.id;

    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'UX Polish Event', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(),
      slots: [{ name: 'Shift', description: 'd', startDatetime: future, endDatetime: new Date(Date.now() + 30 * 864e5 + 108e5).toISOString(), maxSpots: 5 }]
    }, orgToken);
    
    evId = mk.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === evId).slots[0];
    
    await srv.call('POST', `/api/events/${evId}/apply`, { slotId: slot.id }, studentToken);
  });

  it('opens conversation', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: evId, studentId }, studentToken);
    expect(res.status).toBe(200);
    conversationId = res.body.conversation.id;
  });

  it('rate limits sender if sending > 20 messages per minute', async () => {
    // Send 20 messages successfully
    for (let i = 0; i < 20; i++) {
      const res = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`, { body: `Spam ${i}` }, studentToken);
      expect(res.status).toBe(201);
    }

    // 21st message should fail with 429
    const limitRes = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`, { body: 'One too many' }, studentToken);
    
    expect(limitRes.status).toBe(429);
    expect(limitRes.body.error).toMatch(/too quickly/i);
  });

  it('read receipts: other user reads message and updates lastReadAt', async () => {
    // Organizer reads the conversation
    const readRes = await srv.call('POST', `/api/messages/conversations/${conversationId}/read`, {}, orgToken);
    expect(readRes.status).toBe(200);
    
    // Now student fetches conversation list, should see organizer read it
    const listRes = await srv.call('GET', '/api/messages/conversations', undefined, studentToken);
      
    expect(listRes.status).toBe(200);
    const convo = listRes.body.conversations.find(c => c.id === conversationId);
    expect(convo.otherParticipant).toBeDefined();
    expect(convo.otherParticipant.lastReadAt).toBeDefined();
    expect(convo.otherParticipant.lastReadAt).not.toBeNull();
  });
});
