/**
 * Appeals — the behaviour PR-3C exists to guarantee.
 *
 * The previous version of this file passed against every defect an independent
 * audit later reproduced: it asserted that the appellant's statement lands in
 * `appeals.reasoning`, then decided the appeal in a later test and never looked
 * at that column again. A green suite is not the same as a working appeal, and
 * the cases below are chosen for consequence rather than coverage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;
/**
 * A second administrator who issues no suspensions.
 *
 * Needed because the conflict-of-interest rule now works: the seeded admin
 * suspends everybody in these fixtures and is therefore disqualified from
 * deciding any of it. Reaching for `UPDATE appeals SET suspended_by_snapshot =
 * NULL` to get around that is exactly what migration 015's triggers refuse, and
 * rightly — the fixture has to model a real second reviewer instead.
 */
let reviewerEmail;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;

  const seeded = db.prepare("SELECT password_hash FROM users WHERE id = 'user-admin'").get();
  reviewerEmail = 'appeal.reviewer@example.gov';
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username, email_verified,
                       account_status, created_at)
    VALUES ('user-reviewer', ?, ?, 'Independent Reviewer', 'admin', 'N/A', 'reviewer', 1, 'active', datetime('now'))
    ON CONFLICT DO NOTHING
  `).run(reviewerEmail, seeded.password_hash);
});
afterAll(async () => { await srv.close(); });

const jf = (p, o = {}) => fetch(srv.base + p, {
  ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
});

let seq = 0;
function makeUser(optOut = 0) {
  const id = `ap-user-${++seq}`;
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username,
                       email_verified, account_status, email_opt_out, created_at)
    VALUES (?, ?, 'h', ?, 'student', '9', ?, 1, 'active', ?, datetime('now'))
  `).run(id, `${id}@example.com`, `Student ${seq}`, id.replace(/-/g, '_'), optOut);
  return id;
}

/** The admin who issues the suspensions in these fixtures — always conflicted. */
const adminToken = () => srv.login('admin@example.gov');
/** An admin who issued nothing, so they are eligible to decide. */
const reviewerToken = () => srv.login(reviewerEmail);

async function suspend(uid, reason = 'Messaged a student off-platform after a clear warning.') {
  const t = await adminToken();
  const res = await jf(`/api/admin/users/${uid}/suspend`, {
    method: 'POST', headers: { Cookie: `wev_session=${t}` }, body: JSON.stringify({ reason }),
  });
  const token = db.prepare(
    'SELECT token FROM appeal_tokens WHERE user_id = ? AND used_at IS NULL ORDER BY expires_at DESC'
  ).get(uid)?.token;
  return { res, token };
}

async function fileAppeal(token, statement = 'I did not send that message and I can explain why.') {
  return jf(`/api/appeals/token/${token}`, { method: 'POST', body: JSON.stringify({ statement }) });
}

/* ───────────────────────────── Appeal creation ───────────────────────────── */

describe('appeal creation', () => {
  it('a suspended user can file an appeal — the case the whole design exists for', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    const res = await fileAppeal(token);
    expect(res.status).toBe(201);

    const row = db.prepare('SELECT * FROM appeals WHERE user_id = ?').get(uid);
    expect(row.status).toBe('open');
    expect(row.subject).toBe('suspension');
  });

  it('refuses an unknown, an expired and a spent token with byte-identical responses', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);                       // spends it

    const expiredUid = makeUser();
    await suspend(expiredUid);
    const expired = db.prepare('SELECT token FROM appeal_tokens WHERE user_id = ?').get(expiredUid).token;
    db.prepare("UPDATE appeal_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?").run(expired);

    const bodies = [];
    for (const t of ['definitely-not-real', expired, token]) {
      const r = await fileAppeal(t, 'A perfectly valid statement of at least twenty characters.');
      expect(r.status).toBe(404);
      bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('cannot reuse a spent token', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    expect((await fileAppeal(token)).status).toBe(201);
    expect((await fileAppeal(token, 'A second statement, also long enough to pass.')).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) c FROM appeals WHERE user_id = ?').get(uid).c).toBe(1);
  });

  it('rejects a statement that is too short or too long', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    expect((await fileAppeal(token, 'too short')).status).toBe(400);
    expect((await fileAppeal(token, 'x'.repeat(5001))).status).toBe(400);
    // ...and the token is still unspent, so a mistyped attempt costs nothing.
    expect(db.prepare('SELECT used_at FROM appeal_tokens WHERE token = ?').get(token).used_at).toBeNull();
  });

  it('leaks no name, email or user id through the token lookup', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    const body = await (await fetch(srv.base + `/api/appeals/token/${token}`)).text();
    expect(body).not.toContain(uid);
    expect(body).not.toContain('@example.com');
    expect(body).not.toContain('Student');
  });

  it('tells a returning appellant their appeal was already received', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);
    const data = await (await fetch(srv.base + `/api/appeals/token/${token}`)).json();
    expect(data.alreadyFiled).toBe(true);
    expect(data.appeal.status).toBe('open');
  });
});

/* ─────────────────────── Ownership on the authenticated route ─────────────── */

describe('POST /api/appeals — ownership', () => {
  it('does not 500 — the route that had never worked', async () => {
    const stu = db.prepare("SELECT id, email FROM users WHERE role='student' AND account_status='active' LIMIT 1").get();
    db.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, target_author_id, category,
                           description, status, priority, created_at, updated_at)
      VALUES ('rep-own', 'user-admin', 'comment', 'c-1', ?, 'other', 'about them',
              'resolved', 'normal', datetime('now'), datetime('now'))
      ON CONFLICT DO NOTHING
    `).run(stu.id);

    const t = await srv.login(stu.email);
    const res = await jf('/api/appeals', {
      method: 'POST', headers: { Cookie: `wev_session=${t}` },
      body: JSON.stringify({ reportId: 'rep-own', subject: 'report_outcome', statement: 'This report outcome was wrong and here is why.' }),
    });
    expect(res.status).toBe(201);
    expect(db.prepare("SELECT COUNT(*) c FROM moderation_actions WHERE report_id='rep-own'").get().c).toBeGreaterThan(0);
  });

  it("refuses a report that is not about the caller, identically to one that does not exist", async () => {
    const stu = db.prepare("SELECT id, email FROM users WHERE role='student' AND account_status='active' LIMIT 1").get();
    const other = db.prepare("SELECT id FROM users WHERE role='organizer' LIMIT 1").get();
    db.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, target_author_id, category,
                           description, status, priority, created_at, updated_at)
      VALUES ('rep-other', 'user-admin', 'comment', 'c-2', ?, 'other', 'about somebody else',
              'resolved', 'normal', datetime('now'), datetime('now'))
      ON CONFLICT DO NOTHING
    `).run(other.id);

    const t = await srv.login(stu.email);
    const mk = (reportId) => jf('/api/appeals', {
      method: 'POST', headers: { Cookie: `wev_session=${t}` },
      body: JSON.stringify({ reportId, statement: 'Attaching myself to a report that is not mine.' }),
    });

    const foreign = await mk('rep-other');
    const missing = await mk('rep-does-not-exist');
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect(db.prepare("SELECT COUNT(*) c FROM moderation_actions WHERE report_id='rep-other'").get().c).toBe(0);
  });
});

/* ─────────────────────────── Statement preservation ──────────────────────── */

describe('statement preservation', () => {
  it('survives the decision that rules on it', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    const STATEMENT = 'I never sent that message. Someone used a school computer I forgot to sign out of.';
    await fileAppeal(token, STATEMENT);
    const appeal = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid);

    const t = await reviewerToken();
    const res = await jf(`/api/admin/appeals/${appeal.id}`, {
      method: 'PATCH', headers: { Cookie: `wev_session=${t}` },
      body: JSON.stringify({ decision: 'stands', reasoning: 'The sign-in records show their own device was used.' }),
    });
    expect(res.status).toBe(200);

    const after = db.prepare('SELECT statement, reasoning FROM appeals WHERE id = ?').get(appeal.id);
    expect(after.statement).toBe(STATEMENT);                       // the whole point
    expect(after.reasoning).toBe('The sign-in records show their own device was used.');
  });

  it('is unwritable at the database, by any path', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token, 'The original words that must outlive every later edit.');
    const id = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid).id;

    expect(() => db.prepare('UPDATE appeals SET statement = ? WHERE id = ?').run('rewritten', id))
      .toThrow(/never overwritten/);
    expect(() => db.prepare('DELETE FROM appeals WHERE id = ?').run(id)).toThrow(/never deleted/);
  });

  it('survives the suspension being lifted — the snapshot, not the live column', async () => {
    const uid = makeUser();
    const REASON = 'Sent a student their personal phone number after being told not to.';
    const { token } = await suspend(uid, REASON);
    await fileAppeal(token);

    const t = await adminToken();
    await jf(`/api/admin/users/${uid}/unsuspend`, {
      method: 'POST', headers: { Cookie: `wev_session=${t}` }, body: JSON.stringify({ reason: 'Appeal granted.' }),
    });

    // The live columns are cleared by design; the appeal keeps its own copy.
    expect(db.prepare('SELECT suspension_reason FROM users WHERE id = ?').get(uid).suspension_reason).toBeNull();
    const appeal = db.prepare('SELECT * FROM appeals WHERE user_id = ?').get(uid);
    expect(appeal.suspension_reason_snapshot).toBe(REASON);
    expect(appeal.suspended_by_name_snapshot).toBeTruthy();
  });

  /**
   * The snapshot has to reach the APPELLANT, not just the table.
   *
   * The test above proves the column is frozen. It says nothing about whether
   * anybody can read it, and the person the snapshot exists for could not: the
   * token route's `appeal` query selected six columns and
   * `suspension_reason_snapshot` was not among them, so the
   * `?? appeal?.suspension_reason_snapshot` fallback beside it read `undefined`
   * on every request and collapsed to null.
   *
   * The visible consequence is narrow and bad. `unsuspend` NULLs the live
   * columns, so the moment an appeal SUCCEEDS — or a suspension is lifted while
   * the appeal is still open — the reinstated student opening their link is told
   * they were suspended for nothing, with no date. That is the single reader for
   * whom migration 015 froze these columns in the first place, and the one
   * conversation ("what was I actually accused of") the record is supposed to
   * settle years later.
   *
   * Asserted through HTTP rather than against the row, because the row was
   * always right. The defect was entirely in the reading.
   */
  it('still tells a REINSTATED appellant what they were suspended for', async () => {
    const uid = makeUser();
    const REASON = 'Shared another student\'s phone number in a public event comment.';
    const { token } = await suspend(uid, REASON);
    await fileAppeal(token);

    const t = await adminToken();
    await jf(`/api/admin/users/${uid}/unsuspend`, {
      method: 'POST', headers: { Cookie: `wev_session=${t}` },
      body: JSON.stringify({ reason: 'Appeal granted — reinstating the account.' }),
    });

    const res = await fetch(srv.base + `/api/appeals/token/${token}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    // The live column is NULL by design at this point. The appellant must still
    // be shown the reason they are appealing.
    expect(db.prepare('SELECT suspension_reason FROM users WHERE id = ?').get(uid).suspension_reason)
      .toBeNull();
    expect(body.suspensionReason).toBe(REASON);
    // And the date, which had no fallback at all.
    expect(body.suspendedAt).toBeTruthy();
  });

  it('prefers the live reason while the suspension is still in force', async () => {
    const uid = makeUser();
    const REASON = 'Repeatedly ignored an organizer\'s instruction to stop messaging.';
    const { token } = await suspend(uid, REASON);
    await fileAppeal(token);

    const body = await (await fetch(srv.base + `/api/appeals/token/${token}`)).json();
    expect(body.suspensionReason).toBe(REASON);
    expect(body.accountStatus).toBe('suspended');
  });
});

/* ────────────────────────────── Conflict of interest ─────────────────────── */

describe('conflict of interest', () => {
  it('refuses the administrator who issued the suspension — 403, not 200', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);
    const appeal = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid);

    const t = await adminToken();
    const res = await jf(`/api/admin/appeals/${appeal.id}`, {
      method: 'PATCH', headers: { Cookie: `wev_session=${t}` },
      body: JSON.stringify({ decision: 'stands', reasoning: 'Upholding the decision that I myself made.' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('conflict_of_interest');
    expect(body.conflicts).toContain('suspension_issuer');

    // ...and nothing was written.
    expect(db.prepare('SELECT decision, status FROM appeals WHERE id = ?').get(appeal.id).decision).toBeNull();
  });

  it('still lets that administrator READ it — a moderator may see what was said about them', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);
    const appeal = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid);

    const t = await adminToken();
    const res = await jf(`/api/admin/appeals/${appeal.id}`, { headers: { Cookie: `wev_session=${t}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canDecide).toBe(false);
    expect(body.conflicts).toContain('suspension_issuer');
  });

  it('the read does not change the appeal — a GET claims nothing', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);
    const appeal = db.prepare('SELECT id, status, updated_at FROM appeals WHERE user_id = ?').get(uid);

    const t = await adminToken();
    await jf(`/api/admin/appeals/${appeal.id}`, { headers: { Cookie: `wev_session=${t}` } });

    const after = db.prepare('SELECT status, updated_at FROM appeals WHERE id = ?').get(appeal.id);
    expect(after.status).toBe(appeal.status);
    expect(after.updated_at).toBe(appeal.updated_at);
  });

  it('refuses self-review, and that conflict is never overridable', async () => {
    const { disqualifiers, allOverridable } = await import('./appeals.js');
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);
    const appeal = db.prepare('SELECT * FROM appeals WHERE user_id = ?').get(uid);

    const conflicts = disqualifiers(db, uid, appeal);
    expect(conflicts).toContain('self');
    expect(allOverridable(conflicts)).toBe(false);
  });

  it('marks conflicted appeals in the queue rather than hiding them', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);

    const t = await adminToken();
    const { appeals } = await (await jf('/api/admin/appeals', { headers: { Cookie: `wev_session=${t}` } })).json();
    const mine = appeals.find(a => a.user_id === uid);
    expect(mine).toBeTruthy();               // visible
    expect(mine.canDecide).toBe(false);      // and marked
  });

  it('gates the admin routes on appeal.review — a student and an organizer get 403/401', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);

    const anon = await fetch(srv.base + '/api/admin/appeals');
    expect(anon.status).toBe(401);

    const stu = db.prepare("SELECT email FROM users WHERE role='student' AND account_status='active' LIMIT 1").get();
    const st = await srv.login(stu.email);
    const asStudent = await jf('/api/admin/appeals', { headers: { Cookie: `wev_session=${st}` } });
    expect(asStudent.status).toBe(403);
  });
});

/* ────────────────────────── Decision, remedy, re-decision ────────────────── */

describe('decision workflow', () => {
  /**
   * Suspended by one administrator, decided by a different one — the eligible
   * path, modelled the way the product must actually be staffed rather than by
   * editing the record to make the conflict disappear.
   */
  async function decidedAppeal(decision = 'stands') {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);
    const appeal = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid);

    const t = await reviewerToken();
    const res = await jf(`/api/admin/appeals/${appeal.id}`, {
      method: 'PATCH', headers: { Cookie: `wev_session=${t}` },
      body: JSON.stringify({ decision, reasoning: 'Considered the statement and the surrounding records carefully.' }),
    });
    return { uid, appealId: appeal.id, res, token: t };
  }

  it('records the reviewer name, the decision and a decided_at', async () => {
    const { appealId } = await decidedAppeal();
    const row = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId);
    expect(row.decision).toBe('stands');
    expect(row.reviewer_name_snapshot).toBeTruthy();
    expect(row.decided_at).toBeTruthy();
    expect(row.status).toBe('resolved');
  });

  it('refuses a second decision with 409 rather than silently re-deciding', async () => {
    const { appealId, token } = await decidedAppeal('stands');
    const again = await jf(`/api/admin/appeals/${appealId}`, {
      method: 'PATCH', headers: { Cookie: `wev_session=${token}` },
      body: JSON.stringify({ decision: 'reversed', reasoning: 'Quietly changing my earlier decision now.' }),
    });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('already_decided');
    expect(db.prepare('SELECT decision FROM appeals WHERE id = ?').get(appealId).decision).toBe('stands');
  });

  it('requires reasoning of at least 20 characters', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    await fileAppeal(token);
    const id = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid).id;
    const t = await adminToken();
    const res = await jf(`/api/admin/appeals/${id}`, {
      method: 'PATCH', headers: { Cookie: `wev_session=${t}` },
      body: JSON.stringify({ decision: 'stands', reasoning: 'too short' }),
    });
    expect(res.status).toBe(400);
  });

  it('does NOT auto-unsuspend on a reversal, and says the remedy is outstanding', async () => {
    const { uid, res } = await decidedAppeal('reversed');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remedy.required).toBe(true);
    expect(body.remedy.action).toBe('unsuspend');
    // Reinstatement is a separate, audited act — not a side effect.
    expect(db.prepare('SELECT account_status FROM users WHERE id = ?').get(uid).account_status).toBe('suspended');
  });

  it('reopening is audited, and the reopener may not then decide it', async () => {
    const { appealId, token } = await decidedAppeal();
    const reopen = await jf(`/api/admin/appeals/${appealId}/reopen`, {
      method: 'POST', headers: { Cookie: `wev_session=${token}` },
      body: JSON.stringify({ reason: 'New information arrived from the student about the timeline.' }),
    });
    expect(reopen.status).toBe(200);
    expect(db.prepare('SELECT status FROM appeals WHERE id = ?').get(appealId).status).toBe('reviewing');

    const events = db.prepare("SELECT action FROM appeal_events WHERE appeal_id = ?").all(appealId).map(e => e.action);
    expect(events).toContain('reopened');

    const redecide = await jf(`/api/admin/appeals/${appealId}`, {
      method: 'PATCH', headers: { Cookie: `wev_session=${token}` },
      body: JSON.stringify({ decision: 'reversed', reasoning: 'Deciding the appeal that I myself reopened.' }),
    });
    expect(redecide.status).toBe(403);
    expect((await redecide.json()).conflicts).toContain('reopener');
  });

  it('writes an append-only history that cannot be edited afterwards', async () => {
    const { appealId } = await decidedAppeal();
    const events = db.prepare('SELECT id, action FROM appeal_events WHERE appeal_id = ? ORDER BY created_at').all(appealId);
    expect(events.map(e => e.action)).toEqual(expect.arrayContaining(['submitted', 'decided']));
    expect(() => db.prepare("UPDATE appeal_events SET action='x' WHERE id = ?").run(events[0].id))
      .toThrow(/append-only/);
  });

  it('notifies the appellant of the outcome, with the reasons and the reviewer', async () => {
    const { uid } = await decidedAppeal('stands');
    const jobs = db.prepare(
      "SELECT payload FROM notification_jobs WHERE payload LIKE ? AND payload LIKE '%APPEAL_DECISION%'"
    ).all(`%${uid}%`);
    expect(jobs.length).toBe(1);
    const payload = JSON.parse(jobs[0].payload);
    expect(payload.payload.reasoning).toBeTruthy();
    expect(payload.payload.reviewerName).toBeTruthy();
  });
});

/* ──────────────────────────────── Notification ───────────────────────────── */

describe('enforcement notices are not suppressible', () => {
  it('a user who opted out of email STILL receives the suspension notice and appeal link', async () => {
    const uid = makeUser(1);   // email_opt_out = 1
    await suspend(uid);

    const jobs = db.prepare('SELECT payload FROM notification_jobs WHERE payload LIKE ?').all(`%${uid}%`);
    expect(jobs.length).toBe(1);
    const parsed = JSON.parse(jobs[0].payload);
    expect(parsed.event).toBe('ACCOUNT_SUSPENDED');
    expect(parsed.payload.token).toBeTruthy();
  });

  it('and receives the reinstatement notice too', async () => {
    const uid = makeUser(1);
    await suspend(uid);
    const t = await adminToken();
    await jf(`/api/admin/users/${uid}/unsuspend`, {
      method: 'POST', headers: { Cookie: `wev_session=${t}` }, body: JSON.stringify({}),
    });
    const jobs = db.prepare(
      "SELECT payload FROM notification_jobs WHERE payload LIKE ? AND payload LIKE '%ACCOUNT_REINSTATED%'"
    ).all(`%${uid}%`);
    expect(jobs.length).toBe(1);
  });

  it('the emailed appeal link is the route the client actually serves', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    const { getInAppContent } = await import('./services/notificationContent.js');
    const link = getInAppContent('ACCOUNT_SUSPENDED', { reason: 'r', token }).link;
    expect(link).toBe(`/appeal/${token}`);
    // And it resolves: the API behind that page answers for this token.
    expect((await fetch(srv.base + `/api/appeals/token/${token}`)).status).toBe(200);
  });

  it('reinstatement spends any outstanding appeal token', async () => {
    const uid = makeUser();
    const { token } = await suspend(uid);
    const t = await adminToken();
    await jf(`/api/admin/users/${uid}/unsuspend`, {
      method: 'POST', headers: { Cookie: `wev_session=${t}` }, body: JSON.stringify({}),
    });
    // Re-suspending must not revive the old link.
    await suspend(uid, 'A second and completely unrelated suspension reason entirely.');
    const res = await fetch(srv.base + `/api/appeals/token/${token}`);
    expect(res.status).toBe(404);
  });
});
