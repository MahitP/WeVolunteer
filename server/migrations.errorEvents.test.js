/**
 * Migration 004 — error_groups and error_events.
 *
 * Two things here are proved rather than assumed, and both would otherwise rest
 * on a default nobody in this repository set:
 *
 *   - **CASCADE actually fires.** `db.js` sets `journal_mode` and `busy_timeout`
 *     but never `PRAGMA foreign_keys = ON`. It is on because `node:sqlite`
 *     defaults it to 1 — a property of the runtime, not of this repository, and
 *     a Node upgrade could change it silently. If it ever does, the retention
 *     sweep starts leaving orphaned evidence behind, which is the exact failure
 *     the two-table design exists to prevent.
 *   - **The retention queries USE their indexes.** An index that exists and an
 *     index the planner chooses are different claims, and only the second one
 *     bounds anything. `EXPLAIN QUERY PLAN` is the only honest way to check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let srv;
beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
}, 60000);
afterAll(async () => { await srv?.close(); });

const getDb = async () => (await import('./db.js')).db;

const plan = (db, sql, ...params) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail).join(' | ');

describe('004_error_events — applies and registers', () => {
  it('records itself in schema_migrations as version 4 with a non-null checksum', async () => {
    const db = await getDb();
    const row = await db.prepare('SELECT name, checksum FROM schema_migrations WHERE version = 4').get();
    expect(row?.name).toBe('error_events');
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates both tables with the expected primary keys', async () => {
    const db = await getDb();
    for (const t of ['error_groups', 'error_events']) {
      expect(
        await db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', t),
        `${t} was not created`
      ).toBeTruthy();
    }
    const groupPk = (await db.prepare('PRAGMA table_info(error_groups)').all()).find(c => c.name === 'fingerprint');
    expect(groupPk?.pk).toBe(1);
    const eventPk = (await db.prepare('PRAGMA table_info(error_events)').all()).find(c => c.name === 'id');
    expect(eventPk?.pk).toBe(1);
  });

  /**
   * The columns are the privacy design. A `body`, `ip` or `user_id` column would
   * be filled by whoever added it, so their absence is asserted rather than left
   * to the reviewer of a future diff.
   */
  it('stores a hash and not an id, and offers nowhere to put a body, an IP or a URL', async () => {
    const db = await getDb();
    const cols = (await db.prepare('PRAGMA table_info(error_events)').all()).map(c => c.name);

    expect(cols).toContain('user_hash');
    for (const forbidden of ['user_id', 'body', 'request_body', 'ip', 'ip_address', 'url', 'email']) {
      expect(cols, `error_events.${forbidden} would invite raw PII`).not.toContain(forbidden);
    }

    const groupCols = (await db.prepare('PRAGMA table_info(error_groups)').all()).map(c => c.name);
    for (const forbidden of ['user_id', 'body', 'ip', 'url', 'severity']) {
      expect(groupCols, `error_groups.${forbidden} is not part of this design`).not.toContain(forbidden);
    }
  });

  it('is idempotent — a second runMigrations applies nothing and throws nothing', async () => {
    const db = await getDb();
    const { runMigrations } = await import('./migrations/index.js');
    const before = (await db.prepare('SELECT COUNT(*) c FROM error_groups').get()).c;

    let out;
    expect(() => { out = runMigrations(db); }).not.toThrow();

    expect(out.applied).toEqual([]);
    expect(out.skipped).toContain('4_error_events');
    expect((await db.prepare('SELECT COUNT(*) c FROM error_groups').get()).c).toBe(before);
    // Re-running must not have duplicated the schema objects either.
    expect((await db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('error_groups','error_events')"
    ).get()).c).toBe(2);
  });
});

describe('004_error_events — constraints behave', () => {
  const group = (fp, over = {}) => ({
    fingerprint: fp, source: 'server', kind: 'TypeError', message: 'x',
    status: 'open', first: '2026-08-03T00:00:00.000Z', last: '2026-08-03T00:00:00.000Z', ...over
  });
  const insertGroup = (db, g) => db.prepare(`
    INSERT INTO error_groups (fingerprint, source, kind, message, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(g.fingerprint, g.source, g.kind, g.message, g.status, g.first, g.last);

  it('refuses a source outside the closed set', async () => {
    const db = await getDb();
    await expect(async () => insertGroup(db, group('fp-bad-source', { source: 'browser' }))).rejects.toThrow();
    await insertGroup(db, group('fp-ok-source', { source: 'worker' }));
  });

  it('refuses a status outside the closed set, and defaults to open', async () => {
    const db = await getDb();
    await expect(async () => insertGroup(db, group('fp-bad-status', { status: 'wontfix' }))).rejects.toThrow();

    await db.prepare(`
      INSERT INTO error_groups (fingerprint, source, kind, message, first_seen_at, last_seen_at)
      VALUES ('fp-default-status', 'server', 'Error', 'm', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
    `).run();
    expect(
      await db.prepare("SELECT status, occurrences, users_seen FROM error_groups WHERE fingerprint = 'fp-default-status'").get()
    ).toEqual({ status: 'open', occurrences: 0, users_seen: 0 });
  });

  it('refuses an event whose group does not exist', async () => {
    const db = await getDb();
    await expect(async () => db.prepare(`
      INSERT INTO error_events (id, fingerprint, occurred_at) VALUES ('ev-orphan', 'fp-never-existed', ?)
    `).run('2026-08-03T00:00:00.000Z')).rejects.toThrow();
  });

  it('round-trips an event through every column', async () => {
    const db = await getDb();
    insertGroup(db, group('fp-roundtrip'));
    const at = '2026-08-03T01:02:03.000Z';
    await db.prepare(`
      INSERT INTO error_events
        (id, fingerprint, occurred_at, stack, route, method, status_code, user_hash, role, user_agent, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ev-rt', 'fp-roundtrip', at, 'at foo()', '/api/events/:id', 'GET', 500,
      'a'.repeat(32), 'student', 'Safari/iOS', '{"component":"X"}');

    expect(await db.prepare('SELECT * FROM error_events WHERE id = ?').get('ev-rt')).toEqual({
      id: 'ev-rt', fingerprint: 'fp-roundtrip', occurred_at: at, stack: 'at foo()',
      route: '/api/events/:id', method: 'GET', status_code: 500,
      user_hash: 'a'.repeat(32), role: 'student', user_agent: 'Safari/iOS',
      context: '{"component":"X"}'
    });
  });
});

describe('004_error_events — retention can actually delete', () => {
  /**
   * The claim the whole two-table design rests on: pruning a group takes its
   * evidence with it. If foreign keys were off, this passes silently as a no-op
   * on the parent delete and leaves orphans forever — so the assertion is on the
   * CHILD count, not on the parent.
   */
  it('cascades: deleting a group removes its events', async () => {
    const db = await getDb();
    await db.prepare(`
      INSERT INTO error_groups (fingerprint, source, kind, message, first_seen_at, last_seen_at)
      VALUES ('fp-cascade', 'client', 'TypeError', 'boom', ?, ?)
    `).run('2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
    for (let i = 0; i < 3; i++) {
      await db.prepare('INSERT INTO error_events (id, fingerprint, occurred_at) VALUES (?, ?, ?)')
        .run(`ev-casc-${i}`, 'fp-cascade', '2026-08-03T00:00:00.000Z');
    }
    expect((await db.prepare("SELECT COUNT(*) c FROM error_events WHERE fingerprint = 'fp-cascade'").get()).c).toBe(3);

    await db.prepare("DELETE FROM error_groups WHERE fingerprint = 'fp-cascade'").run();

    expect(
      (await db.prepare("SELECT COUNT(*) c FROM error_events WHERE fingerprint = 'fp-cascade'").get()).c,
      'orphaned events survived the group — foreign keys are off, so retention leaks'
    ).toBe(0);
  });

  it('leaves no orphan reachable by any means after a group is pruned', async () => {
    const db = await getDb();
    const orphans = (await db.prepare(`
      SELECT COUNT(*) c FROM error_events e
      LEFT JOIN error_groups g ON g.fingerprint = e.fingerprint
      WHERE g.fingerprint IS NULL
    `).get()).c;
    expect(orphans, 'error_events rows with no surviving group').toBe(0);
  });
});

describe('004_error_events — the sweep and ceiling queries use their indexes', () => {
  it('creates all four indexes', async () => {
    const db = await getDb();
    const names = (await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('error_groups','error_events')"
    ).all()).map(r => r.name);
    for (const idx of [
      'idx_error_groups_triage', 'idx_error_groups_source',
      'idx_error_events_group', 'idx_error_events_occurred'
    ]) {
      expect(names, `${idx} missing`).toContain(idx);
    }
    expect((await db.prepare('PRAGMA index_info(idx_error_events_occurred)').all()).map(c => c.name))
      .toEqual(['occurred_at']);
  });

  /**
   * An index that exists and an index the planner picks are different claims.
   * The 30-day event sweep filters on occurred_at alone; if it ever falls back
   * to a scan, the retention pass walks the largest table in the schema on every
   * run — the failure this table exists to avoid.
   */
  it('plans the 30-day event sweep against idx_error_events_occurred, not a scan', async () => {
    const db = await getDb();
    const detail = plan(db, 'DELETE FROM error_events WHERE occurred_at < ?', '2026-01-01T00:00:00.000Z');
    expect(detail).toContain('idx_error_events_occurred');
    expect(detail).not.toMatch(/SCAN error_events(?! USING)/);
  });

  /**
   * The client-group ceiling runs on every unauthenticated report that would
   * open a new group. Unindexed, the defence scans the table it is bounding,
   * once per attack request.
   */
  it('plans the client-group ceiling against idx_error_groups_source, not a scan', async () => {
    const db = await getDb();
    const detail = plan(db,
      'SELECT COUNT(*) FROM error_groups WHERE source = ? AND status = ?', 'client', 'open');
    expect(detail).toContain('idx_error_groups_source');
    expect(detail).not.toMatch(/SCAN error_groups(?! USING)/);
  });

  it('plans the triage read and the per-group event read against their indexes', async () => {
    const db = await getDb();
    expect(plan(db,
      "SELECT * FROM error_groups WHERE status = 'open' ORDER BY last_seen_at DESC"
    )).toContain('idx_error_groups_triage');

    expect(plan(db,
      'SELECT * FROM error_events WHERE fingerprint = ? ORDER BY occurred_at DESC', 'fp-x'
    )).toContain('idx_error_events_group');
  });
});
