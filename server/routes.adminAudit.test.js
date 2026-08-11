import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Audit coverage for privileged actions.
 *
 * The platform has three admin mutations. Two wrote an `admin_audit_logs` row
 * (APPROVE_ORGANIZER, DENY_ORGANIZER) and one did not:
 *
 *     PATCH /api/admin/reports/:id
 *
 * That is the moderation decision — an administrator marking a report resolved
 * or dismissed. On a platform where a report can be a student raising a safety
 * concern, dismissing one left no record of who dismissed it or when. A district
 * asking "who closed this report" had no answer, and neither did the admin who
 * needed to defend the decision.
 *
 * Deliberately NOT added, because it would be noise duplicating a better record:
 *   • hours and attendance changes — `hours_ledger` already records actor_id,
 *     actor_role, source, reason and timestamps, append-only and without foreign
 *     keys so it outlives the rows it describes. That is the stronger audit trail;
 *     a second copy in admin_audit_logs would drift from it.
 *   • reads (`/api/admin/stats`, `/api/admin/system/status`) — logging every page
 *     view of a dashboard buries the decisions that matter.
 */

let srv, admin;
beforeAll(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin@example.gov');
}, 60000);
afterAll(async () => { await srv?.close(); });

const auditRows = async (action) => {
  const { db } = await import('./db.js');
  return db.prepare('SELECT * FROM admin_audit_logs WHERE action = ? ORDER BY created_at DESC').all(action);
};

/** Files a report as a student so there is something to moderate. */
async function fileReport() {
  const student = await srv.login('leo.chen@example.com');
  const events = (await srv.call('GET', '/api/events', undefined, student)).body;
  const eventId = (Array.isArray(events) ? events : events.events)[0].id;
  const res = await srv.call('POST', '/api/reports', {
    targetType: 'event', targetId: eventId, reason: 'other', details: 'Testing the audit trail'
  }, student);
  expect([200, 201]).toContain(res.status);
  const { db } = await import('./db.js');
  return db.prepare('SELECT id FROM reports ORDER BY created_at DESC LIMIT 1').get().id;
}

describe('moderation decisions are recorded', () => {
  it('logs who resolved a report', async () => {
    const reportId = await fileReport();
    const before = (await auditRows('MODERATE_REPORT')).length;

    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'resolved', resolution: 'content_removed', resolutionNote: 'This is a long enough note to pass.' }, admin);
    expect(res.status).toBe(200);

    const rows = await auditRows('MODERATE_REPORT');
    expect(rows.length, 'no audit row was written for the moderation decision').toBe(before + 1);
    expect(rows[0].admin_id).toBeTruthy();
    expect(rows[0].details).toMatch(/resolved/);
    expect(rows[0].details).toContain(reportId);
  });

  it('logs a dismissal, which is the decision most worth being able to defend', async () => {
    const reportId = await fileReport();
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'dismissed', resolution: 'no_action', resolutionNote: 'This is a long enough note to pass.' }, admin);
    const rows = await auditRows('MODERATE_REPORT');
    expect(rows[0].details).toMatch(/dismissed/);
  });

  it('records the reporter as the target so the row is traceable to a person', async () => {
    const reportId = await fileReport();
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'resolved', resolution: 'content_removed', resolutionNote: 'This is a long enough note to pass.' }, admin);
    const rows = await auditRows('MODERATE_REPORT');
    expect(rows[0].target_user_id, 'a moderation row with no subject is hard to follow up').toBeTruthy();
  });

  it('writes nothing when the report does not exist', async () => {
    const before = (await auditRows('MODERATE_REPORT')).length;
    const res = await srv.call('PATCH', '/api/admin/reports/does-not-exist', { status: 'resolved', resolution: 'content_removed', resolutionNote: 'This is a long enough note to pass.' }, admin);
    expect(res.status).toBe(404);
    expect((await auditRows('MODERATE_REPORT')).length).toBe(before);
  });

  it('writes nothing when the status is invalid', async () => {
    const reportId = await fileReport();
    const before = (await auditRows('MODERATE_REPORT')).length;
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'nonsense' }, admin);
    expect(res.status).toBe(400);
    expect((await auditRows('MODERATE_REPORT')).length).toBe(before);
  });

  it('writes nothing when a non-admin attempts it', async () => {
    const reportId = await fileReport();
    const student = await srv.login('leo.chen@example.com');
    const before = (await auditRows('MODERATE_REPORT')).length;
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'dismissed', resolution: 'no_action', resolutionNote: 'This is a long enough note to pass.' }, student);
    expect(res.status).toBe(403);
    expect((await auditRows('MODERATE_REPORT')).length).toBe(before);
  });
});

describe('the pre-existing audit trail still works', () => {
  it('logs organizer approval', async () => {
    const { db } = await import('./db.js');
    const pending = db.prepare("SELECT id FROM users WHERE role='organizer' AND verified = 0 LIMIT 1").get();
    if (!pending) return; // nothing pending in this seed
    const before = (await auditRows('APPROVE_ORGANIZER')).length;
    const res = await srv.call('POST', `/api/admin/organizers/${pending.id}/approve`, {}, admin);
    expect(res.status).toBe(200);
    expect((await auditRows('APPROVE_ORGANIZER')).length).toBe(before + 1);
  });
});

describe('every audit row is complete enough to act on', () => {
  it('has an actor, an action and a timestamp', async () => {
    const { db } = await import('./db.js');
    const rows = db.prepare('SELECT * FROM admin_audit_logs').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.admin_id, `row ${r.id} has no actor`).toBeTruthy();
      expect(r.action, `row ${r.id} has no action`).toBeTruthy();
      expect(r.created_at, `row ${r.id} has no timestamp`).toBeTruthy();
      expect(Number.isNaN(Date.parse(r.created_at)), `row ${r.id} timestamp unparseable`).toBe(false);
    }
  });
});
