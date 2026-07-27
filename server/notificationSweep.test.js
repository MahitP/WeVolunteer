import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './testServer.js';

/**
 * The sweep must tell an organizer when a deadline has passed with applicants
 * still waiting (P0-9).
 *
 * Nothing selects volunteers on its own — Auto Select is manual-trigger-only
 * and there is no scheduler for it. Before this rule, an organizer who forgot
 * left applicants in `pending` indefinitely: never accepted, never rejected,
 * never told anything. The seeded demo data reproduces exactly that state,
 * because event-softball's deadline (2026-07-24) is in the past and it still
 * has a pending application.
 *
 * utils.js is imported AFTER startTestServer so it binds to the same db.js
 * module instance the harness pointed at the throwaway database.
 */
describe('notification sweep: deadline passed with applicants waiting', () => {
  let srv, runNotificationSweep, db;

  const ORGANIZER = 'user-org-1';          // hosts event-softball
  const DEDUPE = 'awaiting-decision:event-softball';

  const notificationsFor = (userId, dedupeKey) => db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? AND dedupe_key = ?'
  ).all(userId, dedupeKey);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ runNotificationSweep } = await import('./utils.js'));
    ({ db } = await import('./db.js'));
  });
  afterAll(async () => { await srv.close(); });

  it('notifies the organizer, once, naming how many are waiting', () => {
    const pending = db.prepare(
      "SELECT COUNT(*) c FROM applications WHERE event_id = 'event-softball' AND status = 'pending'"
    ).get().c;
    expect(pending).toBeGreaterThan(0);   // the situation under test really exists

    runNotificationSweep();

    const sent = notificationsFor(ORGANIZER, DEDUPE);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('deadline');
    expect(sent[0].title).toMatch(/decision is needed/i);
    expect(sent[0].body).toContain(String(pending));
    expect(sent[0].link).toBe('event:event-softball');
  });

  it('does not repeat on the next sweep', () => {
    // The sweep runs every 15 minutes; without the dedupe key an organizer
    // would collect four of these an hour until they acted.
    runNotificationSweep();
    runNotificationSweep();
    expect(notificationsFor(ORGANIZER, DEDUPE)).toHaveLength(1);
  });

  it('tells the organizer, not the applicants', () => {
    const applicants = db.prepare(
      "SELECT DISTINCT user_id FROM applications WHERE event_id = 'event-softball' AND status = 'pending'"
    ).all().map(r => r.user_id);

    expect(applicants.length).toBeGreaterThan(0);
    for (const userId of applicants) {
      expect(notificationsFor(userId, DEDUPE)).toHaveLength(0);
    }
  });

  it('ignores an event whose deadline has not passed yet', () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const later = new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString();

    db.exec(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, auto_approve, created_at)
      VALUES ('event-future', 'Future Event', 'd', 'Other', 'loc', '${future}',
              '${ORGANIZER}', 'open', 0, '${new Date().toISOString()}');
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES ('slot-future', 'event-future', 'Shift', 'd', '${later}', '${later}', 5);
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES ('app-future', 'user-student-1', 'event-future', 'slot-future', 'pending', '${new Date().toISOString()}');
    `);

    runNotificationSweep();
    expect(notificationsFor(ORGANIZER, 'awaiting-decision:event-future')).toHaveLength(0);
  });

  it('ignores cancelled and completed events', () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const now = new Date().toISOString();

    for (const [id, status] of [['event-cxl', 'cancelled'], ['event-done', 'completed']]) {
      db.exec(`
        INSERT INTO events (id, title, description, category, location, application_deadline,
                            organizer_id, status, auto_approve, created_at)
        VALUES ('${id}', '${id}', 'd', 'Other', 'loc', '${past}', '${ORGANIZER}', '${status}', 0, '${now}');
        INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
        VALUES ('slot-${id}', '${id}', 'Shift', 'd', '${past}', '${past}', 5);
        INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
        VALUES ('app-${id}', 'user-student-1', '${id}', 'slot-${id}', 'pending', '${now}');
      `);
    }

    runNotificationSweep();

    // A cancelled event has nothing to staff; a completed one is already done.
    expect(notificationsFor(ORGANIZER, 'awaiting-decision:event-cxl')).toHaveLength(0);
    expect(notificationsFor(ORGANIZER, 'awaiting-decision:event-done')).toHaveLength(0);
  });

  it('fires for a closed event that still has undecided applicants', () => {
    // Closing sign-ups does not decide anyone. An organizer who closed the
    // event and then forgot is in exactly the situation this rule exists for.
    db.exec("UPDATE events SET status = 'closed' WHERE id = 'event-future'");
    db.exec(`UPDATE events SET application_deadline = '${new Date(Date.now() - 3600 * 1000).toISOString()}' WHERE id = 'event-future'`);

    runNotificationSweep();
    expect(notificationsFor(ORGANIZER, 'awaiting-decision:event-future')).toHaveLength(1);
  });
});
