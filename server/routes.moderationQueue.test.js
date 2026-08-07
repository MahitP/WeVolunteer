/**
 * Working a report: who may, what it costs them to decide, and what it records.
 *
 * ── Why this file exists ──
 *
 * `PATCH /api/admin/reports/:id` grew from "accepts a status" to "accepts a
 * status, a priority, an assignee, a resolution and a resolution note, and
 * refuses a conflict of interest" with no test of its own. The conflict-of-
 * interest rule in particular is the only thing standing between a moderator and
 * dismissing a report about themselves, and on a two-person team that is the
 * refusal most likely to matter and least likely to be exercised by hand.
 *
 * ── The `FIXED — was:` headers ──
 *
 * Nine cases below open with one. They were written as `it.fails` — green while the
 * defect was present, red the moment somebody fixed it — because a defect recorded
 * as a passing characterization test quietly becomes the specification, and a defect
 * left untested is a defect nobody is holding.
 *
 * All nine have since been fixed and the `.fails` markers removed, so every one of
 * these now asserts correct behaviour and passes. The descriptions are kept, and
 * relabelled, because each one records WHY the assertion is worth making — a
 * resolution note of "1.0", a history row with no actor, a queue claiming no copy
 * was kept about a report holding hundreds of preserved messages. Deleting them
 * would leave nine assertions that look arbitrary.
 *
 * They read as live defects until this pass, which is its own small hazard: the
 * header promised six `it.fails` cases that no longer existed, so the file described
 * the code as broken in nine ways it is not.
 *
 * Every one was reproduced against a running server in this file, not inferred from
 * reading.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db, eventIds, organizerId, organizerEmail;

let seq = 0;
async function freshReporter() {
  seq += 1;
  return srv.signupConfirmed({
    email: `queue${seq}@test.local`, password: 'QueuePass123!',
    name: `Queue ${seq}`, username: `queueuser${seq}`, role: 'student', grade: '11',
  });
}

const adminToken = () => srv.login('admin@example.gov');
const rowFor = (id) => db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
const historyFor = (id) => db.prepare(
  'SELECT * FROM moderation_actions WHERE report_id = ? ORDER BY created_at, rowid'
).all(id);

/** Files a report from somebody with no other involvement, and returns its id. */
async function fileReport(overrides = {}) {
  const { cookie } = await freshReporter();
  const res = await srv.call('POST', '/api/reports', {
    targetType: 'event', targetId: eventIds[0], reason: 'other', details: 'something',
    ...overrides,
  }, cookie);
  if (!res.body?.reportId) throw new Error(`fileReport: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.reportId;
}

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;
  eventIds = db.prepare('SELECT id FROM events ORDER BY id').all().map(r => r.id);
  const org = db.prepare("SELECT id, email FROM users WHERE role = 'organizer' LIMIT 1").get();
  organizerId = org.id;
  organizerEmail = org.email;
});
afterAll(async () => { await srv.close(); });

describe('who may work the queue', () => {
  it('refuses every moderation route to a student, an organizer and a stranger', async () => {
    const reportId = await fileReport();
    const student = (await freshReporter()).cookie;
    const organizer = await srv.login(organizerEmail);

    for (const [who, token, expected] of [
      ['a student', student, 403],
      ['an organizer', organizer, 403],
      ['nobody at all', undefined, 401],
    ]) {
      expect((await srv.call('GET', '/api/admin/reports', undefined, token)).status,
        `${who} could read the queue`).toBe(expected);
      expect((await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'reviewing' }, token)).status,
        `${who} could change a report`).toBe(expected);
      expect((await srv.call('GET', `/api/admin/reports/${reportId}/evidence`, undefined, token)).status,
        `${who} could read preserved private messages`).toBe(expected);
    }
  });

  it('lets an uninvolved admin read the queue and work a report', async () => {
    const reportId = await fileReport();
    const a = await adminToken();
    expect((await srv.call('GET', '/api/admin/reports', undefined, a)).status).toBe(200);
    expect((await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'reviewing' }, a)).status)
      .toBe(200);
    expect(rowFor(reportId).status).toBe('reviewing');
  });

  it('404s a report that does not exist rather than reporting success', async () => {
    const res = await srv.call('PATCH', '/api/admin/reports/rep_nope', { status: 'reviewing' }, await adminToken());
    expect(res.status).toBe(404);
  });
});

describe('conflict of interest', () => {
  /**
   * A moderator resolving a report about themselves is the single self-dealing
   * move this surface makes available, and it is available to every one of the
   * handful of accounts that hold `report.resolve`.
   */
  it('refuses a moderator acting on a report whose subject is themselves', async () => {
    const { cookie } = await freshReporter();
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get().id;
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: adminId, reason: 'threatened_me', details: 'about the moderator',
    }, cookie);

    const res = await srv.call('PATCH', `/api/admin/reports/${filed.body.reportId}`, {
      status: 'resolved', resolution: 'no_action', resolutionNote: 'x'.repeat(25),
    }, await adminToken());

    expect(res.status).toBe(403);
    expect(rowFor(filed.body.reportId).status, 'the refusal did not prevent the write').toBe('open');
  });

  /** The reporter is a party too: closing your own report is deciding your own case. */
  it('refuses a moderator resolving a report they filed themselves', async () => {
    const a = await adminToken();
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'event', targetId: eventIds[1 % eventIds.length], reason: 'other', details: 'admin filed this',
    }, a);

    const res = await srv.call('PATCH', `/api/admin/reports/${filed.body.reportId}`, {
      status: 'resolved', resolution: 'no_action', resolutionNote: 'y'.repeat(25),
    }, a);
    expect(res.status).toBe(403);
  });

  it('refuses a moderator acting on a report about their own event', async () => {
    // Promote the organizer so they hold report.resolve while still owning the event.
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(organizerId);
    try {
      const { cookie } = await freshReporter();
      const filed = await srv.call('POST', '/api/reports', {
        targetType: 'event', targetId: eventIds[0], reason: 'other', details: 'their own event',
      }, cookie);
      const res = await srv.call('PATCH', `/api/admin/reports/${filed.body.reportId}`, {
        status: 'dismissed', resolution: 'no_action', resolutionNote: 'z'.repeat(25),
      }, await srv.login(organizerEmail));
      expect(res.status).toBe(403);
    } finally {
      db.prepare("UPDATE users SET role = 'organizer' WHERE id = ?").run(organizerId);
    }
  });

  /**
   * Reading is allowed. A moderator has to be able to see what was said about
   * them; it is deciding it that they may not do.
   */
  it('still lets the subject read the queue containing a report about them', async () => {
    const { cookie } = await freshReporter();
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get().id;
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: adminId, reason: 'hate_or_discrimination',
    }, cookie);

    const q = await srv.call('GET', '/api/admin/reports', undefined, await adminToken());
    expect(q.status).toBe(200);
    expect(q.body.some(r => r.id === filed.body.reportId)).toBe(true);
  });

  /**
   * FIXED — was: the refusal has no escalation path.
   *
   * The specification says the conflict refusal escalates to a principal holding
   * `admin.create` (super_admin), and that only when the super_admin is
   * themselves the subject is there deliberately no on-platform route. Today the
   * refusal is a flat `reporter_id === me || target_author_id === me` with no
   * cascade at all, so a report naming the only admin cannot be resolved by
   * anybody — including a super_admin. On a one-to-two-person team that is a
   * report stuck open for ever, holding a delete hold on the reported party's
   * events and a retention hold on their account, with no way to clear it short
   * of editing the database.
   *
   * The fix is a cascade ordered most-privileged-first ending in an explicit
   * deny, per `server/authz.js`'s header — `can()` is true for every capability
   * a super_admin asks about, so a chain of `else if (can(...))` is not mutually
   * exclusive.
   */
  it('lets a super_admin decide a report the ordinary admin is the subject of', async () => {
    const { cookie } = await freshReporter();
    const adminRow = db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get();
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: adminRow.id, reason: 'threatened_me',
    }, cookie);

    db.prepare("UPDATE users SET role = 'super_admin' WHERE email = 'admin@example.gov'").run();
    try {
      const res = await srv.call('PATCH', `/api/admin/reports/${filed.body.reportId}`, {
        status: 'resolved', resolution: 'no_action', resolutionNote: 'w'.repeat(25),
      }, await adminToken());
      expect(res.status).toBe(200);
    } finally {
      db.prepare("UPDATE users SET role = 'admin' WHERE email = 'admin@example.gov'").run();
    }
  });
});

describe('resolving requires a stated reason', () => {
  /**
   * Two distinct codes, because they are two distinct mistakes: nothing was
   * chosen, versus nothing was explained. One code for both left a client unable
   * to say which field to point the moderator at.
   */
  it('refuses to close a report with no resolution', async () => {
    const reportId = await fileReport();
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'resolved' }, await adminToken());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('resolution_required');
    expect(res.body.allowed, 'the refusal should name the legal values').toContain('no_action');
    expect(rowFor(reportId).status).toBe('open');
  });

  /**
   * Twenty characters, mirroring `MIN_SUSPENSION_REASON`, and for the same
   * reason: the note is what an appeal is reviewed against, and "ok" is not
   * something a decision can be reviewed against a year later.
   */
  it('refuses a note under twenty characters and accepts one at twenty', async () => {
    const short = await fileReport();
    const shortRes = await srv.call('PATCH', `/api/admin/reports/${short}`, {
      status: 'resolved', resolution: 'no_action', resolutionNote: 'x'.repeat(19),
    }, await adminToken());
    expect(shortRes.status).toBe(400);
    expect(shortRes.body.code).toBe('resolution_note_required');

    const ok = await fileReport({ targetId: eventIds[1 % eventIds.length] });
    const okRes = await srv.call('PATCH', `/api/admin/reports/${ok}`, {
      status: 'resolved', resolution: 'content_removed', resolutionNote: 'x'.repeat(20),
    }, await adminToken());
    expect(okRes.status).toBe(200);
    const row = rowFor(ok);
    expect(row.resolution).toBe('content_removed');
    expect(row.resolved_by, 'stamped server-side, never accepted from the client').toBeTruthy();
    expect(row.resolved_at).toBeTruthy();
  });

  it('refuses an invalid status and an invalid priority before touching the row', async () => {
    const reportId = await fileReport();
    const a = await adminToken();
    expect((await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'closed' }, a)).status).toBe(400);
    expect((await srv.call('PATCH', `/api/admin/reports/${reportId}`, { priority: 'critical' }, a)).status).toBe(400);
    expect(rowFor(reportId).status).toBe('open');
  });

  it('lets a moderator raise and lower priority, leaving a record', async () => {
    const reportId = await fileReport();
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, { priority: 'urgent' }, await adminToken());
    expect(res.status).toBe(200);
    expect(rowFor(reportId).priority).toBe('urgent');
  });

  /**
   * FIXED — was: the twenty-character minimum is bypassable with a non-string.
   *
   * The check is `!resolutionNote || resolutionNote.length < 20`. A number has no
   * `.length`, so `undefined < 20` is false and the guard passes: `resolutionNote: 1`
   * closes a report with a resolution note of "1.0". The one field an appeal is
   * reviewed against can be filled with a single digit by a client that sends
   * JSON rather than a form.
   *
   * Fix: require `typeof resolutionNote === 'string'` before measuring it, and
   * answer 400 otherwise — the same shape `createReport` already uses for
   * `targetId`.
   */
  it('refuses a numeric resolution note instead of coercing it', async () => {
    const reportId = await fileReport();
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, {
      status: 'resolved', resolution: 'no_action', resolutionNote: 1,
    }, await adminToken());
    expect(res.status).toBe(400);
  });

  /**
   * FIXED — was: a non-string resolution note that SQLite cannot bind is a 500.
   *
   * `resolutionNote: true` reaches `node:sqlite`, which refuses to bind a
   * boolean, and the handler's catch turns a malformed client payload into
   * "Failed to update report". Same class of bug `routes.malformed.test.js`
   * exists to keep out, on the moderation surface.
   */
  it('answers 400, not 500, for a boolean resolution note', async () => {
    const reportId = await fileReport();
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, {
      status: 'resolved', resolution: 'no_action', resolutionNote: true,
    }, await adminToken());
    expect(res.status).toBe(400);
  });

  /**
   * FIXED — was: `resolution` is never checked against its enum.
   *
   * The value goes straight into the UPDATE and the table's CHECK constraint
   * rejects it, so a typo'd resolution is a 500 rather than a 400 naming the
   * seven legal values. Every other enum on this route is validated in the
   * handler; this one is not.
   */
  it('refuses an unknown resolution with a 400 rather than a constraint failure', async () => {
    const reportId = await fileReport();
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, {
      status: 'resolved', resolution: 'made_up_value', resolutionNote: 'x'.repeat(25),
    }, await adminToken());
    expect(res.status).toBe(400);
  });
});

describe('assignment', () => {
  /**
   * FIXED — was: `assignedTo` is written unvalidated.
   *
   * The specification says it may be `null`, `'me'`, or the id of somebody who
   * holds `report.resolve`. Today it is bound straight into the UPDATE: `'me'`
   * and any unknown id both hit the `REFERENCES users(id)` constraint and come
   * back as 500, and a real user id that holds no moderation capability would be
   * accepted. `assigned_at` is never written at all, so "since when" has no
   * answer.
   */
  it('resolves "me" to the calling moderator', async () => {
    const reportId = await fileReport();
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`, { assignedTo: 'me' }, await adminToken());
    expect(res.status).toBe(200);
    const row = rowFor(reportId);
    expect(row.assigned_to).toBe(db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get().id);
    expect(row.assigned_at, 'unassigned and assigned-at-an-unknown-time are different states').toBeTruthy();
  });

  it('refuses an assignee who does not exist with a 400, not a 500', async () => {
    const reportId = await fileReport();
    const res = await srv.call('PATCH', `/api/admin/reports/${reportId}`,
      { assignedTo: 'user_does_not_exist' }, await adminToken());
    expect(res.status).toBe(400);
  });

  it('accepts a real moderator id and accepts null to unassign', async () => {
    const reportId = await fileReport();
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get().id;
    const a = await adminToken();

    // Filed by somebody else and about somebody else, so no conflict fires.
    expect((await srv.call('PATCH', `/api/admin/reports/${reportId}`, { assignedTo: adminId }, a)).status).toBe(200);
    expect(rowFor(reportId).assigned_to).toBe(adminId);

    expect((await srv.call('PATCH', `/api/admin/reports/${reportId}`, { assignedTo: null }, a)).status).toBe(200);
    expect(rowFor(reportId).assigned_to).toBeNull();
  });
});

describe('what a decision records', () => {
  it('writes both an admin_audit_logs row and a moderation_actions row', async () => {
    const reportId = await fileReport();
    const beforeAudit = db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'MODERATE_REPORT'"
    ).get().c;

    await srv.call('PATCH', `/api/admin/reports/${reportId}`, {
      status: 'resolved', resolution: 'no_action', resolutionNote: 'decided because '.repeat(2),
    }, await adminToken());

    expect(db.prepare("SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'MODERATE_REPORT'").get().c)
      .toBe(beforeAudit + 1);
    const history = historyFor(reportId);
    expect(history.some(h => h.actor_id && h.new_status === 'resolved'),
      'no attributed history row for the decision').toBe(true);
  });

  /**
   * `moderation_actions` is append-only at the DATABASE, not by convention. A
   * test asserting it checks the code path somebody wrote; a trigger checks every
   * path anybody ever writes, including a `bin/` script.
   */
  it('cannot have its history edited or deleted, by any path', () => {
    const row = db.prepare('SELECT id FROM moderation_actions LIMIT 1').get();
    expect(row, 'no history to test against').toBeTruthy();
    expect(() => db.prepare("UPDATE moderation_actions SET action = 'x' WHERE id = ?").run(row.id))
      .toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM moderation_actions WHERE id = ?').run(row.id))
      .toThrow(/append-only/);
    expect(db.prepare('SELECT COUNT(*) c FROM moderation_actions WHERE id = ?').get(row.id).c).toBe(1);
  });

  it('refuses to delete a report at all', async () => {
    const reportId = await fileReport();
    expect(() => db.prepare('DELETE FROM reports WHERE id = ?').run(reportId))
      .toThrow(/never deleted/);
  });

  it('refuses to edit what a report says, while allowing its workflow to move', async () => {
    const reportId = await fileReport();
    expect(() => db.prepare("UPDATE reports SET description = 'rewritten' WHERE id = ?").run(reportId))
      .toThrow(/record of what was said/);
    expect(() => db.prepare("UPDATE reports SET category = 'other' WHERE id = ?").run(reportId))
      .toThrow(/record of what was said/);
    expect(() => db.prepare("UPDATE reports SET status = 'reviewing' WHERE id = ?").run(reportId))
      .not.toThrow();
  });

  /**
   * FIXED — was: every status change writes two history rows, one anonymous.
   *
   * Migration 012's `reports_audit` trigger fires AFTER UPDATE and inserts an
   * `action='updated'` row with a NULL `actor_id`; the route then inserts its own
   * `action='update'` row naming the actor. So the append-only history a district
   * reads a year later shows each decision twice, once by nobody, and the two
   * spellings differ by a single letter.
   *
   * Fix: pick one writer. The trigger is the durable one (it catches every path,
   * which is why it exists) but it cannot know the actor; the route knows the
   * actor but only covers itself. The trigger should stay and the route's
   * duplicate insert should go, with the actor carried some other way — or the
   * trigger should be narrowed to paths the route does not cover.
   */
  it('writes one history row per status change, not two', async () => {
    const reportId = await fileReport();
    const before = historyFor(reportId).length;
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'reviewing' }, await adminToken());
    expect(historyFor(reportId).length - before).toBe(1);
  });

  /**
   * FIXED — was: `updated_at` is written once, at insert, and never again.
   *
   * The column exists, is NOT NULL, and is set to `created_at` when the report is
   * filed. No `PATCH` ever moves it, so "when did this last change" is
   * unanswerable from the row and any queue ordering or staleness check built on
   * it would be reading the filing time.
   */
  it('moves updated_at when the report changes', async () => {
    const reportId = await fileReport();
    const before = rowFor(reportId).updated_at;
    await new Promise(r => setTimeout(r, 20));
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'reviewing' }, await adminToken());
    expect(rowFor(reportId).updated_at).not.toBe(before);
  });

  /**
   * FIXED — was: reopening leaves the previous resolution in place.
   *
   * `resolved` -> `open` is allowed, and correctly so: a reopen is a real
   * moderation act. But `resolution`, `resolution_note`, `resolved_by` and
   * `resolved_at` are all left exactly as they were, so a reopened report reads
   * as open AND resolved by a named person at a named time. A moderator picking
   * it up sees a decision that has been withdrawn.
   */
  it('clears the resolution when a report is reopened', async () => {
    const reportId = await fileReport();
    const a = await adminToken();
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, {
      status: 'resolved', resolution: 'content_removed', resolutionNote: 'r'.repeat(25),
    }, a);
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'open' }, a);

    const row = rowFor(reportId);
    expect(row.status).toBe('open');
    expect(row.resolution).toBeNull();
    expect(row.resolved_by).toBeNull();
  });
});

describe('the queue a moderator actually reads', () => {
  /**
   * The LEFT JOIN regression test.
   *
   * `reporter_id` is nullable since the cascade that destroyed a reporter's own
   * safety report was severed. An inner join here would make those reports vanish
   * from the queue instead — the quietest possible failure, and the one a
   * moderator cannot notice, because nothing renders to say anything is missing.
   */
  it('still shows a report whose reporter has been purged, named from the snapshot', async () => {
    const reportId = await fileReport({ details: 'filed by somebody now gone' });
    const snapshot = rowFor(reportId).reporter_name_snapshot;
    db.prepare('UPDATE reports SET reporter_id = NULL WHERE id = ?').run(reportId);

    const q = await srv.call('GET', '/api/admin/reports', undefined, await adminToken());
    const row = q.body.find(r => r.id === reportId);
    expect(row, 'the report vanished from the queue').toBeTruthy();
    // The snapshot is taken at report time and is what survives the live join
    // returning nothing. The literal below it covers reports filed before the
    // snapshot column existed.
    expect(row.reporter_name).toBe(snapshot);
    expect(row.reporter_email, 'no live account, so nothing to contact').toBeFalsy();
  });

  /**
   * A report filed before the snapshot column existed. Inserted rather than
   * updated: `reports_immutable` refuses to edit `reporter_name_snapshot`, which
   * is the whole point of that trigger, so the only way to reach this state is to
   * be a row that never had one.
   */
  it('falls back to the literal when there is no snapshot either', async () => {
    const id = 'rep_pre_snapshot';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO reports (id, reporter_id, reporter_name_snapshot, target_type, target_id,
                           category, description, status, priority, created_at, updated_at)
      VALUES (?, NULL, NULL, 'event', ?, 'other', 'filed long ago', 'open', 'normal', ?, ?)
    `).run(id, eventIds[0], now, now);

    const q = await srv.call('GET', '/api/admin/reports', undefined, await adminToken());
    expect(q.body.find(r => r.id === id).reporter_name).toBe('Account since deleted');
  });

  it('carries the evidence count so a moderator knows there is something to read', async () => {
    const { cookie, user } = await freshReporter();
    const convId = 'conv_queue_evidence';
    const base = Date.now() - 3600_000;
    db.prepare(`INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(convId, eventIds[0], user.id, organizerId, organizerId, new Date(base).toISOString());
    for (const [uid, role] of [[user.id, 'student'], [organizerId, 'organizer']]) {
      db.prepare(`INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
                  VALUES (?, ?, ?, ?)`).run(convId, uid, role, new Date(base).toISOString());
    }
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(`qm_${i}`, convId, organizerId, `body ${i}`, new Date(base + i * 1000).toISOString());
    }

    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'asked_to_meet_alone',
    }, cookie);
    const q = await srv.call('GET', '/api/admin/reports', undefined, await adminToken());
    expect(q.body.find(r => r.id === filed.body.reportId).evidence_count).toBe(5);
  });

  /**
   * FIXED — was: the queue enriches only `event` and `comment` targets.
   *
   * The enrichment loop looks the target up in `events` for an event and in
   * `event_comments` for everything else. A conversation, message, user,
   * announcement or certificate report therefore finds no live row and no
   * `target_body_snapshot`, so it is flagged `target_missing` and the dashboard
   * renders "No copy of this was kept — it was deleted before reports were
   * preserved."
   *
   * That sentence is false, and it is false about the report type this whole
   * release exists to make visible: the evidence IS kept — 25 frozen message
   * bodies in `report_evidence` and a populated `target_name_snapshot` — and the
   * queue is telling the moderator it is gone.
   *
   * Fix: extend the switch to all seven target types and fall back to
   * `target_name_snapshot` before concluding anything is missing.
   */
  it('does not tell a moderator that a preserved conversation was never kept', async () => {
    const { cookie, user } = await freshReporter();
    const convId = 'conv_queue_render';
    const base = Date.now() - 3600_000;
    db.prepare(`INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(convId, eventIds[0], user.id, organizerId, organizerId, new Date(base).toISOString());
    for (const [uid, role] of [[user.id, 'student'], [organizerId, 'organizer']]) {
      db.prepare(`INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
                  VALUES (?, ?, ?, ?)`).run(convId, uid, role, new Date(base).toISOString());
    }
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
                VALUES (?, ?, ?, ?, ?)`)
      .run('qr_0', convId, organizerId, 'meet me alone', new Date(base).toISOString());

    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: convId, reason: 'asked_to_meet_alone',
    }, cookie);
    const q = await srv.call('GET', '/api/admin/reports', undefined, await adminToken());
    const row = q.body.find(r => r.id === filed.body.reportId);

    expect(row.target_missing, 'the queue claims preserved evidence was never kept').toBe(false);
    expect(row.target_title, 'nothing identifies what was reported').toBeTruthy();
  });
});

describe('queue ordering and filters', () => {
  /**
   * Urgent first, then oldest first — the opposite of what a feed does, and
   * deliberately. Newest-first starves the oldest unanswered report, which is by
   * construction the one most likely to be a real harm nobody answered, and
   * "reaches a human within one business day" is a promise about the oldest item.
   */
  it('puts urgent reports above normal ones and the oldest first within each', async () => {
    const q = await srv.call('GET', '/api/admin/reports?status=all', undefined, await adminToken());
    expect(q.status).toBe(200);

    const live = q.body.filter(r => ['open', 'reviewing', 'escalated'].includes(r.status));
    const closed = q.body.filter(r => ['resolved', 'dismissed'].includes(r.status));

    // Live work sorts above finished work, so working the queue never means
    // scrolling past what is already done.
    if (live.length && closed.length) {
      expect(q.body.indexOf(live[live.length - 1])).toBeLessThan(q.body.indexOf(closed[0]));
    }

    let seenNormal = false;
    let previousCreatedAt = null;
    let previousPriority = null;
    for (const r of live) {
      if (r.priority === 'normal') seenNormal = true;
      else expect(seenNormal, 'an urgent report sorted below a normal one').toBe(false);
      if (previousPriority === r.priority) {
        expect(r.created_at >= previousCreatedAt, 'newer sorted above older').toBe(true);
      }
      previousPriority = r.priority;
      previousCreatedAt = r.created_at;
    }
  });

  /**
   * `reviewing` and `escalated` used to sort below resolved reports, so picking a
   * report up pushed it out of sight — the surest way to lose the one somebody
   * had decided was worth their attention.
   */
  it('keeps a report visible after a moderator starts reviewing it', async () => {
    const reportId = await fileReport({ targetId: eventIds[1 % eventIds.length] });
    const a = await adminToken();
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, { status: 'reviewing' }, a);

    const q = await srv.call('GET', '/api/admin/reports', undefined, a);
    const row = q.body.find(r => r.id === reportId);
    expect(row, 'the report vanished from the default queue once picked up').toBeTruthy();
    expect(row.status).toBe('reviewing');
  });

  it('defaults to live work and can be asked for closed reports', async () => {
    const reportId = await fileReport();
    const a = await adminToken();
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, {
      status: 'dismissed', resolution: 'no_action', resolutionNote: 'f'.repeat(25),
    }, a);

    const live = await srv.call('GET', '/api/admin/reports', undefined, a);
    expect(live.body.some(r => r.id === reportId), 'a closed report is still in the live queue')
      .toBe(false);

    const closed = await srv.call('GET', '/api/admin/reports?status=dismissed', undefined, a);
    expect(closed.body.some(r => r.id === reportId), 'a decision made last month is unreachable')
      .toBe(true);

    const all = await srv.call('GET', '/api/admin/reports?status=all', undefined, a);
    expect(all.body.some(r => r.id === reportId)).toBe(true);
  });

  /**
   * A mistyped filter must not silently return everything, or silently return
   * nothing. On this surface "I saw no open reports" is the wrong thing to be
   * wrong about.
   */
  it.each([
    ['status', 'reviewed', 'invalid_status_filter'],
    ['priority', 'critical', 'invalid_priority_filter'],
    ['category', 'made_up', 'invalid_category_filter'],
    ['targetType', 'group', 'invalid_target_type_filter'],
  ])('refuses an unknown %s filter rather than ignoring it', async (param, value, code) => {
    const res = await srv.call('GET', `/api/admin/reports?${param}=${value}`, undefined, await adminToken());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(res.body.allowed, 'the refusal should name the legal values').toBeTruthy();
  });

  it('filters by priority, category and target type', async () => {
    const a = await adminToken();

    const urgent = await srv.call('GET', '/api/admin/reports?priority=urgent&status=all', undefined, a);
    expect(urgent.status).toBe(200);
    expect(urgent.body.every(r => r.priority === 'urgent')).toBe(true);

    const spam = await srv.call('GET', '/api/admin/reports?category=spam_or_advertising&status=all', undefined, a);
    expect(spam.body.every(r => r.category === 'spam_or_advertising')).toBe(true);

    const events = await srv.call('GET', '/api/admin/reports?targetType=event&status=all', undefined, a);
    expect(events.body.every(r => r.target_type === 'event')).toBe(true);

    // `organizer` is an alias the client may still speak; it is stored as `user`.
    const organizers = await srv.call('GET', '/api/admin/reports?targetType=organizer&status=all', undefined, a);
    expect(organizers.body.every(r => r.target_type === 'user')).toBe(true);
  });

  it('filters by assignee, including me and unassigned', async () => {
    const reportId = await fileReport({ targetId: eventIds[1 % eventIds.length] });
    const a = await adminToken();
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get().id;
    await srv.call('PATCH', `/api/admin/reports/${reportId}`, { assignedTo: 'me' }, a);

    const mine = await srv.call('GET', '/api/admin/reports?assignee=me', undefined, a);
    expect(mine.body.some(r => r.id === reportId)).toBe(true);
    expect(mine.body.every(r => r.assigned_to === adminId)).toBe(true);

    const unassigned = await srv.call('GET', '/api/admin/reports?assignee=unassigned', undefined, a);
    expect(unassigned.body.some(r => r.id === reportId)).toBe(false);
    expect(unassigned.body.every(r => r.assigned_to === null)).toBe(true);
  });

  /** The whole dashboard for a one-person team: how much is waiting, and is any of it urgent. */
  it('reports counts that are not limited to the current filter', async () => {
    const res = await srv.call('GET', '/api/admin/reports?status=dismissed', undefined, await adminToken());
    const counts = JSON.parse(res.headers.get('x-report-counts'));
    expect(counts).toHaveProperty('open');
    expect(counts).toHaveProperty('urgentLive');
    expect(counts).toHaveProperty('assignedToMe');
    expect(counts.open, 'counts should describe the queue, not the filtered page')
      .toBeGreaterThan(0);
  });

  /**
   * Every target type has to render. Five of the seven used to find no live row
   * and no body snapshot, so the queue flagged them missing and the dashboard
   * said "No copy of this was kept" about reports holding preserved evidence.
   */
  it('renders a target label for every target type, and never claims evidence is missing', async () => {
    const { cookie, user } = await freshReporter();
    const convId = 'conv_queue_types';
    const base = Date.now() - 3600_000;
    db.prepare(`INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(convId, eventIds[0], user.id, organizerId, organizerId, new Date(base).toISOString());
    for (const [uid, role] of [[user.id, 'student'], [organizerId, 'organizer']]) {
      db.prepare(`INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
                  VALUES (?, ?, ?, ?)`).run(convId, uid, role, new Date(base).toISOString());
    }
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
                VALUES ('qt_0', ?, ?, 'a reported line', ?)`)
      .run(convId, organizerId, new Date(base).toISOString());

    const filed = {};
    const cases = [
      ['event', eventIds[0]],
      ['comment', db.prepare('SELECT id FROM event_comments LIMIT 1').get().id],
      ['announcement', db.prepare('SELECT id FROM event_announcements LIMIT 1').get().id],
      ['user', organizerId],
      ['certificate', 'WEV-A2B3-C4D5'],
      ['conversation', convId],
      ['message', 'qt_0'],
    ];
    for (const [type, id] of cases) {
      const res = await srv.call('POST', '/api/reports', {
        targetType: type, targetId: id, reason: 'something_feels_wrong',
      }, cookie);
      expect([200, 201], `${type} could not be filed: ${JSON.stringify(res.body)}`)
        .toContain(res.status);
      filed[type] = res.body.reportId;
    }

    const q = await srv.call('GET', '/api/admin/reports?status=all', undefined, await adminToken());
    for (const [type] of cases) {
      const row = q.body.find(r => r.id === filed[type]);
      expect(row, `${type} report is not in the queue`).toBeTruthy();
      expect(row.target_label ?? row.target_title,
        `a ${type} report renders with nothing identifying it`).toBeTruthy();
      if (row.evidence_count > 0) {
        expect(row.target_missing,
          `a ${type} report with ${row.evidence_count} preserved messages claims nothing was kept`)
          .toBe(false);
      }
    }
  });

  /**
   * A deleted target is an expected state — the snapshots exist because a report
   * outlives the thing it is about — and it must render rather than crash.
   */
  it('renders a report whose target and whose reporter are both gone', async () => {
    const { cookie } = await freshReporter();
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: 'user_deleted_long_ago', reason: 'pretending_to_be_someone',
    }, cookie);

    const q = await srv.call('GET', '/api/admin/reports', undefined, await adminToken());
    const row = q.body.find(r => r.id === filed.body.reportId);
    expect(row, 'a report against an unknown account crashed the queue').toBeTruthy();
    expect(row.target_exists).toBe(false);
  });
});

describe('reading preserved evidence', () => {
  async function reportedConversation(id) {
    const { cookie, user } = await freshReporter();
    const base = Date.now() - 3600_000;
    db.prepare(`INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, eventIds[0], user.id, organizerId, organizerId, new Date(base).toISOString());
    for (const [uid, role] of [[user.id, 'student'], [organizerId, 'organizer']]) {
      db.prepare(`INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
                  VALUES (?, ?, ?, ?)`).run(id, uid, role, new Date(base).toISOString());
    }
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(`${id}_m${i}`, id, organizerId, `evidence body ${i}`, new Date(base + i * 1000).toISOString());
    }
    const filed = await srv.call('POST', '/api/reports', {
      targetType: 'conversation', targetId: id, reason: 'asked_to_meet_alone',
    }, cookie);
    return filed.body.reportId;
  }

  /**
   * The Youth Safety Guidelines promise, in print: "This is the one situation in
   * which an administrator reads private messages, and it is logged." Until this
   * route existed the sentence described something that could not happen, so it
   * was not logged either.
   */
  it('returns the frozen bodies and logs who read them', async () => {
    const reportId = await reportedConversation('conv_evidence_read');
    const before = db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'"
    ).get().c;

    const res = await srv.readEvidence(await adminToken(), reportId);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBe(3);
    expect(res.body.messages[0].body).toContain('evidence body');
    expect(res.body.messages[0].sender_name).toBeTruthy();

    expect(
      db.prepare("SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'").get().c,
      'private messages left the building without a record of who read them',
    ).toBe(before + 1);
  });

  it('404s an evidence read for a report that does not exist', async () => {
    const res = await srv.readEvidence(await adminToken(), 'rep_nope');
    expect(res.status).toBe(404);
  });

  /**
   * The snapshot's own timestamp, alongside the message's.
   *
   * `created_at` is when the message was sent; `captured_at` is when the report
   * froze it. They are different facts and the difference is the one a moderator
   * needs: it is what distinguishes a preserved copy from a live read, and it is
   * the answer to "was this edited between being sent and being reported". The
   * column has existed since migration 013 and the route never selected it, so
   * the viewer had no way to say the words "preserved copy" honestly.
   */
  it('carries the capture time so the viewer can say when the copy was frozen', async () => {
    const reportId = await reportedConversation('conv_evidence_captured');
    const res = await srv.readEvidence(await adminToken(), reportId);

    expect(res.status).toBe(200);
    for (const message of res.body.messages) {
      expect(message.captured_at, 'no capture time, so "preserved" is unevidenced').toBeTruthy();
      expect(Number.isNaN(Date.parse(message.captured_at))).toBe(false);
    }
  });

  /**
   * The evidence read is recorded to the DURABLE trail as well.
   *
   * `admin_audit_logs` is swept at 365 days. `moderation_actions` is the
   * report-scoped, append-only trail and is exempt from the sweep — a district
   * asking "who read this student's messages" two years after a suspension gets
   * nothing from a table that was emptied on day 366.
   */
  it('records the evidence read on the durable report history too', async () => {
    const reportId = await reportedConversation('conv_evidence_history');
    await srv.readEvidence(await adminToken(), reportId);
    expect(historyFor(reportId).some(h => h.action === 'evidence_viewed')).toBe(true);
  });
});

/**
 * `GET /api/admin/reports/:id` — one report, with the trail of what was done to it.
 *
 * ── Why this endpoint exists ──
 *
 * `moderation_actions` was written on every decision and read back by nothing.
 * Every status change, reprioritisation, assignment, resolution, self-review and
 * evidence read has been recorded since v1.2, and the only way to see any of it
 * was to open the database by hand. So the append-only trail that exists to
 * answer "who decided this, and why" answered it to nobody, and a moderator
 * picking up a report had no way to know it had already been reviewed and
 * reopened.
 *
 * ── Why the evidence bodies are NOT in this response ──
 *
 * This route is gated on `report.resolve`; the bodies are gated on
 * `report.evidence.read`. `server/authz.js` splits those two capabilities
 * deliberately, so that a per-user grant can create a triage-only helper who
 * sorts the queue and never reads a student's private messages. Folding the
 * bodies into the detail response would collapse that split silently — the
 * helper would receive them on every open, and the separate capability would
 * still look like it was doing something.
 */
describe('report detail', () => {
  it('returns the report with its history, oldest first', async () => {
    const reportId = await fileReport();
    await srv.call('PATCH', `/api/admin/reports/${reportId}`,
      { status: 'reviewing' }, await adminToken());
    /**
     * Flipped rather than set to a literal. Priority is DERIVED at filing — a
     * student reporting an event an adult posted floors at `urgent` — so setting
     * it to `urgent` is frequently a no-op, and a no-op writes no history row.
     * The test would then be asserting the absence of a change it never made.
     */
    const flipped = rowFor(reportId).priority === 'urgent' ? 'normal' : 'urgent';
    await srv.call('PATCH', `/api/admin/reports/${reportId}`,
      { priority: flipped }, await adminToken());

    const res = await srv.call('GET', `/api/admin/reports/${reportId}`, undefined, await adminToken());
    expect(res.status).toBe(200);
    expect(res.body.report.id).toBe(reportId);
    expect(res.body.report.status).toBe('reviewing');

    const actions = res.body.history.map(h => h.action);
    expect(actions).toContain('status_changed');
    expect(actions).toContain('prioritised');
    // Oldest first: a timeline read top-to-bottom is the order things happened.
    expect(actions.indexOf('status_changed')).toBeLessThan(actions.indexOf('prioritised'));
  });

  /**
   * An anonymous history row says somebody changed this without saying who,
   * which is the single question the table exists to answer.
   */
  it('names who took each action', async () => {
    const reportId = await fileReport();
    await srv.call('PATCH', `/api/admin/reports/${reportId}`,
      { status: 'reviewing' }, await adminToken());

    const res = await srv.call('GET', `/api/admin/reports/${reportId}`, undefined, await adminToken());
    const row = res.body.history.find(h => h.action === 'status_changed');
    expect(row.actor_name).toBeTruthy();
    expect(row.created_at).toBeTruthy();
    expect(row.old_status).toBe('open');
    expect(row.new_status).toBe('reviewing');
  });

  it('carries the same target and reporter enrichment the queue does', async () => {
    const reportId = await fileReport();
    const res = await srv.call('GET', `/api/admin/reports/${reportId}`, undefined, await adminToken());

    // Same derived fields as the list, so one renderer serves both surfaces
    // rather than the detail view re-deriving them and disagreeing.
    expect(res.body.report.reporter_name).toBeTruthy();
    expect(res.body.report).toHaveProperty('target_label');
    expect(res.body.report).toHaveProperty('target_is_snapshot');
    expect(res.body.report).toHaveProperty('target_missing');
    expect(res.body.report).toHaveProperty('evidence_count');
  });

  it('never includes the evidence bodies, which are a separate capability', async () => {
    const reportId = await fileReport();
    const res = await srv.call('GET', `/api/admin/reports/${reportId}`, undefined, await adminToken());
    expect(res.body.messages).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('evidence body');
  });

  it('404s a report that does not exist', async () => {
    const res = await srv.call('GET', '/api/admin/reports/rep_nope', undefined, await adminToken());
    expect(res.status).toBe(404);
  });

  it('refuses a student, an organizer and a stranger', async () => {
    const { cookie: studentCookie } = await freshReporter();
    const reportId = await fileReport();

    for (const cookie of [studentCookie, await srv.login(organizerEmail), undefined]) {
      const res = await srv.call('GET', `/api/admin/reports/${reportId}`, undefined, cookie);
      expect([401, 403]).toContain(res.status);
    }
  });

  /**
   * Reading a report's own metadata is NOT logged, and that is a decision rather
   * than an omission: `GET /api/admin/reports` already returns every field this
   * route does, to the same capability, and logging one but not the other would
   * produce a trail that reads as complete and is not. The read that IS logged is
   * the one that discloses private message bodies, which is a different act.
   */
  it('does not log a metadata read as an evidence read', async () => {
    const reportId = await fileReport();
    const before = db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'"
    ).get().c;

    await srv.call('GET', `/api/admin/reports/${reportId}`, undefined, await adminToken());

    expect(db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'"
    ).get().c).toBe(before);
    expect(historyFor(reportId).some(h => h.action === 'evidence_viewed')).toBe(false);
  });

  /**
   * The evidence read DOES appear here, which is the point of showing the trail.
   *
   * "Who read this student's private messages" is the question a parent or a
   * district asks, and the timeline is where a moderator sees that somebody
   * already has.
   */
  it('shows an evidence read in the timeline', async () => {
    const reportId = await fileReport();
    await srv.readEvidence(await adminToken(), reportId);

    const res = await srv.call('GET', `/api/admin/reports/${reportId}`, undefined, await adminToken());
    expect(res.body.history.some(h => h.action === 'evidence_viewed')).toBe(true);
  });
});
