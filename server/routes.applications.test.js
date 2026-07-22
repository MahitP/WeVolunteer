import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('applications: withdrawal and re-application', () => {
  let srv, studentToken, eventId, slotId;

  beforeAll(async () => {
    srv = await startTestServer();
    studentToken = await srv.login('leo.chen28@gmail.com');
    const events = (await srv.call('GET', '/api/events')).body;
    const ev = events.find(e => e.status === 'open' && e.slots.length > 0);
    eventId = ev.id;
    slotId = ev.slots.find(s => s.spotsRemaining > 0).id;
  });
  afterAll(async () => { await srv.close(); });

  const apply = () => srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, studentToken);
  const myApp = async () => {
    const apps = (await srv.call('GET', '/api/applications', undefined, studentToken)).body;
    return apps.find(a => a.slotId === slotId);
  };

  it('accepts the withdrawn status the client actually sends', async () => {
    await apply();
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'withdrawn' }, studentToken);
    expect(res.status).toBe(200);
  });

  it('records it as withdrawn, not rejected', async () => {
    expect((await myApp()).status).toBe('withdrawn');
  });

  it('lets the student re-apply to the same shift', async () => {
    const res = await apply();
    expect(res.status).toBe(201);
    expect((await myApp()).status).toBe('pending');
  });

  it('still blocks a duplicate application while one is live', async () => {
    const res = await apply();
    expect(res.status).toBe(400);
  });

  it('does not let a student withdraw someone elses application', async () => {
    const other = await srv.login('priya.patel.nhs@outlook.com');
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'withdrawn' }, other);
    expect(res.status).toBe(403);
  });

  it('does not let a student self-accept', async () => {
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'accepted' }, studentToken);
    expect(res.status).toBe(403);
  });
});
