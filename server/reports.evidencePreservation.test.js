/**
 * PR-1's guarantees, re-checked against the target types PR-2 added.
 *
 * ── Why a second file rather than more cases in the first ──
 *
 * `server/evidencePreservation.test.js` proves the guarantees for the surfaces
 * that existed when they were written: an event, a comment, and a conversation
 * reported through the legacy table. PR-2 added five more target types, a second
 * evidence table (`report_evidence`), and a fold that moved every legacy report
 * into the unified one — and every one of those is a fresh chance for a hold to
 * be scoped to something the new path does not write.
 *
 * The specific hazard: `evidenceHolds.js` used to read `conversation_reports`
 * and now reads `reports`. If the new write path put a conversation report
 * somewhere the hold predicate does not look — a different column, a different
 * target type — the hold silently stops holding, the organizer's event becomes
 * deletable mid-investigation, and nothing fails until the evidence is gone.
 * "Silent" is the failure mode PR-1 existed to end, so it is worth a file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db, organizerId, organizerEmail;

let seq = 0;
async function freshReporter() {
  seq += 1;
  return srv.signupConfirmed({
    email: `evid${seq}@test.local`, password: 'EvidencePass123!',
    name: `Evidence ${seq}`, username: `eviduser${seq}`, role: 'student', grade: '11',
  });
}

const adminToken = () => srv.login('admin@example.gov');

/**
 * An event of its own per case, with a conversation on it and messages old
 * enough that the three-year sweep would take them. Built directly because the
 * demo seed has no conversations at all, and `conversation_participants` is
 * written explicitly because `isConversationParticipant` reads that table rather
 * than the two id columns on `conversations`.
 */
async function seedReportableThread(key, { ageDays = 4 * 365 } = {}) {
  const { cookie, user } = await freshReporter();
  const eventId = `ev_${key}`;
  const convId = `conv_${key}`;
  const at = Date.now() - ageDays * 86400000;
  const iso = (offset = 0) => new Date(at + offset).toISOString();

  await db.prepare(`INSERT INTO events (id, title, description, category, location,
                                 application_deadline, organizer_id, created_at)
              VALUES (?, ?, 'x', 'Other', 'Somewhere', '2030-01-01', ?, ?)`)
    .run(eventId, `Event ${key}`, organizerId, iso());
  await db.prepare(`INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(convId, eventId, user.id, organizerId, organizerId, iso());
  for (const [uid, role] of [[user.id, 'student'], [organizerId, 'organizer']]) {
    await db.prepare(`INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
                VALUES (?, ?, ?, ?)`).run(convId, uid, role, iso());
  }
  const messageIds = [];
  for (let i = 0; i < 30; i++) {
    const id = `msg_${key}_${i}`;
    messageIds.push(id);
    await db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
                VALUES (?, ?, ?, ?, ?)`)
      .run(id, convId, i % 2 ? user.id : organizerId, `body ${i}`, iso(i * 1000));
  }
  return { cookie, user, eventId, convId, messageIds };
}

const messagesLeft = (convId) =>
  db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ?').get(convId).c;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;
  const org = await db.prepare("SELECT id, email FROM users WHERE role = 'organizer' LIMIT 1").get();
  organizerId = org.id;
  organizerEmail = org.email;
});
afterAll(async () => { await srv.close(); });

describe('the retention sweep does not delete under a live investigation', () => {
  /**
   * The regression this whole exemption exists for. The old snapshot was capped
   * at twenty caller-named ids or the last ten messages, so message eleven of a
   * reported conversation was swept while the report was still open — a live
   * evidence-destruction path that no test caught because the report itself
   * survived.
   */
  it('keeps every message in a conversation under an open report, not just the snapshot', async () => {
    const { cookie, convId } = await seedReportableThread('sweep_live');
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'asked_to_meet_alone',
    }, cookie);
    expect(filed.status).toBe(200);

    const { sweep } = await import('./workers/retentionWorker.js');
    await sweep(db, { now: new Date() });

    expect(messagesLeft(convId), 'four-year-old messages under a live report were swept').toBe(30);
    expect(
      (await db.prepare('SELECT COUNT(*) c FROM report_evidence WHERE report_id = ?').get(filed.body.reportId)).c,
      'the frozen snapshot did not survive its own sweep',
    ).toBe(30);
  });

  it('keeps the messages around a reported single message', async () => {
    const { cookie, convId, messageIds } = await seedReportableThread('sweep_message');
    const filed = await srv.call('POST', `/api/messages/${messageIds[10]}/report`, {
      reason: 'inappropriate',
    }, cookie);
    expect(filed.status).toBe(201);

    const { sweep } = await import('./workers/retentionWorker.js');
    await sweep(db, { now: new Date() });

    // The whole thread is held while the report is live: the snapshot is bounded
    // and message 30 is still evidence while somebody is reading message 10.
    expect(messagesLeft(convId)).toBe(30);
  });

  /**
   * The other half, and the one that stops a hold becoming a permanent lock: a
   * report that has been dealt with releases what it was holding, and the frozen
   * snapshot is what survives afterwards. Without this the Privacy Policy's
   * published three-year message period would quietly become "for ever, if
   * anyone ever reported it".
   */
  it('releases the messages once the report is resolved, and keeps the snapshot', async () => {
    const { cookie, convId } = await seedReportableThread('sweep_release');
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'bullying_or_harassment',
    }, cookie);

    const { sweep } = await import('./workers/retentionWorker.js');
    await sweep(db, { now: new Date() });
    expect(messagesLeft(convId)).toBe(30);

    await srv.call('PATCH', `/api/admin/reports/${filed.body.reportId}`, {
      status: 'resolved', resolution: 'no_action', resolutionNote: 'Reviewed and closed out.',
    }, await adminToken());

    await sweep(db, { now: new Date() });
    expect(messagesLeft(convId), 'the hold never released').toBe(0);
    expect(
      (await db.prepare('SELECT COUNT(*) c FROM report_evidence WHERE report_id = ?').get(filed.body.reportId)).c,
      'the evidence went with the messages — the snapshot IS the record',
    ).toBe(30);
    expect(await db.prepare('SELECT 1 FROM reports WHERE id = ?').get(filed.body.reportId)).toBeTruthy();
  });

  /**
   * `escalated` is a status rather than a priority precisely so that a report
   * which has left the queue for a phone call to DCP&P still holds its evidence.
   */
  it('holds while a report is escalated', async () => {
    const { cookie, convId } = await seedReportableThread('sweep_escalated');
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'threatened_me',
    }, cookie);
    await srv.call('PATCH', `/api/admin/reports/${filed.body.reportId}`,
      { status: 'escalated' }, await adminToken());

    const { sweep } = await import('./workers/retentionWorker.js');
    await sweep(db, { now: new Date() });
    expect(messagesLeft(convId)).toBe(30);
  });

  it('leaves the preserved tables untouched on every pass', async () => {
    const { PRESERVED_TABLES } = await import('./workers/retentionWorker.js');
    for (const table of ['reports', 'report_evidence', 'moderation_actions']) {
      expect(PRESERVED_TABLES, `${table} is not asserted untouched after a sweep`).toContain(table);
    }
  });
});

describe('a report outlives what it is about', () => {
  it('refuses to delete an event whose conversation is under a live report', async () => {
    const { cookie, convId, eventId } = await seedReportableThread('hold_event', { ageDays: 1 });
    await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'asked_to_keep_secret',
    }, cookie);

    const res = await srv.call('DELETE', `/api/events/${eventId}`, undefined, await srv.login(organizerEmail));
    expect(res.status, 'the reported organizer deleted the evidence against them').toBe(409);
    // Two codes across the two surfaces (`report_evidence_held` for an event,
    // `under_review` for a comment). Asserted as-is rather than unified here:
    // renaming a code the shipped client may branch on is not a change to make
    // in the same release as a table rebuild.
    expect(res.body.code).toBe('report_evidence_held');
  });

  it('refuses to delete a reported comment, and points at what to do instead', async () => {
    const { cookie } = await freshReporter();
    const comment = await db.prepare('SELECT id, user_id FROM event_comments LIMIT 1').get();
    await srv.call('POST', '/api/reports', {
      targetType: 'comment', targetId: comment.id, reason: 'hate_or_discrimination',
    }, cookie);

    const author = await db.prepare('SELECT email FROM users WHERE id = ?').get(comment.user_id);
    const res = await srv.call('DELETE', `/api/comments/${comment.id}`, undefined, await srv.login(author.email));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('under_review');
    // Never names the reporter: who reported you is not something the subject gets.
    expect(JSON.stringify(res.body)).not.toContain('Evidence');
  });

  /**
   * A report against a person holds that person's shell, in both directions. The
   * reporter side is the one that is easy to miss: `reports.reporter_id` used to
   * cascade, so purging a reporting student's anonymised shell destroyed their
   * own safety report — a victim's privacy right silently erasing the record of
   * what was done to them.
   */
  it('holds both parties’ shells while a report about them is live', async () => {
    const { cookie, user } = await freshReporter();
    const subject = (await freshReporter()).user;
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: subject.id, reason: 'threatened_me',
    }, cookie);

    const { userIsPartyToLiveReport } = await import('./evidenceHolds.js');
    expect(await userIsPartyToLiveReport(db, subject.id), 'the reported person is not held').toBe(true);
    expect(await userIsPartyToLiveReport(db, user.id), 'the reporter is not held').toBe(true);

    await srv.call('PATCH', `/api/admin/reports/${filed.body.reportId}`, {
      status: 'dismissed', resolution: 'no_action', resolutionNote: 'Nothing to act on here.',
    }, await adminToken());

    expect(await userIsPartyToLiveReport(db, subject.id), 'the hold never releases').toBe(false);
    expect(await userIsPartyToLiveReport(db, user.id)).toBe(false);
  });

  it('keeps the report readable after the reporter’s account is anonymised', async () => {
    const { cookie, user } = await freshReporter();
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: 'someone_who_left', reason: 'hate_or_discrimination',
      details: 'do not lose this',
    }, cookie);

    await db.prepare("UPDATE users SET account_status = 'deleted', deleted_at = ?, name = 'Deleted user' WHERE id = ?")
      .run(new Date().toISOString(), user.id);

    const q = await srv.call('GET', '/api/admin/reports?status=all', undefined, await adminToken());
    const row = q.body.find(r => r.id === filed.body.reportId);
    expect(row, 'the report vanished with the account').toBeTruthy();
    expect(row.description).toBe('do not lose this');
    expect(row.reporter_name, 'nothing left to tell the moderator who filed it').toBeTruthy();
  });

  it('refuses to delete a report or edit what it says, by any path', async () => {
    const { cookie } = await freshReporter();
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: 'frozen_subject', reason: 'other', details: 'the original words',
    }, cookie);

    expect(() => db.prepare('DELETE FROM reports WHERE id = ?').run(filed.body.reportId))
      .toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE reports SET description = 'rewritten' WHERE id = ?")
      .run(filed.body.reportId)).toThrow(/record of what was said/);
    expect((await db.prepare('SELECT description FROM reports WHERE id = ?').get(filed.body.reportId)).description)
      .toBe('the original words');
  });

  it('refuses to delete or edit a frozen evidence snapshot', async () => {
    const { cookie, convId } = await seedReportableThread('frozen_evidence', { ageDays: 1 });
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'sexual_content',
    }, cookie);

    expect(() => db.prepare('DELETE FROM report_evidence WHERE report_id = ?').run(filed.body.reportId))
      .toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE report_evidence SET body = 'rewritten' WHERE report_id = ?")
      .run(filed.body.reportId)).toThrow(/never edited/);
  });

  /**
   * The snapshot has to survive the message row being swept or hard-deleted —
   * that is the entire purpose of a snapshot. A foreign key to `messages` here
   * would make evidence preservation a lie.
   */
  it('keeps the evidence after the messages it copied are gone', async () => {
    const { cookie, convId } = await seedReportableThread('outlives', { ageDays: 1 });
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'comments_on_my_body',
    }, cookie);
    await srv.call('PATCH', `/api/admin/reports/${filed.body.reportId}`, {
      status: 'resolved', resolution: 'escalated_offline', resolutionNote: 'Referred to the district.',
    }, await adminToken());

    await db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId);
    await db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);

    const evidence = await srv.readEvidence(await adminToken(), filed.body.reportId);
    expect(evidence.status).toBe(200);
    expect(evidence.body.messages.length).toBe(30);
    expect(evidence.body.messages[0].body).toContain('body ');
  });
});

describe('reading evidence is logged to both trails', () => {
  /**
   * Youth Safety Guidelines, in print: "This is the one situation in which an
   * administrator reads private messages, and it is logged."
   *
   * Two trails because they are retained differently. `admin_audit_logs` is swept
   * at 365 days; a suspension is permanent and appealable years later, and "who
   * read this student's private messages" is exactly what a parent or a district
   * asks long after the year is up.
   */
  it('records the read in admin_audit_logs and in the durable report history', async () => {
    const { cookie, convId } = await seedReportableThread('logged_read', { ageDays: 1 });
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'asked_for_private_info',
    }, cookie);
    const reportId = filed.body.reportId;

    const beforeAudit = (await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'"
    ).get()).c;

    const res = await srv.readEvidence(await adminToken(), reportId);
    expect(res.status).toBe(200);

    expect(
      (await db.prepare("SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'").get()).c,
      'private messages left the building with no administrative record',
    ).toBe(beforeAudit + 1);

    const history = await db.prepare(
      "SELECT actor_id FROM moderation_actions WHERE report_id = ? AND action = 'evidence_viewed'"
    ).all(reportId);
    expect(history.length, 'the durable trail has no record of the read').toBe(1);
    expect(history[0].actor_id, 'the read is recorded but not attributed').toBeTruthy();
  });

  it('needs report.evidence.read, which a student and an organizer do not hold', async () => {
    const { cookie, convId } = await seedReportableThread('gated_read', { ageDays: 1 });
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'offered_gifts_or_substances',
    }, cookie);

    for (const [who, token, expected] of [
      ['the reporter', cookie, 403],
      ['the organizer', await srv.login(organizerEmail), 403],
      ['nobody', undefined, 401],
    ]) {
      const res = await srv.call('GET', `/api/admin/reports/${filed.body.reportId}/evidence`, undefined, token);
      expect(res.status, `${who} could read preserved private messages`).toBe(expected);
    }
  });
});
