import { describe, it, expect, afterAll } from 'vitest';
import { PostgresDatabase } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';
import { applyPostgresSchema } from './db/postgresSchema.js';
import { randomUUID } from 'node:crypto';

/**
 * A clean PostgreSQL database must contain the reserved `system-cli` actor.
 *
 * `postgresSchema.js` is generated from the migrations' DDL. Migration 022
 * creates the actor with an INSERT — DML — which the generator drops, so a fresh
 * PostgreSQL database came up structurally complete and semantically
 * incomplete: all 65 tables and 87 foreign keys, and not the one row
 * `assertSystemActor()` requires. Every privileged command refuses without it,
 * so a fresh deployment had no sanctioned way to create its FIRST OWNER. Found
 * on the real production Supabase database.
 *
 * ── The trap this test also guards ──
 *
 * Seeding the actor broke 124 test files on the first attempt, because
 * `db.js` decided whether to seed a demo database with
 * `SELECT COUNT(*) FROM users === 0` — and the reserved actor is a row. A brand
 * new database looked already-initialised, seeded nothing, and every test lost
 * its users (mass 401s, organizer foreign-key violations).
 *
 * SQLite never showed it, purely by ordering: `runMigrations` runs LAST in
 * `initDatabase()`, so migration 022 creates the actor AFTER that check. The
 * gates now exclude the actor on both engines, which is what "empty" was always
 * supposed to mean.
 */
const URL_ = process.env.TEST_POSTGRES_URL;

describe.skipIf(!URL_)('applyPostgresSchema seeds the reserved system actor', () => {
  const made = [];
  const freshSchema = async () => {
    const ns = `wev_sysc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const admin = new PostgresDatabase({ connectionString: URL_, translate: translatePlaceholders, max: 2 });
    await admin.exec(`CREATE SCHEMA ${ns}`);
    await admin.close();
    const db = new PostgresDatabase({
      connectionString: `${URL_}${URL_.includes('?') ? '&' : '?'}options=-c%20search_path%3D${ns}`,
      translate: translatePlaceholders,
      max: 2,
    });
    made.push({ ns, db });
    return db;
  };

  afterAll(async () => {
    for (const { ns, db } of made) {
      await db.close().catch(() => {});
      const admin = new PostgresDatabase({ connectionString: URL_, translate: translatePlaceholders, max: 1 });
      await admin.exec(`DROP SCHEMA IF EXISTS ${ns} CASCADE`).catch(() => {});
      await admin.close().catch(() => {});
    }
  }, 60_000);

  it('creates it, tombstoned so it cannot be used as an account', async () => {
    const db = await freshSchema();
    await applyPostgresSchema(db);

    const row = await db.prepare(
      'SELECT id, role, account_status, email, username, password_hash, email_verified FROM users WHERE id = ?'
    ).get('system-cli');

    expect(row, 'a clean PostgreSQL database has no system-cli — every privileged CLI refuses').toBeTruthy();
    /* Presence alone is not enough: migration 022 tombstones the actor so it
       cannot sign in, cannot reach a roster, and cannot be mistaken for a
       person. A row with the right id and the wrong shape would satisfy
       assertSystemActor and still be wrong. */
    expect(row.role).toBe('student');
    expect(row.account_status).toBe('deleted');
    expect(row.email).toBe('system-cli@wevolunteer.invalid');
    expect(row.username).toBe('system_cli');
    expect(row.password_hash).toBe('!SYSTEM_ACCOUNT_NO_LOGIN!');
    expect(Number(row.email_verified)).toBe(0);
  }, 60_000);

  it('is not a bcrypt hash, so no password can ever match it', async () => {
    /* The sentinel is what makes the account unusable. A real hash here — even
       of an unknown password — would be a login waiting to be brute-forced. */
    const db = await freshSchema();
    await applyPostgresSchema(db);
    const { password_hash: h } = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get('system-cli');
    expect(h.startsWith('$2')).toBe(false);
  }, 60_000);

  it('stays exactly one across repeated application', async () => {
    /* applyPostgresSchema runs at every boot, so a non-idempotent seed would
       throw on the second start or accumulate duplicate actors. */
    const db = await freshSchema();
    await applyPostgresSchema(db);
    await applyPostgresSchema(db);
    await applyPostgresSchema(db);
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get('system-cli');
    expect(Number(n), 'repeated schema application duplicated the reserved actor').toBe(1);
  }, 60_000);

  it('does not make a fresh database look already-initialised', async () => {
    /* The regression that broke 124 files. `db.js` asks "is this database
       empty" to decide whether to seed; the answer must not change just because
       the reserved actor exists. */
    const db = await freshSchema();
    await applyPostgresSchema(db);
    const { count } = await db.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE id <> 'system-cli'"
    ).get();
    expect(Number(count), 'the emptiness gate would skip seeding on a brand-new database').toBe(0);
  }, 60_000);
});
