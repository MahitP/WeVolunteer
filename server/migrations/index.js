/**
 * Ordered, versioned schema migrations.
 *
 * db.js keeps its `CREATE TABLE IF NOT EXISTS` + addColumnIfMissing() bootstrap
 * for the tables that predate this registry — rewriting that is risk with no
 * reward. Everything structural from v1.2 onward goes here instead, because the
 * next few changes are table REBUILDS (SQLite cannot alter a CHECK constraint)
 * and those need ordering, a record of what already ran, and a rollback story.
 */
import { createHash } from 'node:crypto';
import authzRoles from './001_authz_roles.js';
import userCapabilities from './002_user_capabilities.js';

export const MIGRATIONS = [authzRoles, userCapabilities];

const label = (m) => `${m.version}_${m.name}`;

const checksumOf = (m) => createHash('sha256').update(String(m.up)).digest('hex');

function ensureBookkeeping(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // checksum is nullable and added via ALTER TABLE, not part of the CREATE
  // TABLE above, because databases that ran before this guard existed already
  // have rows with no checksum — see the NULL-checksum handling in
  // runMigrations() for why those rows must throw rather than be backfilled.
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all();
  if (!columns.some(c => c.name === 'checksum')) {
    db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  }
}

export function appliedVersions(db) {
  ensureBookkeeping(db);
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
}

/**
 * Builds the "what happened, what to do" text shared by both checksum-failure
 * cases. Whoever hits this is at boot, with no other context, so the message
 * carries the full remedy rather than pointing at documentation.
 */
function checksumErrorMessage(m, reason) {
  return (
    `Migration ${label(m)} is recorded as applied, but its stored checksum ${reason}. `
    + "This means the migration's code may not match what actually ran against this "
    + 'database — running it now could silently do nothing or duplicate work. '
    + `Verify by hand whether ${label(m)}'s schema change is already present: `
    + `if it is NOT present, delete the row WHERE version = ${m.version} from `
    + 'schema_migrations and restart so the migration runs for real. '
    + `If the change IS already present, do NOT delete the row — investigate why the `
    + 'checksum disagrees before doing anything else.'
  );
}

/**
 * Applies every migration not yet recorded, lowest version first.
 *
 * Each migration runs inside its own transaction so a failure leaves the
 * database exactly as it was — including the schema_migrations row, which is
 * written inside the same transaction as the DDL it describes. A migration that
 * manages its own transaction (the table rebuilds must, because
 * `PRAGMA foreign_keys` cannot change inside one) sets `ownTransaction = true`.
 */
export function runMigrations(db, migrations = MIGRATIONS) {
  ensureBookkeeping(db);

  const seenVersions = new Set();
  for (const m of migrations) {
    if (seenVersions.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seenVersions.add(m.version);
  }

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const alreadyRows = db.prepare('SELECT version, checksum FROM schema_migrations').all();
  const already = new Map(alreadyRows.map(r => [r.version, r.checksum]));
  const applied = [], skipped = [];

  for (const m of ordered) {
    if (already.has(m.version)) {
      const stored = already.get(m.version);
      if (stored === null) {
        throw new Error(checksumErrorMessage(m, 'is missing (NULL)'));
      }
      if (stored !== checksumOf(m)) {
        throw new Error(checksumErrorMessage(m, "does not match the migration's current source"));
      }
      skipped.push(label(m));
      continue;
    }

    const record = () => db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)'
    ).run(m.version, m.name, new Date().toISOString(), checksumOf(m));

    try {
      if (m.ownTransaction) {
        m.up(db);
        record();
      } else {
        db.exec('BEGIN');
        try { m.up(db); record(); db.exec('COMMIT'); }
        catch (err) { db.exec('ROLLBACK'); throw err; }
      }
      console.log(`Migration applied: ${label(m)}`);
      applied.push(label(m));
    } catch (err) {
      throw new Error(`Migration ${label(m)} failed: ${err.message}`, { cause: err });
    }
  }

  return { applied, skipped };
}
