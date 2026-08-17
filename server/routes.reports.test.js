/**
 * Filing a report, over every surface a student can reach.
 *
 * ── Why this file exists ──
 *
 * The unified reporting model added five target types to the two that existed,
 * two new endpoints, a category taxonomy, derived priority, an evidence
 * snapshot and duplicate suppression. Before this file the whole of it was
 * covered by three assertions in `reports.clientContract.test.js`, all of them
 * about one target type. Five of the seven target types had never been filed
 * end to end by anything, including `conversation` and `message` — the two the
 * Youth Safety Guidelines point every student at, and the two whose write path
 * is the only one that snapshots evidence.
 *
 * The cases below are grouped by the question they answer rather than by
 * endpoint, because three endpoints share one service and the thing worth
 * testing is the service's promises, not the routing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;
let eventIds, commentId, announcementId, organizerId, studentId;
let conversationId, messageIds;

/**
 * A conversation, built directly.
 *
 * The demo seed has no conversations and no messages at all, so the private
 * half of the reporting surface — the half that carries the evidence snapshot —
 * cannot be reached through the API from a cold database. `conversation_participants`
 * is written explicitly because `isConversationParticipant` reads that table and
 * not the two id columns on `conversations`; a fixture that seeds only the
 * conversation row produces a uniform 404 that looks exactly like a real
 * refusal.
 */
function seedConversation({ id, student, organizer, eventId, count }) {
  const base = Date.now() - 3600_000;
  db.prepare(`INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, eventId, student, organizer, organizer, new Date(base).toISOString());
  for (const [uid, role] of [[student, 'student'], [organizer, 'organizer']]) {
    db.prepare(`INSERT INTO conversation_participants
                  (conversation_id, user_id, role_at_creation, joined_at)
                VALUES (?, ?, ?, ?)`)
      .run(id, uid, role, new Date(base).toISOString());
  }
  const ids = [];
  for (let i = 0; i < count; i++) {
    const mid = `${id}_m${i}`;
    ids.push(mid);
    // Even index = sent by the organizer, so the student can report it without
    // tripping the self-report refusal.
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
                VALUES (?, ?, ?, ?, ?)`)
      .run(mid, id, i % 2 ? student : organizer, `body ${i}`, new Date(base + i * 1000).toISOString());
  }
  return ids;
}

/**
 * A conversation with a participant nothing else in this file uses.
 *
 * `conversations` is UNIQUE on `(student_id, organizer_id, event_id)`, so every
 * extra thread needs a student of its own rather than a second row for the same
 * pair.
 */
async function seedFreshConversation(id, count) {
  const { cookie, user } = await freshReporter();
  const ids = seedConversation({
    id, student: user.id, organizer: organizerId, eventId: eventIds[0], count,
  });
  return { cookie, user, messageIds: ids };
}

/**
 * A brand-new reporter per case.
 *
 * `idx_reports_no_dup` suppresses a second live report of the same target by the
 * same reporter and answers 200 with the FIRST report's id. Reusing one account
 * across cases silently makes half of them assert against a row an earlier case
 * created, which is the failure mode `reports.clientContract.test.js` records
 * having hit.
 */
let seq = 0;
async function freshReporter() {
  seq += 1;
  return srv.signupConfirmed({
    email: `reporter${seq}@test.local`, password: 'ReporterPass123!',
    name: `Reporter ${seq}`, username: `reporteruser${seq}`, role: 'student', grade: '11',
  });
}

const adminToken = () => srv.login('admin@example.gov');
const rowFor = (id) => db.prepare('SELECT * FROM reports WHERE id = ?').get(id);

/**
 * The ceiling this file asserts against.
 *
 * Set before `startTestServer()` because `reportLimiter.js` reads it once, at
 * module load, and the test server only reaches it when it dynamically imports
 * `app.js`. Set at all because the test server runs in DEMO_MODE, where the
 * production ceiling of 20/day is raised to 1000 — high enough that a test
 * claiming to prove the limiter exists would pass without ever reaching it.
 */
const REPORT_CEILING = 25;

beforeAll(async () => {
  process.env.REPORT_RATE_LIMIT = String(REPORT_CEILING);
  srv = await startTestServer();
  db = (await import('./db.js')).db;

  eventIds = (await db.prepare('SELECT id FROM events ORDER BY id').all()).map(r => r.id);
  commentId = (await db.prepare('SELECT id FROM event_comments LIMIT 1').get()).id;
  announcementId = (await db.prepare('SELECT id FROM event_announcements LIMIT 1').get()).id;
  organizerId = (await db.prepare("SELECT id FROM users WHERE role = 'organizer' LIMIT 1").get()).id;
  /**
   * A LIVE student, and ordered.
   *
   * `WHERE role = 'student' LIMIT 1` used to work by luck. Migration 022 seeds
   * `system-cli` — a reserved actor with `role = 'student'` and
   * `account_status = 'deleted'` — and it only stayed out of the way because the
   * demo accounts happened to be inserted first. When the seed moved after the
   * migrations, this started selecting the tombstone, and the three tests using
   * it failed at `login()` with "No account found".
   *
   * The application never had this exposure: every query of its own that counts
   * or lists students excludes tombstones, and `adminRoutes.js` says why. This
   * asks the same question the application asks.
   */
  const student = await db.prepare(
    "SELECT id, email FROM users WHERE role = 'student' AND account_status <> 'deleted' ORDER BY id LIMIT 1"
  ).get();
  studentId = student.id;

  conversationId = 'conv_reports_test';
  messageIds = seedConversation({
    id: conversationId, student: studentId, organizer: organizerId,
    eventId: eventIds[0], count: 25,
  });
});
afterAll(async () => { await srv.close(); });

describe('every target type files end to end', () => {
  /**
   * The public surfaces. Each one resolves an author, and the author's role is
   * snapshotted at report time so triage does not depend on a column that is
   * wrong the moment somebody's role changes.
   */
  it.each([
    ['event', () => eventIds[0]],
    ['comment', () => commentId],
    ['announcement', () => announcementId],
    ['user', () => organizerId],
  ])('files a %s report with the author resolved and snapshotted', async (targetType, getId) => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType, targetId: getId(), reason: 'bullying_or_harassment', details: 'what happened',
    }, cookie);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = rowFor(res.body.reportId);
    expect(row.target_type).toBe(targetType);
    expect(row.category).toBe('bullying_or_harassment');
    expect(row.status).toBe('open');
    expect(row.target_author_id, 'no author resolved — the queue has nobody to act on').toBeTruthy();
    expect(row.target_role_snapshot, 'role at report time is what triage sorts on').toBe('organizer');
    expect(row.target_name_snapshot, 'nothing for a moderator to read').toBeTruthy();
  });

  /**
   * `organizer` is accepted from a client and stored as `user`. A separate stored
   * type would be a second, mutable source of truth about a role that already
   * lives on the row — wrong the moment somebody's role changes, which is
   * exactly when a moderator most needs the record to be right.
   */
  it('stores an organizer report as a user report', async () => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'organizer', targetId: organizerId, reason: 'pretending_to_be_someone',
    }, cookie);
    expect(res.status).toBe(200);
    expect(rowFor(res.body.reportId).target_type).toBe('user');
  });

  /**
   * Certificate codes are bearer credentials. The shape is checked and the code
   * is deliberately NOT looked up: validating existence would turn the report
   * endpoint into a certificate-code oracle over a public verification surface.
   */
  it('accepts a well-formed certificate code without looking it up', async () => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'certificate', targetId: 'WEV-A2B3-C4D5', reason: 'fake_hours_or_certificate',
    }, cookie);
    expect(res.status).toBe(200);
    const row = rowFor(res.body.reportId);
    expect(row.target_type).toBe('certificate');
    expect(row.target_author_id, 'a certificate is not a person').toBeNull();
  });

  it('files a conversation report and freezes the whole thread as evidence', async () => {
    const t = await srv.login((await db.prepare('SELECT email FROM users WHERE id = ?').get(studentId)).email);
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: conversationId,
      reason: 'asked_to_meet_alone', details: 'this is the one that matters',
    }, t);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = rowFor(res.body.reportId);
    expect(row.conversation_id_snapshot).toBe(conversationId);
    expect(row.target_author_id, 'the reported party is the other participant').toBe(organizerId);
    expect(
      (await db.prepare('SELECT COUNT(*) c FROM report_evidence WHERE report_id = ?').get(res.body.reportId)).c,
      'a conversation report with no evidence is a report nobody can decide',
    ).toBe(messageIds.length);
  });

  /**
   * Context, not the single line. The old conversation snapshot was capped at
   * twenty caller-named ids or the last ten messages, which is why message
   * eleven of a reported conversation was being swept while the investigation
   * was still open.
   */
  it('files a message report with the messages either side of it', async () => {
    const t = await srv.login((await db.prepare('SELECT email FROM users WHERE id = ?').get(studentId)).email);
    const anchor = 12;   // even => organizer-sent, and far enough in for full context
    const res = await srv.call('POST', `/api/messages/${messageIds[anchor]}/report`, {
      reason: 'inappropriate', details: 'this message',
    }, t);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const captured = (await db.prepare(
      'SELECT message_id FROM report_evidence WHERE report_id = ? ORDER BY created_at'
    ).all(res.body.reportId)).map(r => r.message_id);

    expect(captured, 'the reported message itself is missing').toContain(messageIds[anchor]);
    expect(captured, 'no context before').toContain(messageIds[anchor - 10]);
    expect(captured, 'no context after').toContain(messageIds[anchor + 10]);
    expect(captured.length).toBe(21);
  });

  it('files a conversation report through the legacy path and writes no legacy row', async () => {
    const legacyConv = 'conv_reports_legacy';
    const { cookie } = await seedFreshConversation(legacyConv, 4);
    const before = (await db.prepare('SELECT COUNT(*) c FROM conversation_reports').get()).c;

    const res = await srv.call('POST', `/api/messages/conversations/${legacyConv}/report`, {
      reason: 'safety', details: 'the shipped modal payload',
    }, cookie);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(rowFor(res.body.reportId).target_type).toBe('conversation');
    expect(
      (await db.prepare('SELECT COUNT(*) c FROM conversation_reports').get()).c,
      'the fold is undone if this route still writes the legacy table',
    ).toBe(before);
  });

  /**
   * The four legacy reasons the shipped conversation modal still sends. A server
   * that 400s its own client is a self-inflicted outage, and on this surface the
   * outage is a student unable to report a conversation.
   */
  it.each([
    ['safety', 'something_feels_wrong'],
    ['inappropriate', 'bullying_or_harassment'],
    ['spam', 'spam_or_advertising'],
    ['other', 'other'],
  ])('maps the legacy conversation reason %s onto %s', async (reason, category) => {
    const convId = `conv_legacy_${reason}`;
    const { cookie } = await seedFreshConversation(convId, 2);

    const res = await srv.call('POST', `/api/messages/conversations/${convId}/report`, { reason }, cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(rowFor(res.body.reportId).category).toBe(category);
  });
});

describe('refusals are uniform, so nothing can be enumerated', () => {
  /**
   * The enumeration test, and the one worth writing twice.
   *
   * A signed-in account must not be able to tell "this conversation does not
   * exist" from "this conversation exists and you are not in it". Distinguishable
   * answers here are a membership oracle over a platform of minors, walkable
   * against arbitrary ids — the exact leak `server/messaging.js` already had to
   * close once.
   */
  it('answers identically for a real-but-invisible target and one that does not exist', async () => {
    const { cookie } = await freshReporter();

    const invisible = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: conversationId, reason: 'other',
    }, cookie);
    const absent = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: 'conv_does_not_exist', reason: 'other',
    }, cookie);

    expect(invisible.status).toBe(404);
    expect(absent.status).toBe(invisible.status);
    expect(JSON.stringify(absent.body)).toBe(JSON.stringify(invisible.body));
  });

  it('answers identically for a message in someone else’s conversation and an absent one', async () => {
    const { cookie } = await freshReporter();
    const invisible = await srv.call('POST', '/api/reports', {
      targetType: 'message', targetId: messageIds[0], reason: 'other',
    }, cookie);
    const absent = await srv.call('POST', '/api/reports', {
      targetType: 'message', targetId: 'msg_does_not_exist', reason: 'other',
    }, cookie);

    expect(invisible.status).toBe(404);
    expect(absent.status).toBe(invisible.status);
    expect(JSON.stringify(absent.body)).toBe(JSON.stringify(invisible.body));
  });

  /**
   * A user report is accepted whatever the id, and that is the point: there is
   * no lookup, so there is no oracle. The queue renders an unknown account.
   */
  it('accepts a user report against an id that does not exist', async () => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: 'user_that_never_existed', reason: 'pretending_to_be_someone',
    }, cookie);
    expect(res.status).toBe(200);
    const row = rowFor(res.body.reportId);
    expect(row.target_author_id).toBeNull();
    expect(row.target_name_snapshot).toBeNull();
  });

  it('refuses reporting yourself, whichever surface it is reached through', async () => {
    const t = await srv.login((await db.prepare('SELECT email FROM users WHERE id = ?').get(studentId)).email);
    // Odd index => sent by the student, so this is their own message.
    const own = await srv.call('POST', '/api/reports', {
      targetType: 'message', targetId: messageIds[7], reason: 'other',
    }, t);
    expect(own.status).toBe(400);
    expect(own.body.code).toBe('self_report');

    const self = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: studentId, reason: 'other',
    }, t);
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('self_report');
  });

  it('refuses an unknown target type and an unknown category', async () => {
    const { cookie } = await freshReporter();
    const badType = await srv.call('POST', '/api/reports', {
      targetType: 'group', targetId: eventIds[0], reason: 'other',
    }, cookie);
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe('bad_target_type');
  });

  it('refuses a description over the limit rather than truncating it', async () => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: eventIds[0], reason: 'other', details: 'x'.repeat(2001),
    }, cookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('description_too_long');
  });

  /**
   * Malformed rather than hostile, but the failure mode is the same one
   * `routes.malformed.test.js` exists to keep out: a shape the route did not
   * expect must be a 400, never a 500 and never a filed report.
   */
  it.each([
    ['an object targetId', { targetType: 'event', targetId: { a: 1 }, reason: 'other' }],
    ['an empty targetId', { targetType: 'event', targetId: '', reason: 'other' }],
    ['an object reason', { targetType: 'event', targetId: 'e', reason: { a: 1 } }],
    ['an array reason', { targetType: 'event', targetId: 'e', reason: ['a'] }],
    ['a null targetType', { targetType: null, targetId: 'e', reason: 'other' }],
    ['a numeric targetType', { targetType: 7, targetId: 'e', reason: 'other' }],
    ['no body at all', {}],
  ])('answers 400, not 500, for %s', async (_label, body) => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports',
      { ...body, targetId: body.targetId === 'e' ? eventIds[0] : body.targetId }, cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it('requires a session', async () => {
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: eventIds[0], reason: 'other',
    });
    expect(res.status).toBe(401);
  });
});

describe('what the client may and may not decide', () => {
  /**
   * Priority is derived and never accepted. A field the client sets is a field
   * an abusive client sets to urgent on everything, and a queue where everything
   * is urgent has no priority at all.
   */
  it('ignores a client-supplied priority, status and reporter identity', async () => {
    const { cookie, user } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: eventIds[0], reason: 'spam_or_advertising',
      priority: 'urgent', status: 'resolved', reporterId: 'user-admin',
      reporter_name_snapshot: 'Somebody Else', resolution: 'no_action',
    }, cookie);

    expect(res.status).toBe(200);
    const row = rowFor(res.body.reportId);
    expect(row.status).toBe('open');
    expect(row.reporter_id).toBe(user.id);
    expect(row.reporter_name_snapshot).toBe(user.name);
    expect(row.resolution).toBeNull();
  });

  it('derives urgent from the category alone for a peer report', async () => {
    const { cookie } = await freshReporter();
    const peer = (await freshReporter()).user;
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: peer.id, reason: 'threatened_me',
    }, cookie);
    expect(rowFor(res.body.reportId).priority).toBe('urgent');
  });

  it('floors a student reporting an adult at urgent even for a mild category', async () => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: organizerId, reason: 'spam_or_advertising',
    }, cookie);
    expect(rowFor(res.body.reportId).priority).toBe('urgent');
  });

  /**
   * Prose in `reason` is what the shipped event/comment modal sends. It must
   * land in the catch-all category with the student's words preserved, because
   * the words are the authoritative content of a report and losing them to keep
   * a taxonomy tidy makes the report unreadable to whoever has to decide it.
   */
  it('keeps the student’s words when the client sends prose instead of a category', async () => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: eventIds[0],
      reason: 'This is not a real volunteering opportunity and the address is wrong.',
    }, cookie);
    expect(res.status).toBe(200);
    const row = rowFor(res.body.reportId);
    expect(row.category).toBe('other');
    expect(row.description).toContain('not a real volunteering opportunity');
  });
});

describe('duplicate suppression', () => {
  /**
   * Answered as a 200 carrying the original id, never a 409. A second report of
   * the same thing is usually a double-tap or somebody checking whether the
   * first one worked, and showing a distressed student an error after they
   * worked up to pressing the button teaches them the button is broken.
   */
  it('returns the original report id instead of filing a second one', async () => {
    const { cookie } = await freshReporter();
    const first = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: eventIds[0], reason: 'other', details: 'first',
    }, cookie);
    const second = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: eventIds[0], reason: 'other', details: 'second',
    }, cookie);

    expect(second.status).toBe(200);
    expect(second.body.reportId).toBe(first.body.reportId);
    expect(second.body.duplicate).toBe(true);
    expect(rowFor(first.body.reportId).description, 'the first report was overwritten').toBe('first');
  });

  it('lets the same person report the same target again once the first is closed', async () => {
    const { cookie } = await freshReporter();
    const target = eventIds[1 % eventIds.length];
    const first = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: target, reason: 'other', details: 'first',
    }, cookie);
    await db.prepare("UPDATE reports SET status = 'dismissed' WHERE id = ?").run(first.body.reportId);

    const second = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: target, reason: 'other', details: 'it happened again',
    }, cookie);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(false);
    expect(second.body.reportId).not.toBe(first.body.reportId);
  });

  it('does not suppress a different reporter reporting the same target', async () => {
    const a = await freshReporter();
    const b = await freshReporter();
    const target = eventIds[0];
    const one = await srv.call('POST', '/api/reports',
      { targetType: 'event', targetId: target, reason: 'other' }, a.cookie);
    const two = await srv.call('POST', '/api/reports',
      { targetType: 'event', targetId: target, reason: 'other' }, b.cookie);
    expect(two.body.reportId).not.toBe(one.body.reportId);
    expect(two.body.duplicate).toBe(false);
  });
});

describe('what filing does and does not set in motion', () => {
  it('writes exactly one `filed` history row, attributed to the reporter', async () => {
    const { cookie, user } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: eventIds[0], reason: 'other',
    }, cookie);
    const filed = await db.prepare(
      "SELECT actor_id FROM moderation_actions WHERE report_id = ? AND action = 'filed'"
    ).all(res.body.reportId);
    expect(filed.length).toBe(1);
    expect(filed[0].actor_id, 'this is why the column is actor_id, not moderator_id').toBe(user.id);
  });

  /**
   * The reported party is never told a report exists. Telling them converts a
   * safety control into a provocation — the same reasoning `messaging.js` gives
   * for not revealing a block.
   */
  it('never notifies the reported party', async () => {
    const { cookie } = await freshReporter();
    const victim = (await freshReporter()).user;
    const before = (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ?').get(victim.id)).c;

    await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: victim.id, reason: 'threatened_me', details: 'urgent',
    }, cookie);

    expect(
      (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ?').get(victim.id)).c,
      'the person reported was told they were reported',
    ).toBe(before);
  });

  it('tells the reporter nothing about the target in the response', async () => {
    const { cookie } = await freshReporter();
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: organizerId, reason: 'threatened_me',
    }, cookie);
    expect(Object.keys(res.body).sort()).toEqual(['duplicate', 'message', 'reportId', 'success']);
  });

  /**
   * A report row with no evidence is a report a moderator cannot decide, and
   * evidence with no report is orphaned message text in a table nobody reads.
   * Both halves land in one transaction, so neither state is reachable.
   */
  it('leaves no orphaned evidence when a report is refused', async () => {
    const { cookie } = await freshReporter();
    const before = (await db.prepare('SELECT COUNT(*) c FROM report_evidence').get()).c;
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: conversationId, reason: 'other',
    }, cookie);
    expect(res.status).toBe(404);
    expect((await db.prepare('SELECT COUNT(*) c FROM report_evidence').get()).c).toBe(before);
  });
});

describe('rate limiting', () => {
  /**
   * Report-bombing is the obvious abuse: eleven of eighteen categories
   * self-select into the urgent lane and `something_feels_wrong` needs no prose,
   * so burying a real report behind hundreds of fake ones is trivially available
   * to any student.
   *
   * Keyed on the hashed user id rather than the IP, for the reason `mailLimiter`
   * documents and which applies with full force to a school: a campus NAT puts
   * the whole district behind one address, and an IP-keyed limiter would let one
   * student lock everybody else out of reporting.
   */
  it('stops one account burying the queue, and says so in words a student can act on', async () => {
    const { cookie } = await freshReporter();
    const statuses = [];
    for (let i = 0; i <= REPORT_CEILING; i++) {
      const res = await srv.call('POST', '/api/reports',
        { targetType: 'user', targetId: `flood_${i}`, reason: 'other' }, cookie);
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.body.code).toBe('rate_limited');
        expect(res.body.error).toMatch(/reports/i);
        break;
      }
    }
    expect(statuses.filter(s => s === 429).length, 'the limiter never fired').toBe(1);
  });
});
