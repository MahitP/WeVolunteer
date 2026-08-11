import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A reported party must not be able to destroy the evidence against themselves.
 *
 * ── The finding ──
 *
 * Three cascades chained together:
 *
 *   conversations.event_id                 -> events(id)                   CASCADE
 *   conversation_reports.conversation_id   -> conversations(id)            CASCADE
 *   conversation_report_messages.report_id -> conversation_reports(id)     CASCADE
 *
 * So deleting an event deleted every conversation held under it, every safety
 * report filed about those conversations, and the message snapshots that were
 * built specifically to survive message deletion.
 *
 * `DELETE /api/events/:id` refused only two things: an event with attendance
 * recorded, and a completed event. **Grooming happens before the event runs**,
 * when attendance is zero by definition — so the window in which the evidence
 * was destructible was exactly the window in which the harm occurs. The
 * organizer needed no privilege they did not already have; it was their own
 * event.
 *
 * A fourth cascade did the same on a three-year timer: `reporter_id` was
 * ON DELETE CASCADE on both report tables, and the retention sweep hard-deletes
 * anonymised shells at three years. A student who reported an adult and then
 * deleted their own account had their report destroyed by their own privacy
 * right.
 *
 * ── Why these tests are shaped around the evidence and not the delete ──
 *
 * It would be easy to write a test that deletes an event and checks for a 409.
 * That passes the moment any refusal exists, including one that refuses for the
 * wrong reason. So each test below counts report and snapshot rows before and
 * after and asserts they survived; the status code is secondary.
 *
 * ── Why every fixture takes a unique day offset ──
 *
 * An earlier draft of this file gave every scenario the same slot times. The
 * second application collided with the first on the application-conflict check,
 * no conversation could be opened, and four of six tests failed inside the
 * fixture rather than at an assertion — proving nothing while looking like a
 * finding. `dayOffset` is what keeps the scenarios independent, and the fixture
 * asserts its own preconditions loudly for the same reason.
 */

/**
 * ONE server for the whole file.
 *
 * `db.js` opens its connection at module scope, so the first call decides the
 * path for the process; a second `startTestServer()` in a later describe block
 * throws its "the database connection is not the throwaway one" guard. The three
 * describes below therefore share this instance rather than each booting one.
 */
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(process.env.WEV_DB_PATH);
}

/**
 * One session per account for the whole file.
 *
 * Signing in per scenario exhausts the auth limiter partway through, and the
 * symptom is a fixture failing with "Access token required" several tests later
 * — which reads as a broken assertion rather than as a rate limit. Caching the
 * session is also closer to what a real client does.
 */
const sessions = new Map();
async function session(email) {
  if (!sessions.has(email)) sessions.set(email, await srv.login(email));
  return sessions.get(email);
}

describe('evidence under a live report cannot be destroyed by the reported party', () => {
  /** Distinct shift times per scenario, so applications never conflict. */
  let nextDayOffset = 30;

  /**
   * An organizer with a future event, a student who applied, a conversation
   * between them, and a safety report the student has filed about it.
   *
   * Deliberately with NO attendance: that is the state the finding is about, and
   * a fixture that recorded attendance would be refused by the pre-existing
   * guard and prove nothing.
   */
  async function groomingScenario() {
    const dayOffset = nextDayOffset++;
    const organizer = await session('jordan.whitfield@example.org');
    const student = await session('cameron.caldwell@example.com');

    const start = new Date(Date.now() + dayOffset * 864e5).toISOString();
    const made = await srv.call('POST', '/api/events', {
      title: `Pre-event window ${dayOffset}`, description: 'd', category: 'Other', location: 'Somewhere',
      applicationDeadline: new Date(Date.now() + (dayOffset - 10) * 864e5).toISOString(),
      slots: [{
        name: 'S', description: 'd', startDatetime: start,
        endDatetime: new Date(Date.now() + dayOffset * 864e5 + 108e5).toISOString(), maxSpots: 3,
      }],
    }, organizer);
    expect(made.status, 'fixture: event was not created').toBe(201);
    const eventId = made.body.id;

    const listed = await srv.call('GET', '/api/events', undefined, organizer);
    const slotId = listed.body.find(e => e.id === eventId).slots[0].id;
    const applied = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, student);
    expect(
      applied.status,
      `fixture: application refused (${JSON.stringify(applied.body)}) — messaging will not unlock`
    ).toBeLessThan(300);

    /**
     * The conversation is opened by the ORGANIZER, not the student.
     *
     * `resolveConversation` enforces the applicant-scope rule: an organizer may
     * open a thread with a student who applied to their event, naming that
     * student. A student does not name a counterparty at all — their side is
     * derived. Opening it from the organizer's side is both the shape the route
     * accepts and the realistic direction for this scenario.
     */
    const convo = await srv.call('POST', '/api/messages/conversations/resolve', {
      eventId, studentId: 'user-colin',
    }, organizer);
    const conversationId = convo.body?.conversation?.id;
    expect(
      conversationId,
      `fixture: no conversation created (${convo.status} ${JSON.stringify(convo.body)})`
    ).toBeTruthy();

    await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`, {
      body: 'Can we talk somewhere else?',
    }, organizer);

    const reported = await srv.call('POST', `/api/messages/conversations/${conversationId}/report`, {
      reason: 'safety', details: 'They asked me to move the conversation off the platform.',
    }, student);
    expect(reported.status, `fixture: report was not filed (${JSON.stringify(reported.body)})`).toBeLessThan(300);

    return { organizer, student, eventId, conversationId, reportId: reported.body.reportId };
  }

  /** Counts the rows that constitute the evidence for a conversation. */
  async function evidenceCounts(conversationId) {
    const db = await openDb();
    const reports = db.prepare(
      "SELECT COUNT(*) c FROM reports WHERE target_type = 'conversation' AND target_id = ?"
    ).get(conversationId).c;
    const snapshots = db.prepare(`
      SELECT COUNT(*) c FROM report_evidence
      WHERE report_id IN (SELECT id FROM reports WHERE target_type = 'conversation' AND target_id = ?)
    `).get(conversationId).c;
    db.close();
    return { reports, snapshots };
  }

  async function resolveReport(reportId) {
    const admin = await session('admin@example.gov');
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`,
      { status: 'resolved', resolution: 'account_suspended', resolutionNote: 'This is a long enough note to pass.' }, admin);
    expect(res.status, `could not resolve report (${JSON.stringify(res.body)})`).toBe(200);
  }

  it('has a fixture that really does produce a report and a snapshot', async () => {
    // Guards every test below: if the fixture silently stopped producing
    // evidence, they would "pass" by finding nothing destroyed.
    const { conversationId } = await groomingScenario();
    const before = await evidenceCounts(conversationId);
    expect(before.reports).toBeGreaterThan(0);
    expect(before.snapshots).toBeGreaterThan(0);
  });

  it('refuses to delete an event whose conversation is under a live report', async () => {
    const { organizer, eventId, conversationId } = await groomingScenario();
    const before = await evidenceCounts(conversationId);

    const res = await srv.call('DELETE', `/api/events/${eventId}`, undefined, organizer);

    const after = await evidenceCounts(conversationId);
    expect(
      after,
      'the reported organizer deleted their own event and the safety report went with it'
    ).toEqual(before);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('report_evidence_held');
  });

  it('says so in terms an organizer can act on, without naming the reporter', async () => {
    // The refusal is read by the person who may be the subject of the report.
    // It has to explain the refusal without disclosing who filed it or what it
    // says — telling a possible groomer which student reported them is worse
    // than the deletion.
    const { organizer, eventId } = await groomingScenario();
    const res = await srv.call('DELETE', `/api/events/${eventId}`, undefined, organizer);

    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).not.toContain('colin');
    expect(body).not.toContain('carbin');
    expect(body).not.toContain('somewhere else');
    expect(res.body.error).toMatch(/report/i);
    // Actionable, or an innocent organizer is simply stuck.
    expect(res.body.error).toMatch(/cancel/i);
  });

  it('still lets an ordinary unreported event be deleted', async () => {
    // The guard must not become "organizers cannot delete events". A refusal
    // that fires on everything gets removed.
    const organizer = await session('jordan.whitfield@example.org');
    const dayOffset = nextDayOffset++;
    const start = new Date(Date.now() + dayOffset * 864e5).toISOString();
    const made = await srv.call('POST', '/api/events', {
      title: 'Nothing reported', description: 'd', category: 'Other', location: 'Somewhere',
      applicationDeadline: new Date(Date.now() + (dayOffset - 10) * 864e5).toISOString(),
      slots: [{
        name: 'S', description: 'd', startDatetime: start,
        endDatetime: new Date(Date.now() + dayOffset * 864e5 + 108e5).toISOString(), maxSpots: 3,
      }],
    }, organizer);

    const res = await srv.call('DELETE', `/api/events/${made.body.id}`, undefined, organizer);
    expect(res.status).toBe(200);
  });

  it('holds against an administrator too, not just the reported organizer', async () => {
    /**
     * `event.moderate` lets an admin delete anyone's event. The hold is about the
     * evidence rather than about who is asking, and an administrator named in a
     * report is exactly the case where "trust the admin" is the wrong default.
     */
    const { eventId, conversationId } = await groomingScenario();
    const admin = await session('admin@example.gov');
    const before = await evidenceCounts(conversationId);

    const res = await srv.call('DELETE', `/api/events/${eventId}`, undefined, admin);

    expect(await evidenceCounts(conversationId)).toEqual(before);
    expect(res.status).toBe(409);
  });

  it('releases the hold once the report is resolved', async () => {
    /**
     * A permanent hold would mean any event that ever attracted a report could
     * never be deleted, which turns a safety mechanism into a way to pin an
     * organizer's calendar in place for ever. The hold is on LIVE reports.
     *
     * Resolution goes through the route rather than raw SQL deliberately: until
     * this release nothing in the product could move a conversation report out
     * of 'open', so the hold would have had no key at all.
     */
    const { organizer, eventId, reportId } = await groomingScenario();

    await resolveReport(reportId);

    const res = await srv.call('DELETE', `/api/events/${eventId}`, undefined, organizer);
    expect(res.status).toBe(200);
  });

  it('keeps the evidence after the event it belonged to is finally deleted', async () => {
    /**
     * The other half of the release above, and the one that matters: lifting the
     * hold must not re-arm the cascade. The report and its snapshot have to
     * survive the deletion of the event, the conversation, and every message in
     * it — that is what "preserved" has to mean once the hold is gone.
     */
    const { organizer, eventId, conversationId, reportId } = await groomingScenario();
    const before = await evidenceCounts(conversationId);
    expect(before.snapshots).toBeGreaterThan(0);

    await resolveReport(reportId);
    expect(
      (await srv.call('DELETE', `/api/events/${eventId}`, undefined, organizer)).status
    ).toBe(200);

    const db = await openDb();
    expect(
      db.prepare('SELECT COUNT(*) c FROM conversations WHERE id = ?').get(conversationId).c,
      'fixture: the conversation should genuinely be gone, or this proves nothing'
    ).toBe(0);
    db.close();

    expect(
      await evidenceCounts(conversationId),
      'the conversation cascade took the safety report with it'
    ).toEqual(before);
  });

  it('preserves the context a moderator needs once the live rows are gone', async () => {
    /**
     * Surviving as a row is not the same as surviving as evidence. Everything a
     * moderator reads used to be resolved by joining to destructible rows: the
     * reporter's name (anonymised on account deletion), the reported party (only
     * derivable from the conversation), and the event (the organizer's own to
     * delete). A report that reads "someone reported something about someone" is
     * not evidence of anything.
     */
    const { organizer, eventId, reportId } = await groomingScenario();
    await resolveReport(reportId);
    await srv.call('DELETE', `/api/events/${eventId}`, undefined, organizer);

    const db = await openDb();
    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
    db.close();

    expect(row.reporter_name_snapshot, 'who filed it').toBeTruthy();
    expect(row.target_author_name_snapshot, 'who it was about').toBeTruthy();
    expect(row.target_role_snapshot, 'and what they were to the reporter').toBe('organizer');
    expect(row.target_name_snapshot, 'and where it happened').toMatch(/Pre-event window/);
    expect(row.description, 'and what the student actually said')
      .toMatch(/off the platform/);
  });
});

describe('a safety record survives the deletion of the people in it', () => {
  /**
   * Driven at the database rather than through the deletion route, because the
   * cascade being tested fires on the retention sweep's hard DELETE of an
   * anonymised shell — three years after the account deletion the route
   * performs, and unreachable in a test that only calls the route.
   */
  it('does not erase a report when the reporter\'s shell is purged', async () => {
    const db = await openDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, grade, role, verified, created_at, account_status)
      VALUES ('u-purge-reporter', 'Purge Reporter', 'purge-reporter@test.local', 'x', 'N/A', 'student', 1, ?, 'deleted')
    `).run(now);
    db.prepare(`
      INSERT INTO reports (id, reporter_id, reporter_name_snapshot, target_type, target_id,
                           target_body_snapshot, category, description, status, priority,
                           created_at, updated_at)
      VALUES ('rep-purge-1', 'u-purge-reporter', 'Purge Reporter', 'comment', 'cmt-gone',
              'the comment that was reported', 'bullying_or_harassment', 'it was abusive',
              'resolved', 'normal', ?, ?)
    `).run(now, now);

    // The cascade under test. Before migration 011 this deleted the report.
    db.prepare("DELETE FROM users WHERE id = 'u-purge-reporter'").run();

    const row = db.prepare("SELECT * FROM reports WHERE id = 'rep-purge-1'").get();
    db.close();

    expect(row, 'purging the reporter destroyed their own safety report').toBeTruthy();
    expect(row.reporter_id, 'the live link is severed, as it should be').toBeNull();
    expect(row.reporter_name_snapshot, 'but the queue still has a name to show').toBe('Purge Reporter');
    expect(row.target_body_snapshot, 'and the evidence is still readable')
      .toBe('the comment that was reported');
  });

  it('holds the shell of an account that is party to a live report', async () => {
    const { sweep } = await import('./workers/retentionWorker.js');
    const db = await openDb();
    const longAgo = new Date(Date.now() - 4 * 365 * 864e5).toISOString();

    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, grade, role, verified, created_at,
                         account_status, deleted_at)
      VALUES ('u-held', 'Held Shell', 'held@test.local', 'x', 'N/A', 'student', 1, ?, 'deleted', ?)
    `).run(longAgo, longAgo);
    db.prepare(`
      INSERT INTO reports (id, reporter_id, reporter_name_snapshot, target_type, target_id,
                           category, description, status, priority, created_at, updated_at)
      VALUES ('rep-held-1', 'u-held', 'Held Shell', 'comment', 'cmt-x', 'bullying_or_harassment',
              'still being looked at', 'open', 'normal', ?, ?)
    `).run(longAgo, longAgo);

    const result = sweep(db, { now: new Date() });

    expect(
      db.prepare("SELECT 1 FROM users WHERE id = 'u-held'").get(),
      'the shell of a party to an OPEN report was purged, taking the surrounding context'
    ).toBeTruthy();
    expect(result.heldByReport).toBeGreaterThan(0);

    // ...and the hold lifts when the report is dealt with, or it is not a hold,
    // it is a permanent exemption nobody chose.
    db.prepare("UPDATE reports SET status = 'resolved' WHERE id = 'rep-held-1'").run();
    sweep(db, { now: new Date() });
    expect(
      db.prepare("SELECT 1 FROM users WHERE id = 'u-held'").get(),
      'resolving the report must release the shell to the published 3-year schedule'
    ).toBeFalsy();
    expect(
      db.prepare("SELECT 1 FROM reports WHERE id = 'rep-held-1'").get(),
      'and the report itself still survives the purge'
    ).toBeTruthy();

    db.close();
  });

  it('does not let an organizer purge take volunteers\' credited hours with it', async () => {
    /**
     * `events.organizer_id` is ON DELETE CASCADE, so purging an organizer's
     * shell deletes every event they ran and cascades into `attendance` — other
     * people's service records, and any report filed about those events. The
     * purge exemption checked only the purged account's OWN attendance rows, and
     * `attendance.user_id` is always the volunteer, never the organizer, so an
     * organizer shell was never exempt however many students depended on it.
     *
     * Time-armed rather than live: nothing purges until three years after a
     * deletion. `sweep` takes `now`, which is the only reason this is testable
     * at all rather than in 2029.
     */
    const { sweep } = await import('./workers/retentionWorker.js');
    const db = await openDb();
    const longAgo = new Date(Date.now() - 4 * 365 * 864e5).toISOString();

    const attendanceBefore = db.prepare('SELECT COUNT(*) c FROM attendance').get().c;
    const organizerId = db.prepare(
      'SELECT organizer_id FROM events WHERE id IN (SELECT DISTINCT event_id FROM attendance) LIMIT 1'
    ).get()?.organizer_id;
    expect(organizerId, 'fixture: the seed has no organizer with attendance against their events').toBeTruthy();

    db.prepare(`
      UPDATE users SET account_status = 'deleted', deleted_at = ? WHERE id = ?
    `).run(longAgo, organizerId);

    sweep(db, { now: new Date() });

    const attendanceAfter = db.prepare('SELECT COUNT(*) c FROM attendance').get().c;

    /**
     * Put the seeded organizer back before asserting.
     *
     * They are a shared fixture — `authenticateToken` refuses a deleted account
     * outright — so leaving them deleted breaks every later test in the file
     * with "Account has been deleted", several describes away from the cause.
     * Restoring before the assertion means a failure here still leaves the file
     * usable.
     */
    db.prepare(`
      UPDATE users SET account_status = 'active', deleted_at = NULL WHERE id = ?
    `).run(organizerId);
    db.close();

    expect(
      attendanceAfter,
      'purging an organizer cascaded through their events into other people\'s credited hours'
    ).toBe(attendanceBefore);
  });
});

describe('a moderator can still read what was preserved', () => {
  it('serves the preserved bodies, and logs that they were read', async () => {
    /**
     * Preservation into a black hole is not preservation. Until this release
     * nothing in `server/` read `conversation_reports` or its snapshots at all,
     * so the Youth Safety Guidelines' "we look at what was reported — including
     * the messages in a reported conversation … and it is logged" described
     * something that could not happen, and consequently was not logged either.
     */
    const organizer = await session('jordan.whitfield@example.org');
    const student = await session('cameron.caldwell@example.com');
    const admin = await session('admin@example.gov');

    const start = new Date(Date.now() + 200 * 864e5).toISOString();
    const made = await srv.call('POST', '/api/events', {
      title: 'Readable evidence', description: 'd', category: 'Other', location: 'Somewhere',
      applicationDeadline: new Date(Date.now() + 190 * 864e5).toISOString(),
      slots: [{
        name: 'S', description: 'd', startDatetime: start,
        endDatetime: new Date(Date.now() + 200 * 864e5 + 108e5).toISOString(), maxSpots: 3,
      }],
    }, organizer);
    // Fetched by id rather than from the list: by this point in the file the
    // list route has been hit enough times to answer with something other than
    // a bare array, and a fixture that breaks on an unrelated response shape is
    // a fixture that will be deleted rather than fixed.
    expect(made.status, `fixture: event not created (${JSON.stringify(made.body)})`).toBe(201);
    const one = await srv.call('GET', `/api/events/${made.body.id}`, undefined, organizer);
    expect(one.status, `fixture: event not readable (${JSON.stringify(one.body)})`).toBe(200);
    const slotId = one.body.event.slots[0].id;
    const applied = await srv.call('POST', `/api/events/${made.body.id}/apply`, { slotId }, student);
    expect(applied.status, `fixture: application refused (${JSON.stringify(applied.body)})`).toBeLessThan(300);

    const convo = await srv.call('POST', '/api/messages/conversations/resolve',
      { eventId: made.body.id, studentId: 'user-colin' }, organizer);
    const conversationId = convo.body.conversation.id;
    await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`,
      { body: 'Do not tell your parents about this' }, organizer);

    const filed = await srv.call('POST', `/api/messages/conversations/${conversationId}/report`,
      { reason: 'safety', details: 'He told me to keep it secret.' }, student);
    const reportId = filed.body.reportId;

    const queue = await srv.call('GET', '/api/admin/reports', undefined, admin);
    expect(queue.status).toBe(200);
    const listedReport = queue.body.find(r => r.id === reportId);
    expect(listedReport, 'a filed conversation report must reach the moderation queue').toBeTruthy();
    expect(listedReport.evidence_count).toBeGreaterThan(0);
    expect(
      JSON.stringify(listedReport),
      'a list view is scanned with other people at the desk; disclosures are not list content'
    ).not.toContain('tell your parents');

    const evidence = await srv.readEvidence(admin, reportId);
    expect(evidence.status).toBe(200);
    expect(evidence.body.messages.map(m => m.body).join(' ')).toContain('tell your parents');

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    const logged = db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED' AND details LIKE ?"
    ).get(`%${reportId}%`).c;
    db.close();
    expect(logged, 'reading a student\'s private messages must leave a record').toBeGreaterThan(0);
  });

  it('refuses a student who asks for the evidence route directly', async () => {
    const student = await session('cameron.caldwell@example.com');
    const res = await srv.call('GET', '/api/admin/reports/anything/evidence',
      undefined, student);
    expect(res.status).toBe(403);
  });
});
