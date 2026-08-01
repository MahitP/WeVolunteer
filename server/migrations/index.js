/**
 * Ordered, versioned schema migrations.
 *
 * db.js keeps its `CREATE TABLE IF NOT EXISTS` + addColumnIfMissing() bootstrap
 * for the tables that predate this registry — rewriting that is risk with no
 * reward. Everything structural from v1.2 onward goes here instead, because the
 * next few changes are table REBUILDS (SQLite cannot alter a CHECK constraint)
 * and those need ordering, a record of what already ran, and a rollback story.
 */
import authzRoles from './001_authz_roles.js';
import userCapabilities from './002_user_capabilities.js';

export const MIGRATIONS = [authzRoles, userCapabilities];

const label = (m) => `${m.version}_${m.name}`;

function ensureBookkeeping(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

export function appliedVersions(db) {
  ensureBookkeeping(db);
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
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
  const already = new Set(appliedVersions(db));
  const applied = [], skipped = [];

  for (const m of ordered) {
    if (already.has(m.version)) { skipped.push(label(m)); continue; }

    const record = () => db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(m.version, m.name, new Date().toISOString());

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
