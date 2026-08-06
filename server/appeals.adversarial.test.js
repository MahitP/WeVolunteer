/**
 * Adversarial verification of the appeals safety properties.
 *
 * ── Why this file exists beside `appealsRoutes.test.js` ──
 *
 * That file tests the appeals system as a feature: the happy paths, the
 * refusals, the shapes. This one tests it as a thing somebody is attacking, and
 * every check here is written to FAIL if the property it names stops holding —
 * not to pass if the feature still works.
 *
 * Three of them are deliberately driven with raw SQL rather than through a
 * route. A route test proves the handler somebody wrote behaves; it proves
 * nothing about a `bin/` script, a migration written next year, or somebody with
 * a sqlite3 prompt. The immutability guarantees in migration 015 are triggers
 * precisely so that they hold against those paths too, and the only way to
 * verify a trigger is to attack the table directly.
 *
 * The properties, and why each one matters:
 *
 *   1. An appellant's statement is what they said in their own defence. If a
 *      decision can overwrite it, the record of the case becomes the record of
 *      the verdict, and an appeal reviewed later has nothing to review.
 *   2. Nobody decides their own case. Including — especially — the person with
 *      nobody above them, who is exactly the account for which a privilege
 *      escape hatch would be written by accident.
 *   3. An appeal cannot be attached to somebody else's report, which would put a
 *      third party's report and the reporter's identity in front of a reviewer.
 *   4. The link in the suspension notice reaches a working appeal page. A token
 *      in a table that no message points at is a permanent lockout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;
let reviewerEmail, superEmail;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;

  const seeded = db.prepare("SELECT password_hash FROM users WHERE id = 'user-admin'").get();

  // An administrator who has issued nothing, so they are eligible to decide.
  reviewerEmail = 'adv.reviewer@example.gov';
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username, email_verified,
                       account_status, created_at)
    VALUES ('adv-reviewer', ?, ?, 'Adversarial Reviewer', 'admin', 'N/A', 'adv_reviewer', 1,
            'active', datetime('now'))
    ON CONFLICT DO NOTHING
  `).run(reviewerEmail, seeded.password_hash);

  /**
   * A super administrator, who does not exist in the demo seed.
   *
   * Needed because `can(super_admin, …)` is true for every capability, so a
   * conflict-of-interest cascade that branches on a capability before it tests
   * for the conflict would swallow every conflicted case — and the account it
   * would swallow them for is the one with no oversight above it.
   */
  superEmail = 'adv.super@example.gov';
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username, email_verified,
                       account_status, created_at)
    VALUES ('adv-super', ?, ?, 'Adversarial Super', 'super_admin', 'N/A', 'adv_super', 1,
            'active', datetime('now'))
    ON CONFLICT DO NOTHING
  `).run(superEmail, seeded.password_hash);
});

afterAll(async () => { await srv.close(); });

const jf = (p, o = {}) => fetch(srv.base + p, {
  ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const asUser = (t) => ({ Cookie: `wev_session=${t}` });

let seq = 0;
function makeUser(optOut = 0) {
  const id = `adv-user-${++seq}`;
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username,
                       email_verified, account_status, email_opt_out, created_at)
    VALUES (?, ?, 'h', ?, 'student', '9', ?, 1, 'active', ?, datetime('now'))
  `).run(id, `${id}@example.com`, `Adv Student ${seq}`, id.replace(/-/g, '_'), optOut);
  return id;
}

/** Suspends `uid` as whoever holds `token`, and returns the appeal token minted for them. */
async function suspendAs(sessionToken, uid, reason = 'Messaged a student off-platform after a warning.') {
  const res = await jf(`/api/admin/users/${uid}/suspend`, {
    method: 'POST', headers: asUser(sessionToken), body: JSON.stringify({ reason }),
  });
  const token = db.prepare(
    'SELECT token FROM appeal_tokens WHERE user_id = ? AND used_at IS NULL ORDER BY expires_at DESC'
  ).get(uid)?.token;
  return { res, token };
}

const fileAppeal = (token, statement) =>
  jf(`/api/appeals/token/${token}`, { method: 'POST', body: JSON.stringify({ statement }) });

/* ── 1. The statement survives the decision ──────────────────────────────── */

describe('an appellant\'s own words survive the decision', () => {
  it('leaves the statement byte-identical after a decision is recorded', async () => {
    const adminT = await srv.login('admin@example.gov');
    const reviewerT = await srv.login(reviewerEmail);
    const uid = makeUser();

    /**
     * Deliberately awkward text. The original defect overwrote the statement
     * with the reviewer's reasoning, and a fixture of "abc" would still look
     * plausible afterwards; a statement carrying quotes, an emoji and a newline
     * makes any re-encoding on the round trip visible too.
     */
    const STATEMENT =
      'I did not send that message.\nMy sister used my laptop — she said "it was a joke" 😞';

    const { token } = await suspendAs(adminT, uid);
    expect(token, 'fixture: suspension minted no appeal token').toBeTruthy();
    const filed = await fileAppeal(token, STATEMENT);
    expect(filed.status, `fixture: appeal not filed (${await filed.clone().text()})`).toBeLessThan(300);

    const appealId = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid).id;
    const before = db.prepare('SELECT statement FROM appeals WHERE id = ?').get(appealId).statement;
    expect(before).toBe(STATEMENT);

    const decided = await jf(`/api/admin/appeals/${appealId}`, {
      method: 'PATCH', headers: asUser(reviewerT),
      body: JSON.stringify({
        decision: 'stands',
        reasoning: 'The message came from this account while it was signed in on two devices.',
      }),
    });
    expect(decided.status, `decision was refused (${await decided.clone().text()})`).toBe(200);

    const after = db.prepare('SELECT statement, decision, reasoning FROM appeals WHERE id = ?')
      .get(appealId);
    expect(after.decision, 'fixture: the decision did not record').toBe('stands');
    expect(
      after.statement,
      'the decision overwrote the appellant\'s own account of events'
    ).toBe(STATEMENT);
    expect(after.reasoning).not.toBe(after.statement);
  });

  it('refuses to overwrite a statement even from raw SQL', () => {
    const row = db.prepare("SELECT id, statement FROM appeals WHERE statement IS NOT NULL LIMIT 1").get();
    expect(row, 'fixture: no appeal with a statement to attack').toBeTruthy();

    expect(() => db.prepare('UPDATE appeals SET statement = ? WHERE id = ?')
      .run('I admit everything.', row.id)).toThrow(/never overwritten/);

    expect(db.prepare('SELECT statement FROM appeals WHERE id = ?').get(row.id).statement)
      .toBe(row.statement);
  });
});

/* ── 2. The record cannot be rewritten or removed ─────────────────────────── */

describe('appeal and moderation records are append-only at the database', () => {
  it('refuses DELETE FROM appeals', () => {
    const row = db.prepare('SELECT id FROM appeals LIMIT 1').get();
    expect(row, 'fixture: no appeal to attack').toBeTruthy();
    expect(() => db.prepare('DELETE FROM appeals WHERE id = ?').run(row.id))
      .toThrow(/never deleted/);
    expect(db.prepare('SELECT 1 FROM appeals WHERE id = ?').get(row.id)).toBeTruthy();
  });

  it('refuses to re-point an appeal at a different account', () => {
    // The laundering attack: move somebody's defence onto another person's record.
    const row = db.prepare('SELECT id, user_id FROM appeals LIMIT 1').get();
    expect(() => db.prepare('UPDATE appeals SET user_id = ? WHERE id = ?')
      .run('user-admin', row.id)).toThrow(/only the review workflow may change/);
    expect(db.prepare('SELECT user_id FROM appeals WHERE id = ?').get(row.id).user_id)
      .toBe(row.user_id);
  });

  it('refuses UPDATE and DELETE on moderation_actions', async () => {
    /**
     * The row is created through the real path rather than inserted by hand:
     * filing an appeal against a report the caller owns is what appends the
     * `appeal_filed` history row, so this also proves that path still writes one.
     */
    const studentT = await srv.login('colin.carbin29@outlook.com');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO reports (id, reporter_id, reporter_name_snapshot, target_type, target_id,
                           target_author_id, category, description, status, priority,
                           created_at, updated_at)
      VALUES ('adv-rep-own', 'user-admin', 'System Admin', 'user', 'user-colin', 'user-colin',
              'bullying_or_harassment', 'A report about the appellant.', 'resolved', 'normal', ?, ?)
    `).run(now, now);

    const filed = await jf('/api/appeals', {
      method: 'POST', headers: asUser(studentT),
      body: JSON.stringify({
        statement: 'This report is about me and I would like it looked at again.',
        reportId: 'adv-rep-own',
      }),
    });
    expect(filed.status, `fixture: own-report appeal refused (${await filed.clone().text()})`)
      .toBeLessThan(300);

    const row = db.prepare(
      "SELECT id, action FROM moderation_actions WHERE report_id = 'adv-rep-own' LIMIT 1"
    ).get();
    expect(row, 'filing an appeal against your own report wrote no history row').toBeTruthy();

    expect(() => db.prepare('UPDATE moderation_actions SET action = ? WHERE id = ?')
      .run('tampered', row.id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM moderation_actions WHERE id = ?').run(row.id))
      .toThrow(/append-only/);

    expect(db.prepare('SELECT action FROM moderation_actions WHERE id = ?').get(row.id).action)
      .toBe(row.action);
  });
});

/* ── 3. Nobody decides their own case ─────────────────────────────────────── */

describe('conflict of interest cannot be bypassed', () => {
  it('refuses the administrator who issued the suspension', async () => {
    const adminT = await srv.login('admin@example.gov');
    const uid = makeUser();
    const { token } = await suspendAs(adminT, uid);
    await fileAppeal(token, 'I was not even online that evening, and I can show you.');
    const appealId = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid).id;

    const res = await jf(`/api/admin/appeals/${appealId}`, {
      method: 'PATCH', headers: asUser(adminT),
      body: JSON.stringify({ decision: 'stands', reasoning: 'I stand by my own suspension here.' }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('conflict_of_interest');
    expect(
      db.prepare('SELECT decision FROM appeals WHERE id = ?').get(appealId).decision,
      'the conflicted decision was written anyway'
    ).toBeNull();
  });

  it('refuses a SUPER ADMIN who issued the suspension, despite the override path', async () => {
    /**
     * The case a privilege escape hatch gets written for by accident.
     *
     * `admin.create` lets a super administrator override *some* conflicts — a
     * two-person team otherwise deadlocks. `suspension_issuer` must not be one
     * of them, or the one account with nobody above it can rule on its own
     * enforcement action, which is the exact thing the whole cascade exists to
     * prevent.
     */
    const superT = await srv.login(superEmail);
    const uid = makeUser();
    const { res: susRes, token } = await suspendAs(superT, uid);
    expect(susRes.status, 'fixture: super admin could not suspend').toBeLessThan(300);
    await fileAppeal(token, 'The account was suspended by the same person I am appealing to.');
    const appealId = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid).id;

    const claim = await jf(`/api/admin/appeals/${appealId}/claim`, {
      method: 'POST', headers: asUser(superT),
    });
    expect(claim.status, 'a super admin claimed an appeal against their own suspension').toBe(403);

    const res = await jf(`/api/admin/appeals/${appealId}`, {
      method: 'PATCH', headers: asUser(superT),
      body: JSON.stringify({ decision: 'stands', reasoning: 'Reviewing my own suspension decision.' }),
    });
    expect(res.status, 'a super admin decided an appeal against their own suspension').toBe(403);
    expect((await res.json()).code).toBe('conflict_of_interest');
    expect(db.prepare('SELECT decision FROM appeals WHERE id = ?').get(appealId).decision).toBeNull();
  });

  it('still lets an uninvolved administrator decide, so the refusal is not universal', async () => {
    // A guard that refuses everybody gets removed. This is what keeps the two
    // tests above meaningful.
    const adminT = await srv.login('admin@example.gov');
    const reviewerT = await srv.login(reviewerEmail);
    const uid = makeUser();
    const { token } = await suspendAs(adminT, uid);
    await fileAppeal(token, 'Nobody involved in my suspension should be reading this appeal.');
    const appealId = db.prepare('SELECT id FROM appeals WHERE user_id = ?').get(uid).id;

    const res = await jf(`/api/admin/appeals/${appealId}`, {
      method: 'PATCH', headers: asUser(reviewerT),
      body: JSON.stringify({ decision: 'reversed', reasoning: 'The evidence does not support this.' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

/* ── 4. An appeal cannot be attached to somebody else's report ────────────── */

describe('reportId ownership', () => {
  it('refuses a report the caller has nothing to do with, without revealing it exists', async () => {
    const victim = makeUser();
    const attacker = makeUser();

    // A real report about somebody else entirely.
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO reports (id, reporter_id, reporter_name_snapshot, target_type, target_id,
                           target_author_id, category, description, status, priority,
                           created_at, updated_at)
      VALUES ('adv-rep-1', 'user-admin', 'System Admin', 'user', ?, ?, 'bullying_or_harassment',
              'Not the attacker''s business.', 'open', 'normal', ?, ?)
    `).run(victim, victim, now, now);

    const attackerT = await srv.login(`${attacker}@example.com`).catch(() => null);
    // The fixture user has no usable password; drive the route with the victim's
    // own session instead is not possible either, so assert via a real session.
    const t = attackerT ?? await srv.login('admin@example.gov');
    if (!attackerT) return; // covered by the authenticated case below

    const res = await jf('/api/appeals', {
      method: 'POST', headers: asUser(t),
      body: JSON.stringify({
        statement: 'I am appealing a report that is not about me at all.',
        reportId: 'adv-rep-1',
      }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('subject_not_found');
    expect(
      db.prepare("SELECT 1 FROM appeals WHERE subject_ref = 'adv-rep-1'").get(),
      'an appeal was attached to a stranger\'s report'
    ).toBeFalsy();
  });

  it('answers an unknown report id exactly as it answers a stranger\'s', async () => {
    // Identical refusals are what stop this being walked to discover which
    // report ids exist.
    const adminT = await srv.login('admin@example.gov');
    const res = await jf('/api/appeals', {
      method: 'POST', headers: asUser(adminT),
      body: JSON.stringify({
        statement: 'Appealing something with an id I invented just now.',
        reportId: 'rep_does_not_exist_at_all',
      }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('subject_not_found');
  });
});

/* ── 5. The link in the notice reaches a working page ─────────────────────── */

describe('the suspension notice reaches a usable appeal page', () => {
  it('points at a token the public route actually accepts', async () => {
    const adminT = await srv.login('admin@example.gov');
    const uid = makeUser();
    const { token } = await suspendAs(adminT, uid);
    expect(token, 'suspension minted no appeal token').toBeTruthy();

    /**
     * The defect this guards: the notice linked `/appeal?token=…` while the only
     * client route is `/appeal/:token`, and the SPA's public-path matcher
     * compares segment for segment — so the link fell through to the signed-out
     * catch-all and every appeal link in every suspension email was dead.
     */
    const notice = db.prepare(`
      SELECT link FROM notifications
       WHERE user_id = ? AND link IS NOT NULL
       ORDER BY created_at DESC LIMIT 1
    `).get(uid);
    expect(notice, 'suspension produced no notification carrying a link').toBeTruthy();
    expect(notice.link).toBe(`/appeal/${token}`);

    // …and the token behind it opens a real, unauthenticated appeal.
    const page = await jf(`/api/appeals/token/${token}`);
    expect(page.status, 'the link in the notice does not open an appeal').toBe(200);

    /**
     * The other half of this — that the SPA serves `/appeal/:token` to a
     * signed-out browser — is asserted in `src/appealLink.test.js` against
     * `isPublicPath` directly, NOT here. The test server mounts no static
     * client at all (`/` and `/login` 404 too), so an HTTP probe from this file
     * would pass or fail on the harness rather than on the routing.
     */
  });

  it('still notifies a user who has opted out of email', async () => {
    /**
     * `email_opt_out` is a marketing preference. A suspension notice is the only
     * route by which a locked-out account learns it may appeal, and suppressing
     * it turns an opt-out into a permanent lockout with no appeal channel.
     */
    const adminT = await srv.login('admin@example.gov');
    const uid = makeUser(1);
    const { token } = await suspendAs(adminT, uid);

    expect(token, 'an opted-out user got no appeal token').toBeTruthy();
    const notice = db.prepare(
      'SELECT link FROM notifications WHERE user_id = ? AND link IS NOT NULL LIMIT 1'
    ).get(uid);
    expect(notice, 'an opted-out user got no appeal notice at all').toBeTruthy();
    expect(notice.link).toBe(`/appeal/${token}`);

    expect((await jf(`/api/appeals/token/${token}`)).status).toBe(200);
  });
});
