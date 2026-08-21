import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-roster-mig-'));
process.env.WEV_DB_PATH = path.join(dir, 'roster.db');

let db, roster, promotionMetadata;

beforeAll(async () => {
  const dbModule = await import('./db.js');
  dbModule.initDatabase();
  await dbModule.completeDatabaseInit();
  db = dbModule.db;
  roster = (await import('./migrations/020_administrator_roster.js')).default;
  promotionMetadata = (await import('./migrations/021_administrator_promotion_metadata.js')).default;
});

const columns = async (table) =>
  (await db.prepare(`PRAGMA table_info(${table})`).all()).map((c) => c.name);

/**
 * Both migrations add columns, and SQLite's `ALTER TABLE ADD COLUMN` has no
 * `IF NOT EXISTS`. Re-running an unguarded one throws `duplicate column name`.
 *
 * That matters more than it looks. `runMigrations` records applied versions in
 * `schema_migrations`, so in normal operation each runs exactly once — which is
 * precisely why an unguarded ADD COLUMN survives review: nothing exercises the
 * second application until a checksum dispute, a restored backup, or a
 * hand-repaired `schema_migrations` row makes it happen, and by then it is a
 * boot failure on a database somebody is trying to recover.
 *
 * Both of these shipped unguarded. This file is why they no longer are.
 */
describe('migrations 020 and 021 are idempotent', () => {
  it('020 adds last_sign_in_at and the actor-aggregation index', async () => {
    expect(await columns('users')).toContain('last_sign_in_at');
    const indexes = (await db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'admin_audit_logs'
    `).all()).map((i) => i.name);
    expect(indexes).toContain('idx_admin_audit_logs_actor_aggregation');
  });

  it('021 adds the three promotion-metadata columns', async () => {
    const cols = await columns('users');
    expect(cols).toContain('promoted_at');
    expect(cols).toContain('promoted_by');
    expect(cols).toContain('promotion_reason');
  });

  it('020 can be applied a second time without throwing', async () => {
    expect(() => roster.up(db)).not.toThrow();
    expect((await columns('users')).filter((c) => c === 'last_sign_in_at')).toHaveLength(1);
  });

  it('021 can be applied a second time without throwing', async () => {
    expect(() => promotionMetadata.up(db)).not.toThrow();
    expect((await columns('users')).filter((c) => c === 'promoted_at')).toHaveLength(1);
    expect((await columns('users')).filter((c) => c === 'promoted_by')).toHaveLength(1);
    expect((await columns('users')).filter((c) => c === 'promotion_reason')).toHaveLength(1);
  });

  /**
   * `promoted_by` names the account that made the decision and must NOT carry a
   * foreign key to `users` — Volume I §1.7.5: a record of an event must not be
   * deleted with the subject of that event. A cascade here would silently erase
   * the attribution when an owner's row is removed.
   */
  it('promoted_by is not a foreign key to users', async () => {
    const fks = await db.prepare('PRAGMA foreign_key_list(users)').all();
    expect(fks.map((f) => f.from)).not.toContain('promoted_by');
  });
});
