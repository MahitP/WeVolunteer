/**
 * HIGH-risk verification: decision lifecycle, the overturn remedy, and tokens.
 *
 * Companion to `appeals.adversarial.test.js`, which covers the CRITICAL set.
 * Same rule: every check is written to fail if the property stops holding, not
 * to pass if the feature still works.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db, reviewerEmail, reviewer2Email;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;
  const seeded = await db.prepare("SELECT password_hash FROM users WHERE id = 'user-admin'").get();

  reviewerEmail = 'life.reviewer@example.gov';
  reviewer2Email = 'life.reviewer2@example.gov';
  for (const [id, email, name, uname] of [
    ['life-rev-1', reviewerEmail, 'Lifecycle Reviewer', 'life_rev_1'],
    ['life-rev-2', reviewer2Email, 'Second Reviewer', 'life_rev_2'],
  ]) {
    /* A bound ISO-8601 timestamp, not `datetime('now')`. PostgreSQL has no such
       function, and `created_at` holds ISO-8601 everywhere else in this schema —
       SQLite's `2026-08-16 17:53:04` is the odd one out and sorts differently
       against it. */
    await db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, grade, username, email_verified,
                         account_status, created_at)
      VALUES (?, ?, ?, ?, 'admin', 'N/A', ?, 1, 'active', ?)
      ON CONFLICT DO NOTHING
    `).run(id, email, seeded.password_hash, name, uname, new Date().toISOString());
  }
});
afterAll(async () => { await srv.close(); });

const jf = (p, o = {}) => fetch(srv.base + p, {
  ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const asUser = (t) => ({ Cookie: `wev_session=${t}` });

let seq = 0;
async function makeUser() {
  const id = `life-user-${++seq}`;
  await db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username,
                       email_verified, account_status, created_at)
    VALUES (?, ?, 'h', ?, 'student', '9', ?, 1, 'active', ?)
  `).run(id, `${id}@example.com`, `Life Student ${seq}`, id.replace(/-/g, '_'), new Date().toISOString());
  return id;
}

async function suspendAndAppeal(adminT, uid, statement = 'I would like this looked at again please.') {
  await jf(`/api/admin/users/${uid}/suspend`, {
    method: 'POST', headers: asUser(adminT),
    body: JSON.stringify({ reason: 'Messaged a student off-platform after a clear warning.' }),
  });
  const token = (await db.prepare(
    'SELECT token FROM appeal_tokens WHERE user_id = ? AND used_at IS NULL ORDER BY expires_at DESC'
  ).get(uid))?.token;
  await jf(`/api/appeals/token/${token}`, { method: 'POST', body: JSON.stringify({ statement }) });
  const appeal = await db.prepare('SELECT id FROM appeals WHERE user_id = ? ORDER BY created_at DESC').get(uid);
  return { token, appealId: appeal.id };
}

const decide = (t, id, decision, reasoning) => jf(`/api/admin/appeals/${id}`, {
  method: 'PATCH', headers: asUser(t), body: JSON.stringify({ decision, reasoning }),
});

/* ── 1. Decision lifecycle ────────────────────────────────────────────────── */

describe('an appeal is decided once, and changed only by an audited reopen', () => {
  it('refuses a second decision on a decided appeal', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    const first = await decide(revT, appealId, 'stands', 'The evidence supports the original action.');
    expect(first.status, (await first.clone()).text()).toBe(200);

    // upheld -> overturned attempt
    const second = await decide(revT, appealId, 'reversed', 'Actually I have changed my mind entirely.');
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('already_decided');

    const row = await db.prepare('SELECT decision, status FROM appeals WHERE id = ?').get(appealId);
    expect(row.decision, 'a decided appeal was silently re-decided').toBe('stands');
    expect(row.status).toBe('resolved');
  });

  it('refuses repeated identical PATCHes after the first', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    const results = [];
    for (let i = 0; i < 3; i++) {
      const r = await decide(revT, appealId, 'stands', 'The original action was correct on the facts.');
      results.push(r.status);
    }
    expect(results[0]).toBe(200);
    expect(results.slice(1), 'a repeated PATCH re-decided the appeal').toEqual([409, 409]);

    // Exactly one 'decided' event, whatever the client did.
    const decided = (await db.prepare(
      "SELECT COUNT(*) c FROM appeal_events WHERE appeal_id = ? AND action = 'decided'"
    ).get(appealId)).c;
    expect(decided, 'more than one decision was written to the history').toBe(1);
  });

  it('survives concurrent decision attempts with a single recorded outcome', async () => {
    /**
     * The read that decides `already_decided` is outside the write transaction,
     * so this is a time-of-check/time-of-use shape on paper. It holds because
     * the handler is synchronous from that read through `inTransaction` — there
     * is no `await` between them, so a second request cannot interleave inside a
     * single-process Node server. That is a property of the handler's shape
     * rather than of a lock, which is exactly why it is worth an explicit test:
     * inserting one `await` in the wrong place would silently break it.
     */
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    const settled = await Promise.all([
      decide(revT, appealId, 'stands', 'Concurrent attempt number one, with enough characters.'),
      decide(revT, appealId, 'reversed', 'Concurrent attempt number two, with enough characters.'),
      decide(revT, appealId, 'stands', 'Concurrent attempt number three, with enough characters.'),
    ]);
    const codes = settled.map(r => r.status).sort();
    expect(codes, 'more than one concurrent decision was accepted').toEqual([200, 409, 409]);

    expect((await db.prepare(
      "SELECT COUNT(*) c FROM appeal_events WHERE appeal_id = ? AND action = 'decided'"
    ).get(appealId)).c).toBe(1);
  });

  it('reopen is the only route back, is audited, and disqualifies the reopener', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const rev2T = await srv.login(reviewer2Email);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    await decide(revT, appealId, 'stands', 'Upheld on the evidence available at the time.');

    const reopened = await jf(`/api/admin/appeals/${appealId}/reopen`, {
      method: 'POST', headers: asUser(rev2T),
      body: JSON.stringify({ reason: 'New evidence arrived from the school that changes this.' }),
    });
    expect(reopened.status, (await reopened.clone()).text()).toBe(200);
    expect((await db.prepare('SELECT status FROM appeals WHERE id = ?').get(appealId)).status).toBe('reviewing');

    // Audited immutably, in both trails.
    expect((await db.prepare(
      "SELECT COUNT(*) c FROM appeal_events WHERE appeal_id = ? AND action = 'reopened'"
    ).get(appealId)).c).toBe(1);
    expect((await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'APPEAL_REOPENED' AND details LIKE ?"
    ).get(`%${appealId}%`)).c).toBeGreaterThan(0);

    // Whoever reopened cannot then decide it — reopening costs you the decision.
    const byReopener = await decide(rev2T, appealId, 'reversed', 'Now deciding the case I reopened.');
    expect(byReopener.status, 'the reopener decided their own reopen').toBe(403);
    expect((await byReopener.json()).conflicts).toContain('reopener');

    // A third party can.
    const byOther = await decide(revT, appealId, 'reversed', 'The new evidence does change the outcome.');
    expect(byOther.status, (await byOther.clone()).text()).toBe(200);
    expect((await db.prepare('SELECT decision FROM appeals WHERE id = ?').get(appealId)).decision).toBe('reversed');
  });

  it('refuses to reopen an appeal that was never decided', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    const res = await jf(`/api/admin/appeals/${appealId}/reopen`, {
      method: 'POST', headers: asUser(revT),
      body: JSON.stringify({ reason: 'Trying to reopen something that is still open.' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_decided');
  });
});

/* ── 2. The overturn remedy ───────────────────────────────────────────────── */

describe('a reversed appeal and the account state it implies', () => {
  it('does NOT lift the suspension itself, and says so in the response', async () => {
    /**
     * Deliberate: reinstatement is a second decision with its own audit row, its
     * own refusals and its own notice. Doing it inside the decision transaction
     * would change an account with no actor recorded against the change.
     *
     * This test pins that contract. It is also the evidence for the residual
     * risk written up alongside it — between the reversal and the reinstatement
     * the appellant has been told they won while still being locked out, and
     * nothing in the system closes that gap on its own.
     */
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    const res = await decide(revT, appealId, 'reversed', 'The account did not do what was alleged.');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.remedy).toMatchObject({ required: true, action: 'unsuspend', userId: uid });
    expect(
      (await db.prepare('SELECT account_status FROM users WHERE id = ?').get(uid)).account_status,
      'the decision silently changed account state with no actor recorded'
    ).toBe('suspended');
  });

  it('restores the account through a separately audited unsuspend', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);
    await decide(revT, appealId, 'reversed', 'The account did not do what was alleged.');

    const un = await jf(`/api/admin/users/${uid}/unsuspend`, {
      method: 'POST', headers: asUser(revT), body: JSON.stringify({}),
    });
    expect(un.status, (await un.clone()).text()).toBeLessThan(300);

    const after = await db.prepare(
      'SELECT account_status, suspended_at, suspension_reason FROM users WHERE id = ?'
    ).get(uid);
    expect(after.account_status, 'the account was not restored').toBe('active');
    expect(after.suspended_at).toBeNull();

    // Two distinguishable audited actions, not one blended one.
    const reviewed = (await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'APPEAL_REVIEWED' AND target_user_id = ?"
    ).get(uid)).c;
    const restored = (await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'ACCOUNT_UNSUSPENDED' AND target_user_id = ?"
    ).get(uid)).c;
    expect(reviewed, 'no audit row for the appeal decision').toBeGreaterThan(0);
    expect(restored, 'no audit row for the reinstatement').toBeGreaterThan(0);
  });

  it('does not tell a still-suspended appellant that they can sign in', async () => {
    /**
     * The defect this pins. The reversal notice was unconditionally titled
     * "Your appeal worked — your account is back", ended "you can sign in now",
     * and carried a Sign in button to /login — while the handler deliberately
     * leaves the suspension in place. A student whose appeal succeeded was sent,
     * by a CRITICAL-priority mandatory notice, to a login screen that refuses a
     * suspended account and explains nothing.
     */
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    await decide(revT, appealId, 'reversed', 'The account did not do what was alleged.');

    expect((await db.prepare('SELECT account_status FROM users WHERE id = ?').get(uid)).account_status)
      .toBe('suspended');

    const note = await db.prepare(`
      SELECT title, body, link FROM notifications
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(uid);
    expect(note, 'no outcome notice was sent at all').toBeTruthy();

    expect(note.body.toLowerCase(), 'told a suspended user they can sign in')
      .not.toContain('you can sign in now');
    expect(note.link, 'sent a suspended user to a login page that will refuse them')
      .not.toBe('/login');
    // It must still be unambiguous that they won.
    expect(note.title.toLowerCase()).toContain('appeal worked');
  });

  it('keeps a reversed-but-still-suspended account visible to moderators', async () => {
    /**
     * Without this the appeal goes `resolved`, drops out of the queue, and
     * nothing anywhere shows that the person who won it is still locked out.
     * Derived from account state rather than a stored flag, so it cannot drift.
     */
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);
    await decide(revT, appealId, 'reversed', 'The account did not do what was alleged.');

    const queue = await (await jf('/api/admin/appeals', { headers: asUser(revT) })).json();
    expect(queue.appeals.some(a => a.id === appealId),
      'a decided appeal should have left the decision queue').toBe(false);
    expect(queue.pendingRemedies.some(r => r.id === appealId),
      'a reversed appeal whose account is still suspended is invisible to moderators').toBe(true);
    expect(queue.counts.remediesPending).toBeGreaterThan(0);

    // Reinstating clears it, with no flag to update.
    const un = await jf(`/api/admin/users/${uid}/unsuspend`, {
      method: 'POST', headers: asUser(revT), body: JSON.stringify({}),
    });
    expect(un.status).toBeLessThan(300);

    const after = await (await jf('/api/admin/appeals', { headers: asUser(revT) })).json();
    expect(after.pendingRemedies.some(r => r.id === appealId),
      'the remedy stayed pending after the account was restored').toBe(false);
  });

  it('links the reinstatement back to the appeal that required it', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);
    await decide(revT, appealId, 'reversed', 'The account did not do what was alleged.');
    await jf(`/api/admin/users/${uid}/unsuspend`, {
      method: 'POST', headers: asUser(revT), body: JSON.stringify({}),
    });

    const audit = await db.prepare(`
      SELECT details FROM admin_audit_logs
       WHERE action = 'ACCOUNT_UNSUSPENDED' AND target_user_id = ?
       ORDER BY created_at DESC LIMIT 1
    `).get(uid);
    expect(audit.details, 'the audit row does not say which appeal this completed')
      .toContain(appealId);

    const evt = (await db.prepare(
      "SELECT COUNT(*) c FROM appeal_events WHERE appeal_id = ? AND action = 'remedy_completed'"
    ).get(appealId)).c;
    expect(evt, 'the appeal history has no record that the account was let back in').toBe(1);
  });

  it('tells the appellant the outcome, whatever their email preference says', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    await db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(uid);
    const { appealId } = await suspendAndAppeal(adminT, uid);

    const before = (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ?').get(uid)).c;
    await decide(revT, appealId, 'reversed', 'The account did not do what was alleged.');
    const after = (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ?').get(uid)).c;

    expect(after, 'an opted-out appellant was never told the outcome of their own appeal')
      .toBeGreaterThan(before);
  });
});

/* ── 3. Reviewer history ──────────────────────────────────────────────────── */

describe('reviewer history cannot be lost', () => {
  it('keeps every reviewer in appeal_events across a reopen and re-decision', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const rev2T = await srv.login(reviewer2Email);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    await decide(revT, appealId, 'stands', 'Upheld on the evidence available at the time.');
    await jf(`/api/admin/appeals/${appealId}/reopen`, {
      method: 'POST', headers: asUser(rev2T),
      body: JSON.stringify({ reason: 'New evidence arrived that changes the picture here.' }),
    });
    await decide(revT, appealId, 'reversed', 'On the new evidence the original action was wrong.');

    const events = await db.prepare(
      'SELECT action, actor_id FROM appeal_events WHERE appeal_id = ? ORDER BY created_at'
    ).all(appealId);
    expect(events.filter(e => e.action === 'decided').length,
      'the second decision did not append its own history row').toBe(2);
    expect(events.some(e => e.action === 'reopened'), 'the reopen vanished from history').toBe(true);

    // appeal_events is append-only at the database, not by convention.
    const one = events[0];
    await expect(async () => await db.prepare('UPDATE appeal_events SET action = ? WHERE appeal_id = ? AND action = ?')
      .run('tampered', appealId, one.action)).rejects.toThrow(/append-only/);
    await expect(async () => await db.prepare('DELETE FROM appeal_events WHERE appeal_id = ?').run(appealId)).rejects.toThrow(/append-only/);
  });

  it('names the reviewer who actually made the decision the appellant is reading', async () => {
    /**
     * Regression. `reviewer_name_snapshot` is write-once by trigger, and the
     * decision handler COALESCEs onto it — correct for surviving a deleted
     * reviewer account, wrong as the answer to "who decided this".
     *
     * Whoever reopens an appeal is disqualified from deciding it, so the second
     * decision routinely lands with a THIRD administrator. Before this fix the
     * sequence below told the appellant that reviewer one had reversed the
     * decision, when reviewer three had. That misstates a fact the Community
     * Guidelines publish, and it misrepresents whether the person who decided
     * was conflicted.
     */
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const rev2T = await srv.login(reviewer2Email);

    const seeded = await db.prepare("SELECT password_hash FROM users WHERE id = 'user-admin'").get();
    await db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, grade, username, email_verified,
                         account_status, created_at)
      VALUES ('life-rev-3', 'life.reviewer3@example.gov', ?, 'Third Reviewer', 'admin', 'N/A',
              'life_rev_3', 1, 'active', ?)
      ON CONFLICT DO NOTHING
    `).run(seeded.password_hash, new Date().toISOString());
    const rev3T = await srv.login('life.reviewer3@example.gov');

    const uid = await makeUser();
    const { token, appealId } = await suspendAndAppeal(adminT, uid);

    await decide(revT, appealId, 'stands', 'Reviewer one upholds this on the evidence available.');
    await jf(`/api/admin/appeals/${appealId}/reopen`, {
      method: 'POST', headers: asUser(rev2T),
      body: JSON.stringify({ reason: 'Reviewer two reopens after new evidence arrives.' }),
    });
    const redecided = await decide(rev3T, appealId, 'reversed',
      'Reviewer three reverses the original decision on the new evidence.');
    expect(redecided.status, (await redecided.clone()).text()).toBe(200);

    // The row still carries the first reviewer's frozen snapshot, by design…
    const row = await db.prepare(
      'SELECT reviewer_id, reviewer_name_snapshot FROM appeals WHERE id = ?'
    ).get(appealId);
    expect(row.reviewer_id).toBe('life-rev-3');
    expect(row.reviewer_name_snapshot).toBe('Lifecycle Reviewer');

    // …but what the APPELLANT is told must be who actually decided it.
    const seen = await (await jf(`/api/appeals/token/${token}`)).json();
    const shown = seen?.appeal?.reviewerName ?? seen?.reviewerName ?? null;
    expect(shown, 'the appellant was told the wrong administrator decided their appeal')
      .toBe('Third Reviewer');
  });
});

/* ── 3b. Read auditing ────────────────────────────────────────────────────── */

describe('reading somebody else\'s appeal is logged', () => {
  const SECRET = 'My statement mentions Ms Alvarez and my brother Diego by name.';

  it('records an APPEAL_VIEWED row naming the reader and the appellant', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid, SECRET);

    const before = (await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'APPEAL_VIEWED' AND target_user_id = ?"
    ).get(uid)).c;

    const read = await jf(`/api/admin/appeals/${appealId}`, { headers: asUser(revT) });
    expect(read.status).toBe(200);
    expect((await read.json()).appeal.statement, 'fixture: the statement was not served').toBe(SECRET);

    const rows = await db.prepare(`
      SELECT admin_id, details FROM admin_audit_logs
       WHERE action = 'APPEAL_VIEWED' AND target_user_id = ? ORDER BY created_at DESC
    `).all(uid);
    expect(rows.length, 'reading an appellant\'s statement left no trace').toBeGreaterThan(before);
    expect(rows[0].admin_id, 'the log does not name who read it').toBe('life-rev-1');
    expect(rows[0].details).toContain(appealId);
  });

  it('never copies the statement itself into the audit log', async () => {
    /**
     * `admin_audit_logs` is readable by every `audit.read` holder and appears in
     * operational tooling. Writing the private text into the row that exists to
     * record its exposure would widen exactly the exposure it is recording.
     */
    const rows = await db.prepare("SELECT details FROM admin_audit_logs WHERE action = 'APPEAL_VIEWED'").all();
    expect(rows.length).toBeGreaterThan(0);
    for (const { details } of rows) {
      expect(details, 'the appellant\'s own words were copied into the audit log')
        .not.toContain('Alvarez');
      expect(details).not.toContain('Diego');
    }
  });

  it('records that the reader was conflicted, when they were', async () => {
    // Reading while conflicted is deliberately allowed — a moderator must be
    // able to see what was said about them. That permission is only defensible
    // if the log says the reading happened under a conflict.
    const adminT = await srv.login('admin@example.gov');
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    const read = await jf(`/api/admin/appeals/${appealId}`, { headers: asUser(adminT) });
    expect(read.status).toBe(200);
    expect((await read.json()).canDecide, 'fixture: the suspending admin was not conflicted').toBe(false);

    const row = await db.prepare(`
      SELECT details FROM admin_audit_logs
       WHERE action = 'APPEAL_VIEWED' AND target_user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(uid);
    expect(row.details).toMatch(/while conflicted/);
  });

  it('does not log an admin-audit row when the appellant reads their own appeal', async () => {
    /**
     * `admin_audit_logs.admin_id` is NOT NULL with a foreign key to `users`, and
     * the trail exists to detect administrator misuse. A student re-reading
     * their own appeal is neither an administrator nor misuse, and filling the
     * table with self-access rows would dilute the trail moderation depends on.
     */
    const adminT = await srv.login('admin@example.gov');
    const uid = await makeUser();
    const { token, appealId } = await suspendAndAppeal(adminT, uid);

    const before = (await db.prepare('SELECT COUNT(*) c FROM admin_audit_logs').get()).c;
    const own = await jf(`/api/appeals/token/${token}`);
    expect(own.status).toBe(200);
    const after = (await db.prepare('SELECT COUNT(*) c FROM admin_audit_logs').get()).c;

    expect(after, 'self-access wrote an administrator audit row').toBe(before);
    expect((await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'APPEAL_VIEWED' AND target_user_id = ?"
    ).get(uid)).c).toBe(0);
    void appealId;
  });
});

/* ── 3c. Queue completeness ───────────────────────────────────────────────── */

describe('the queue shows moderators what they need', () => {
  it('shows who already claimed an appeal, so advisory claiming is at least visible', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const rev2T = await srv.login(reviewer2Email);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    const claimed = await jf(`/api/admin/appeals/${appealId}/claim`, {
      method: 'POST', headers: asUser(revT),
    });
    expect(claimed.status).toBe(200);

    // A second CLAIM is refused…
    const second = await jf(`/api/admin/appeals/${appealId}/claim`, {
      method: 'POST', headers: asUser(rev2T),
    });
    expect(second.status).toBe(409);

    // …and the other reviewer can see whose it is before spending effort on it.
    const queue = await (await jf('/api/admin/appeals', { headers: asUser(rev2T) })).json();
    const row = queue.appeals.find(a => a.id === appealId);
    expect(row, 'a claimed appeal vanished from the queue').toBeTruthy();
    expect(row.status).toBe('reviewing');
    expect(row.claimed_by_name, 'the queue does not say who is working this').toBe('Lifecycle Reviewer');
  });

  it('can list decided appeals on request, and does not by default', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);
    await decide(revT, appealId, 'stands', 'Upheld on the evidence available at the time.');

    const dflt = await (await jf('/api/admin/appeals', { headers: asUser(revT) })).json();
    expect(dflt.appeals.some(a => a.id === appealId),
      'a decided appeal was folded into the live worklist').toBe(false);

    const resolved = await (await jf('/api/admin/appeals?status=resolved', { headers: asUser(revT) })).json();
    const found = resolved.appeals.find(a => a.id === appealId);
    expect(found, 'a decided appeal is not listable at all').toBeTruthy();
    expect(found.decision).toBe('stands');
  });

  it('falls back to the live queue on an unknown status rather than showing nothing', async () => {
    // A typo must not present as "there is nothing to do".
    const revT = await srv.login(reviewerEmail);
    const res = await (await jf('/api/admin/appeals?status=nonsense', { headers: asUser(revT) })).json();
    expect(res.appeals.every(a => ['open', 'reviewing'].includes(a.status))).toBe(true);
  });

  it('keeps an appeal readable when its linked report is gone', async () => {
    /**
     * `appeals.report_id` is RESTRICT and `reports` cannot be deleted at all, so
     * the row cannot vanish — but the detail route must still render when the
     * report lookup returns nothing, or a moderator gets a 500 instead of an
     * appeal.
     */
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    // A suspension appeal has no report behind it — the missing-subject case.
    const detail = await jf(`/api/admin/appeals/${appealId}`, { headers: asUser(revT) });
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.report, 'a suspension appeal should carry no report').toBeNull();
    expect(body.appeal.statement).toBeTruthy();
  });

  it('renders an appeal whose appellant account is gone', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid);

    // Anonymised, as account deletion actually does it (an UPDATE, not a DELETE).
    await db.prepare("UPDATE users SET name = 'Deleted U.', account_status = 'deleted' WHERE id = ?").run(uid);

    const queue = await (await jf('/api/admin/appeals', { headers: asUser(revT) })).json();
    const row = queue.appeals.find(a => a.id === appealId);
    expect(row, 'the appeal vanished when the account was deleted').toBeTruthy();
    expect(row.user_name).toBeTruthy();
  });
});

/* ── 3d. Submission acknowledgement ───────────────────────────────────────── */

describe('an appellant can tell that their appeal was received', () => {
  it('shows the filed state on the token route after submitting', async () => {
    /**
     * There is no acknowledgement notification, and for a suspended account
     * there could not usefully be an in-app one — they cannot sign in to read
     * it. What has to be true instead is that returning to the same link tells
     * them it landed. Before this was fixed the second visit answered "invalid
     * or expired", so a student who refreshed concluded their appeal had never
     * been received and had no way to find out otherwise.
     */
    const adminT = await srv.login('admin@example.gov');
    const uid = await makeUser();
    const { token } = await suspendAndAppeal(adminT, uid, 'My statement about what actually happened.');

    const revisit = await jf(`/api/appeals/token/${token}`);
    expect(revisit.status, 'the appeal link died the moment it was used').toBe(200);
    const body = await revisit.json();

    expect(body.alreadyFiled, 'a returning appellant is not told their appeal was received').toBe(true);
    expect(JSON.stringify(body)).toContain('open');
  });

  it('shows the outcome on the same link once it is decided', async () => {
    const adminT = await srv.login('admin@example.gov');
    const revT = await srv.login(reviewerEmail);
    const uid = await makeUser();
    const { token, appealId } = await suspendAndAppeal(adminT, uid);
    await decide(revT, appealId, 'stands', 'Upheld on the evidence available at the time.');

    const body = await (await jf(`/api/appeals/token/${token}`)).json();
    const seen = JSON.stringify(body);
    expect(seen, 'a suspended appellant cannot read their own outcome anywhere').toContain('stands');
    expect(seen).toContain('Upheld on the evidence');
  });
});

/* ── 3e. Unauthorized access ──────────────────────────────────────────────── */

describe('appeal surfaces refuse everyone without appeal.review', () => {
  it('refuses a student the queue, the detail view, the decision and the reopen', async () => {
    const adminT = await srv.login('admin@example.gov');
    const uid = await makeUser();
    const { appealId } = await suspendAndAppeal(adminT, uid, 'A statement no student should read.');
    const studentT = await srv.login('cameron.caldwell@example.com');

    const attempts = await Promise.all([
      jf('/api/admin/appeals', { headers: asUser(studentT) }),
      jf(`/api/admin/appeals/${appealId}`, { headers: asUser(studentT) }),
      jf(`/api/admin/appeals/${appealId}/claim`, { method: 'POST', headers: asUser(studentT) }),
      jf(`/api/admin/appeals/${appealId}`, {
        method: 'PATCH', headers: asUser(studentT),
        body: JSON.stringify({ decision: 'reversed', reasoning: 'Letting myself off entirely.' }),
      }),
      jf(`/api/admin/appeals/${appealId}/reopen`, {
        method: 'POST', headers: asUser(studentT),
        body: JSON.stringify({ reason: 'Reopening somebody else\'s appeal for fun.' }),
      }),
    ]);
    for (const r of attempts) expect(r.status).toBe(403);

    // And nothing was written by the attempts.
    expect(await db.prepare('SELECT decision, status FROM appeals WHERE id = ?').get(appealId))
      .toMatchObject({ decision: null, status: 'open' });
    expect((await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'APPEAL_VIEWED' AND target_user_id = ?"
    ).get(uid)).c, 'a refused read still wrote an audit row').toBe(0);
  });

  it('refuses an unauthenticated caller entirely', async () => {
    const res = await jf('/api/admin/appeals');
    expect(res.status).toBe(401);
  });

  it('does not let one appellant read another appellant\'s appeal', async () => {
    // `/api/appeals/mine` is scoped to the caller. The token route is scoped to
    // the token's own user. Neither takes a user id from the client.
    const adminT = await srv.login('admin@example.gov');
    const a = await makeUser(); const b = await makeUser();
    await suspendAndAppeal(adminT, a, 'Appellant A private statement about events.');
    await suspendAndAppeal(adminT, b, 'Appellant B private statement about events.');

    const studentT = await srv.login('cameron.caldwell@example.com');
    const mine = await (await jf('/api/appeals/mine', { headers: asUser(studentT) })).json();
    const text = JSON.stringify(mine);
    expect(text).not.toContain('Appellant A private');
    expect(text).not.toContain('Appellant B private');
  });
});

/* ── 4. Token lifecycle ───────────────────────────────────────────────────── */

describe('appeal token lifecycle', () => {
  it('answers expired, spent, and never-issued tokens without leaking suspension state', async () => {
    const adminT = await srv.login('admin@example.gov');

    // Expired.
    const expiredUid = await makeUser();
    const { token: expiredTok } = await suspendAndAppeal(adminT, expiredUid, 'Statement for the expiry case.');
    await db.prepare("UPDATE appeal_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?")
      .run(expiredTok);
    const expired = await jf(`/api/appeals/token/${expiredTok}`);

    // Never issued.
    const unknown = await jf('/api/appeals/token/deadbeefdeadbeefdeadbeefdeadbeef');

    expect(expired.status, 'an expired token is still honoured').toBe(unknown.status);

    const [e, u] = [await expired.json(), await unknown.json()];
    // Neither answer may name the account, its status, or why it was suspended.
    for (const body of [e, u]) {
      const text = JSON.stringify(body).toLowerCase();
      expect(text).not.toContain('suspend');
      expect(text).not.toContain('off-platform');
      expect(text).not.toContain('@example.com');
    }
    expect(e.code ?? null, 'an expired token is distinguishable from an unknown one')
      .toBe(u.code ?? null);
  });

  it('invalidates the previous token when a second suspension is issued', async () => {
    const adminT = await srv.login('admin@example.gov');
    const uid = await makeUser();

    await jf(`/api/admin/users/${uid}/suspend`, {
      method: 'POST', headers: asUser(adminT),
      body: JSON.stringify({ reason: 'First suspension, issued for a clear guideline breach.' }),
    });
    const first = (await db.prepare(
      'SELECT token FROM appeal_tokens WHERE user_id = ? ORDER BY expires_at DESC'
    ).get(uid)).token;

    await jf(`/api/admin/users/${uid}/unsuspend`, {
      method: 'POST', headers: asUser(adminT), body: JSON.stringify({}),
    });
    await jf(`/api/admin/users/${uid}/suspend`, {
      method: 'POST', headers: asUser(adminT),
      body: JSON.stringify({ reason: 'Second suspension, issued after a repeat of the same thing.' }),
    });
    const second = (await db.prepare(`
      SELECT token FROM appeal_tokens WHERE user_id = ? AND used_at IS NULL
       ORDER BY expires_at DESC LIMIT 1
    `).get(uid)).token;

    expect(second, 'the second suspension reused the first token').not.toBe(first);

    const oldRes = await jf(`/api/appeals/token/${first}`);
    const newRes = await jf(`/api/appeals/token/${second}`);
    expect(newRes.status, 'the current token does not work').toBe(200);
    expect(oldRes.status, 'a superseded token still opens an appeal').not.toBe(200);
  });

  it('stores expiry as UTC ISO-8601, so string comparison is timezone-safe', async () => {
    /**
     * Every expiry check in the appeals routes is a SQL string comparison
     * (`expires_at > ?` against `new Date().toISOString()`). That is only
     * correct while both sides are the same canonical format. A local-time
     * string would compare wrongly by the host's offset — which in New Jersey
     * means a token dying up to five hours early, or living five hours too long.
     */
    const rows = await db.prepare('SELECT expires_at FROM appeal_tokens').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const { expires_at: exp } of rows) {
      expect(exp, `non-canonical expiry stored: ${exp}`)
        .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(exp).toISOString()).toBe(exp);
    }
  });
});
