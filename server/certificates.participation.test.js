import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestServer } from './testServer.js';

/**
 * Events that give no hours, on every document that names them (ruling 16).
 *
 * An organizer can post an event that credits no hours — a donation drive, a
 * participation-only fair (P2-20). Attendance at one is recorded with zero
 * hours, which is right, and then every surface printed the zero: "+0 hrs"
 * on the dashboard and the profile, "0 hrs" on the transcript, and a
 * Certificate of Community Service reading "0 hrs of verified community
 * service". The owner ruled: "Attended · no hours" in place of "+0 hrs", and a
 * verifiable Certificate of Participation with no hours line.
 *
 * So every certificate payload says whether it is one — the list, the viewer,
 * the public verification answer and the downloaded file — from the event's
 * own flag, never from the number, because an hours-giving event where somebody
 * was credited 0 after leaving at once is a different thing.
 */

async function pdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
  }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  return content.items.map(i => i.str).join('');
}

describe('a no-hours event\'s certificate', () => {
  let srv;
  let db;
  let organizer;
  let student;
  let studentId;
  let organizerId;

  async function attendedEvent({ creditsHours }) {
    const eventId = `evt-${randomUUID()}`;
    const slotId = `slot-${randomUUID()}`;
    const appId = `app-${randomUUID()}`;
    const start = new Date(Date.now() - 3 * 3600000);
    const end = new Date(Date.now() - 1 * 3600000);
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, created_at, credits_hours)
      VALUES (?, ?, 'd', 'Other', 'Gym', ?, ?, 'open', ?, ?)
    `).run(eventId, creditsHours ? 'Shelving Afternoon' : 'Coat Drive', start.toISOString(), organizerId, now, creditsHours ? 1 : 0);
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Collection', 'd', ?, ?, 5)
    `).run(slotId, eventId, start.toISOString(), end.toISOString());
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'accepted', ?)
    `).run(appId, studentId, eventId, slotId, now);
    const res = await srv.call('POST', `/api/events/${eventId}/attendance`, { attendanceMap: { [appId]: true } }, organizer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return eventId;
  }

  const listed = async (eventId) => {
    const res = await srv.call('GET', '/api/certificates', undefined, student);
    expect(res.status).toBe(200);
    return res.body.find(c => c.eventId === eventId);
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    organizer = await srv.login('jordan.whitfield@example.org');
    student = await srv.login('leo.chen@example.com');
    studentId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('leo.chen@example.com')).id;
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('jordan.whitfield@example.org')).id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('is marked as participation in the list, the viewer and the public answer', async () => {
    const eventId = await attendedEvent({ creditsHours: false });
    const row = await listed(eventId);
    expect(row?.participation).toBe(true);
    expect(row.code).toBeTruthy();

    const detail = await srv.call('GET', `/api/certificates/${row.code}`, undefined, student);
    expect(detail.status).toBe(200);
    expect(detail.body.participation).toBe(true);

    const verify = await srv.call('GET', `/api/certificates/verify/${row.code}`);
    expect(verify.status).toBe(200);
    expect(verify.body.valid).toBe(true);
    expect(verify.body.participation).toBe(true);
  });

  it('downloads as a Certificate of Participation with no hours line', async () => {
    const eventId = await attendedEvent({ creditsHours: false });
    const { code } = await listed(eventId);
    const res = await fetch(`${srv.base}/api/certificates/${code}/pdf`, {
      headers: { Cookie: `wev_session=${student}` },
    });
    expect(res.status).toBe(200);
    const text = await pdfText(Buffer.from(await res.arrayBuffer()));
    expect(text).toContain('Certificate of Participation');
    expect(text).not.toContain('of verified community service');
  });

  it('leaves an hours-giving event a Certificate of Community Service', async () => {
    const eventId = await attendedEvent({ creditsHours: true });
    const row = await listed(eventId);
    expect(row?.participation).toBe(false);
    const verify = await srv.call('GET', `/api/certificates/verify/${row.code}`);
    expect(verify.body.participation).toBe(false);
  });
});
