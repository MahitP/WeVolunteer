import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * An administrator acting on somebody else's content leaves a record.
 *
 * ── The gap ──
 *
 * `recordAudit` is imported by the admin, account, appeals, privacy, invitation
 * and message routes — and by none of the event, application, attendance,
 * content or user routes. So an entire class of privileged action wrote nothing:
 * an administrator could delete another organizer's event, taking every comment,
 * application and announcement under it, or remove a student's words from an
 * event page, and `admin_audit_logs` recorded neither.
 *
 * The people affected are the ones least able to find out what happened. The
 * organizer sees their event gone; the student sees their comment gone. Neither
 * has anybody to ask, because nothing recorded who did it.
 *
 * ── The distinction this defends ──
 *
 * The trail answers "what did an administrator do to a PERSON". Somebody
 * deleting their own event or their own comment is not that — it is a person
 * editing their own contribution — and logging it would bury the rows that
 * matter under routine self-service. So the tests below assert both directions:
 * the moderation case records, and the self case does not.
 */
describe('administrative deletions are recorded', () => {
  let srv, db, admin, organizer, student;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    admin = await srv.login('admin@example.gov');
    organizer = await srv.login('jordan.whitfield@example.org');
    student = await srv.login('leo.chen@example.com');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const auditRows = (action) => db.prepare(
    'SELECT * FROM admin_audit_logs WHERE action = ? ORDER BY created_at DESC'
  ).all(action);

  /* ── Comments ──────────────────────────────────────────────────────────── */

  const postComment = async (token) => {
    /* The route is nested under the event — `/api/comments` does not exist, and
       the first version of this file posted there and got a 404 that read as a
       failure of the thing under test. */
    const res = await srv.call('POST', '/api/events/event-softball/comments',
      { body: 'A comment for the audit test.' }, token);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    return res.body.id ?? res.body.comment?.id;
  };

  it('records a moderator deleting somebody else\'s comment', async () => {
    const id = await postComment(student);
    const before = auditRows('COMMENT_DELETED').length;

    const res = await srv.call('DELETE', `/api/comments/${id}`, undefined, admin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = auditRows('COMMENT_DELETED');
    expect(rows.length, 'no audit row for a moderated deletion').toBe(before + 1);

    /* Against the AUTHOR, not the moderator — the trail answers "what was done to
       this person", and the subject is who was affected. */
    const studentId = (await db.prepare('SELECT id FROM users WHERE email = ?')
      .get('leo.chen@example.com')).id;
    expect(rows[0].target_user_id).toBe(studentId);
    expect(rows[0].admin_id).toBe('user-admin');

    /* The words themselves are not copied into the trail. They are a student's
       comment about a school event, and republishing them into a second table
       with a different retention period is not what this row is for. */
    expect(rows[0].details).not.toContain('A comment for the audit test.');
  });

  it('records nothing when an author deletes their own comment', async () => {
    const id = await postComment(student);
    const before = auditRows('COMMENT_DELETED').length;

    const res = await srv.call('DELETE', `/api/comments/${id}`, undefined, student);
    expect(res.status).toBe(200);

    expect(auditRows('COMMENT_DELETED').length,
      'self-service deletion was written to the administrative trail').toBe(before);
  });

  /* ── Events ────────────────────────────────────────────────────────────── */

  const makeEvent = (id, organizerId) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO events (id, title, description, category, location, organizer_id,
                          application_deadline, status, created_at)
      VALUES (?, ?, 'x', 'Other', 'Somewhere', ?, ?, 'open', ?)
    `).run(id, `Audit probe ${id}`, organizerId, now, now);
    return id;
  };

  it('records an administrator deleting another organizer\'s event', async () => {
    const organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?')
      .get('jordan.whitfield@example.org')).id;
    const id = makeEvent('event-audit-probe-1', organizerId);
    const before = auditRows('EVENT_DELETED').length;

    const res = await srv.call('DELETE', `/api/events/${id}`, undefined, admin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = auditRows('EVENT_DELETED');
    expect(rows.length, 'no audit row for an administrative event deletion').toBe(before + 1);
    expect(rows[0].target_user_id, 'the row does not name the organizer affected')
      .toBe(organizerId);
  });

  it('records nothing when an organizer deletes their own event', async () => {
    const organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?')
      .get('jordan.whitfield@example.org')).id;
    const id = makeEvent('event-audit-probe-2', organizerId);
    const before = auditRows('EVENT_DELETED').length;

    const res = await srv.call('DELETE', `/api/events/${id}`, undefined, organizer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(auditRows('EVENT_DELETED').length,
      'an organizer withdrawing their own listing was logged as an administrative act')
      .toBe(before);
  });
});
