/**
 * The leaderboard's ORDER BY, and the index underneath it.
 *
 * ── Why an ordering deserves its own file ──
 *
 * `routes.privacy.test.js` already covers WHO appears on this board — the
 * double opt-in, the deleted-account exclusion, the withheld school and grade.
 * This covers the other half, which was wrong in a way nothing would have
 * reported: the query ordered by hours then shifts and stopped, so every exact
 * tie was left to the planner.
 *
 * That is not cosmetic once there is a LIMIT. Ties at the twenty-fifth and
 * twenty-sixth positions decide **who is on the board at all**, and at the
 * bottom of a board ties are the normal case rather than the exotic one:
 * everyone on zero hours and zero shifts is tied with everyone else. A student
 * could drop off and reappear on refresh, having done nothing, and no test
 * would have failed.
 *
 * Audit finding P-2 named the missing index in the same query; both are fixed
 * together because the scan and the unstable order are two halves of one
 * neglected statement.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
let viewer;
let rawDb;

/** Students who tie exactly: same hours (none) and same shifts (none). */
const TIED = ['ldb-tie-a', 'ldb-tie-b', 'ldb-tie-c', 'ldb-tie-d', 'ldb-tie-e'];

beforeAll(async () => {
  srv = await startTestServer();
  viewer = await srv.login('leo.chen@example.com');
  ({ db: rawDb } = await import('./db.js'));

  /**
   * Inserted directly rather than through signup.
   *
   * The point is a set of rows that tie EXACTLY, and the ids have to be chosen
   * rather than generated so the expected order is something this file can
   * state. Signing five accounts up would hash five passwords for no benefit
   * and leave the ordering to whatever ids the server minted.
   *
   * They are inserted in reverse id order on purpose: if the endpoint were
   * returning insertion order, or the planner's scan order, that would look
   * identical to a correct answer whenever insertion order happened to match.
   */
  for (const id of [...TIED].reverse()) {
    await rawDb.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role,
                         verified, email_verified, account_status, created_at,
                         token_version, leaderboard_opt_in)
      VALUES (?, ?, ?, ?, 'x', '11', 'student', 1, 1, 'active', ?, 0, 1)
    `).run(id, `Tied ${id}`, `${id}@example.org`, id, new Date().toISOString());
  }
});

afterAll(async () => {
  for (const id of TIED) {
    await rawDb.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
  await srv.close();
});

const board = async () => {
  const res = await srv.call('GET', '/api/leaderboard', undefined, viewer);
  expect(res.status).toBe(200);
  return res.body;
};

describe('leaderboard ordering', () => {
  it('places the tied students in id order, not in whatever order they were written', async () => {
    const rows = await board();
    const tiedRanks = rows.filter(r => TIED.includes(r.id)).map(r => r.id);

    /* The fixture is only meaningful if the tied rows actually reached the
       page — a board that truncated before them would pass vacuously. */
    expect(tiedRanks).toHaveLength(TIED.length);
    expect(tiedRanks).toEqual([...TIED].sort());
  });

  it('returns the same order for two identical requests', async () => {
    /* The symptom a student would have reported: "I was fourth, I refreshed,
       now I am sixth". */
    const first = (await board()).map(r => r.id);
    const second = (await board()).map(r => r.id);
    const third = (await board()).map(r => r.id);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('keeps the same people on the board across requests, not just the same order', async () => {
    /* The worse half of the defect. With a LIMIT and no tiebreak, the rows at
       the cutoff are interchangeable, so membership itself flickers. */
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(new Set((await board()).map(r => r.id)));

    for (const run of runs.slice(1)) {
      expect([...run].sort()).toEqual([...runs[0]].sort());
    }
  });

  it('numbers ranks from 1 with no gaps, in the order returned', async () => {
    const rows = await board();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(r => r.rank)).toEqual(rows.map((_, i) => i + 1));
  });

  it('still ranks by hours first, so the tiebreak never outranks the metric', async () => {
    /* The tiebreak must be the LAST term. An id that sorted ahead of hours
       would be a board ordered by account id, which is a far worse bug than
       the one being fixed and would pass every test above. */
    const rows = await board();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].hours).toBeGreaterThanOrEqual(rows[i].hours);
      if (rows[i - 1].hours === rows[i].hours) {
        expect(rows[i - 1].shifts).toBeGreaterThanOrEqual(rows[i].shifts);
        if (rows[i - 1].shifts === rows[i].shifts) {
          expect(rows[i - 1].id < rows[i].id).toBe(true);
        }
      }
    }
  });
});

describe('the candidate index (audit finding P-2)', () => {
  it('exists on both engines', async () => {
    /* Created by migration 060 on SQLite and carried in the generated
       PostgreSQL baseline. Asserted by name because the name is what the
       reversal instructions in the migration tell an operator to drop. */
    const isPostgres = rawDb.dialect === 'postgres';
    const row = isPostgres
      ? await rawDb.prepare(
        "SELECT indexname AS name FROM pg_indexes WHERE indexname = 'idx_users_leaderboard'"
      ).get()
      : await rawDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_leaderboard'"
      ).get();

    expect(row?.name).toBe('idx_users_leaderboard');
  });

  it('is what the planner uses once the population reaches the thousands', async () => {
    /**
     * An index that exists and goes unused is the worst of both — the write
     * cost with none of the read benefit — and it is invisible without asking.
     * Migration 036 records the same check for the same reason.
     *
     * ── Why this populates the table first ──
     *
     * The planner's choice is a function of table SIZE, not only of the index.
     * Against the seeded fixture of a few dozen users SQLite correctly prefers
     * a scan, and asserting otherwise would be asserting a heuristic rather
     * than the index. Audit finding P-2 scoped the problem precisely — "fine at
     * target scale; the first index to add if the population reaches the
     * thousands" — so that is the condition this reproduces.
     *
     * The rows are opted OUT, which is the realistic shape: the opted-in set is
     * what makes the index selective, and it stays tiny while the table grows.
     *
     * SQLite only. The plan format is engine-specific, and reproducing this on
     * PostgreSQL would mean populating a shared test schema with thousands of
     * rows to assert the same thing about a different planner.
     */
    if (rawDb.dialect === 'postgres') return;

    const created = new Date().toISOString();
    try {
      for (let i = 0; i < 3000; i++) {
        await rawDb.prepare(`
          INSERT INTO users (id, name, email, username, password_hash, grade, role,
                             verified, email_verified, account_status, created_at,
                             token_version, leaderboard_opt_in)
          VALUES (?, ?, ?, ?, 'x', '11', 'student', 1, 1, 'active', ?, 0, 0)
        `).run(`ldb-bulk-${i}`, `Bulk ${i}`, `ldb-bulk-${i}@example.org`, `ldb-bulk-${i}`, created);
      }
      await rawDb.exec('ANALYZE');

      const plan = (await rawDb.prepare(`
        EXPLAIN QUERY PLAN
        SELECT u.id FROM users u
        WHERE u.role = 'student' AND u.leaderboard_opt_in = 1
      `).all()).map(r => r.detail).join(' | ');

      expect(plan).toContain('idx_users_leaderboard');
      /* The whole point of the finding: no full table read to choose 25 rows. */
      expect(plan).not.toMatch(/SCAN u\b/);
    } finally {
      await rawDb.exec("DELETE FROM users WHERE id LIKE 'ldb-bulk-%'");
      await rawDb.exec('ANALYZE');
    }
  }, 60_000);
});
