import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `disqualifiersForMany` must agree with `disqualifiers`, always.
 *
 * ── Why this file exists ──
 *
 * The moderation queue used to answer "may this reviewer decide this appeal?"
 * one appeal at a time: six statements each — a redundant re-read of the row it
 * already held, plus the five `disqualifiers()` makes. Fifty appeals cost about
 * three hundred statements in series, which on `node:sqlite` was free and on
 * PostgreSQL is three hundred network round trips to draw one screen.
 *
 * The batched loader answers the same question for a whole page in five. That is
 * a good trade only if the two paths cannot disagree, because the thing they
 * decide is whether a suspended student's appeal is heard by somebody with a
 * stake in the outcome — a fairness guarantee published to minors in
 * `src/views/Appeal.jsx`, not a performance detail.
 *
 * So the rules live in ONE function (`applyConflictRules`, private to
 * appeals.js) and both loaders feed it. These tests are what proves the feeding
 * is equivalent: every case below is checked BOTH ways and the answers compared,
 * so a future edit to one path that changes an outcome fails here.
 */
let srv, db, disqualifiers, disqualifiersForMany;

let seq = 0;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ disqualifiers, disqualifiersForMany } = await import('./appeals.js'));

  const seeded = await db.prepare("SELECT password_hash FROM users WHERE id = 'user-admin'").get();
  await db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username, email_verified,
                       account_status, created_at)
    VALUES ('batch-reviewer', 'batch.reviewer@example.gov', ?, 'Batch Reviewer', 'admin', 'N/A',
            'batchreviewer', 1, 'active', ?)
    ON CONFLICT DO NOTHING
  `).run(seeded.password_hash, new Date().toISOString());
}, 60000);

afterAll(async () => { await srv?.close(); });

const jf = (p, o = {}) => fetch(srv.base + p, {
  ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
});

const adminToken = () => srv.login('admin@example.gov');

async function makeUser() {
  const id = `bc-user-${++seq}`;
  await db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username,
                       email_verified, account_status, created_at)
    VALUES (?, ?, 'h', ?, 'student', '9', ?, 1, 'active', ?)
  `).run(id, `${id}@example.com`, `Batch Student ${seq}`, id.replace(/-/g, '_'),
    new Date().toISOString());
  return id;
}

/** Suspends a user through the real route, so the audit row and token are real too. */
async function suspendAndAppeal(uid) {
  const t = await adminToken();
  await jf(`/api/admin/users/${uid}/suspend`, {
    method: 'POST',
    headers: { Cookie: `wev_session=${t}` },
    body: JSON.stringify({ reason: 'Batched-conflict fixture.' }),
  });
  const token = (await db.prepare(
    'SELECT token FROM appeal_tokens WHERE user_id = ? AND used_at IS NULL ORDER BY expires_at DESC'
  ).get(uid))?.token;
  await jf(`/api/appeals/token/${token}`, {
    method: 'POST', body: JSON.stringify({ statement: 'I would like this looked at again please.' }),
  });
  return db.prepare('SELECT * FROM appeals WHERE user_id = ?').get(uid);
}

/**
 * Inserts a report, with the column names and the target_type vocabulary the
 * schema actually has (`category`, not `reason`; `comment`, not `event_comment`).
 */
async function makeReport({ id, reporter, targetAuthor, status = 'open', assignedTo = null }) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO reports (id, target_type, target_id, reporter_id, target_author_id,
                         category, description, status, assigned_to, created_at, updated_at)
    VALUES (?, 'comment', ?, ?, ?, 'other', 'Batched-conflict fixture.', ?, ?, ?, ?)
  `).run(id, `target-for-${id}`, reporter, targetAuthor, status, assignedTo, now, now);
  return id;
}

/**
 * Asks both paths and asserts they agree, returning the answer.
 *
 * Order is not compared — `disqualifiers` builds its array in rule order and so
 * does the batched path, but the guarantee that matters is the SET of reasons.
 */
async function bothWays(actorId, appeal) {
  const single = await disqualifiers(db, actorId, appeal);
  const many = await disqualifiersForMany(db, actorId, [appeal]);
  const batched = many.get(appeal.id);
  expect(batched, 'the batched path returned nothing for this appeal').toBeDefined();
  expect([...batched].sort()).toEqual([...single].sort());
  return single;
}

describe('the two paths agree, rule by rule', () => {
  it('agrees on self-review', async () => {
    const uid = await makeUser();
    const appeal = await suspendAndAppeal(uid);
    expect(await bothWays(uid, appeal)).toContain('self');
  });

  it('agrees on the administrator who issued the suspension', async () => {
    const uid = await makeUser();
    const appeal = await suspendAndAppeal(uid);
    // The seeded admin suspended them, so they are the issuer.
    const reasons = await bothWays('user-admin', appeal);
    expect(reasons).toContain('suspension_issuer');
    // And the audit trail says so independently of the live column.
    expect(reasons).toContain('suspension_auditor');
  });

  it('agrees that an uninvolved reviewer has no conflict at all', async () => {
    const uid = await makeUser();
    const appeal = await suspendAndAppeal(uid);
    expect(await bothWays('batch-reviewer', appeal)).toEqual([]);
  });

  it('agrees on the live suspended_by column after a re-suspension', async () => {
    const uid = await makeUser();
    const appeal = await suspendAndAppeal(uid);
    /* Rule 3 reads the LIVE column, which catches somebody who suspended this
       account after the appeal was filed — a different administrator from the
       one frozen into the snapshot. */
    await db.prepare('UPDATE users SET suspended_by = ? WHERE id = ?').run('batch-reviewer', uid);
    expect(await bothWays('batch-reviewer', appeal)).toContain('suspension_issuer');
  });

  it('agrees on involvement in the report behind the appeal', async () => {
    const uid = await makeUser();
    const reporter = await makeUser();
    const appeal = await suspendAndAppeal(uid);

    const reportId = await makeReport({
      id: `bc-report-${seq}`, reporter, targetAuthor: uid, assignedTo: 'batch-reviewer',
    });
    /* `report_id` is attached in memory rather than written, because migration
       015's trigger refuses it — "what an appeal contests is a record: only the
       review workflow may change" — and that refusal is correct and worth
       leaving intact. Both conflict paths take the appeal row as an argument and
       read `report_id` off it, so an object carrying the link exercises rules
       5-7 exactly as a stored one would. */
    const withReport = { ...appeal, report_id: reportId };
    expect(await bothWays('batch-reviewer', withReport)).toContain('report_handler');
    expect(await bothWays(reporter, withReport)).toContain('reporter');
  });

  it('agrees on a live report crossing between reviewer and appellant', async () => {
    const uid = await makeUser();
    const appeal = await suspendAndAppeal(uid);

    // Filed BY the appellant AGAINST the would-be reviewer — the direction that
    // is easiest to get wrong when the query is widened to a whole page.
    await makeReport({ id: `bc-cross-${seq}`, reporter: uid, targetAuthor: 'batch-reviewer' });

    expect(await bothWays('batch-reviewer', appeal)).toContain('cross_report');
  });

  it('agrees that a RESOLVED crossing report is not a conflict', async () => {
    const uid = await makeUser();
    const appeal = await suspendAndAppeal(uid);
    await makeReport({
      id: `bc-closed-${seq}`, reporter: uid, targetAuthor: 'batch-reviewer', status: 'resolved',
    });

    expect(await bothWays('batch-reviewer', appeal)).not.toContain('cross_report');
  });

  it('agrees on whoever reopened the appeal', async () => {
    const uid = await makeUser();
    const appeal = await suspendAndAppeal(uid);
    await db.prepare(`
      INSERT INTO appeal_events (id, appeal_id, action, actor_id, created_at)
      VALUES (?, ?, 'reopened', 'batch-reviewer', ?)
    `).run(`bc-ev-${seq}`, appeal.id, new Date().toISOString());

    expect(await bothWays('batch-reviewer', appeal)).toContain('reopener');
  });
});

describe('a mixed page is answered per row, not per page', () => {
  it('gives each appeal its own reasons in one batched call', async () => {
    const clean = await makeUser();
    const crossed = await makeUser();
    const cleanAppeal = await suspendAndAppeal(clean);
    const crossedAppeal = await suspendAndAppeal(crossed);

    await makeReport({ id: `bc-mix-${seq}`, reporter: crossed, targetAuthor: 'batch-reviewer' });

    const many = await disqualifiersForMany(db, 'batch-reviewer', [cleanAppeal, crossedAppeal]);
    expect(many.get(cleanAppeal.id)).toEqual([]);
    expect(many.get(crossedAppeal.id)).toContain('cross_report');

    // And the per-appeal path says the same about each.
    expect(await disqualifiers(db, 'batch-reviewer', cleanAppeal)).toEqual([]);
    expect(await disqualifiers(db, 'batch-reviewer', crossedAppeal)).toContain('cross_report');
  });

  it('returns an empty map for an empty page without touching the database', async () => {
    const spy = vi.spyOn(db, 'prepare');
    try {
      const many = await disqualifiersForMany(db, 'batch-reviewer', []);
      expect(many.size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the batching is actually a batch', () => {
  it('costs a fixed number of statements regardless of page size', async () => {
    const appeals = [];
    for (let i = 0; i < 6; i++) {
      appeals.push(await suspendAndAppeal(await makeUser()));
    }

    const original = db.prepare;
    const count = (n) => {
      let calls = 0;
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => { calls++; return original(sql); });
      return { spy, read: () => calls, n };
    };

    const small = count(1);
    await disqualifiersForMany(db, 'batch-reviewer', appeals.slice(0, 1));
    const smallCalls = small.read();
    small.spy.mockRestore();

    const large = count(6);
    await disqualifiersForMany(db, 'batch-reviewer', appeals);
    const largeCalls = large.read();
    large.spy.mockRestore();

    // Six appeals must not cost six times one appeal. Same fixed set of lookups.
    expect(largeCalls).toBe(smallCalls);
    expect(largeCalls).toBeLessThanOrEqual(5);
  });
});
