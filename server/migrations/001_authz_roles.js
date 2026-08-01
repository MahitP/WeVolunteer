/**
 * Adds 'super_admin' and 'partner' to users.role.
 *
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt. Two hazards
 * govern the shape of this code:
 *
 *   1. node:sqlite enables foreign keys by DEFAULT, and 15+ tables reference
 *      users(id) ON DELETE CASCADE. DROP TABLE users with foreign keys ON
 *      cascade-deletes most of the database. Hence PRAGMA foreign_keys = OFF.
 *   2. PRAGMA foreign_keys is a silent no-op inside a transaction, so it must be
 *      set before BEGIN. Hence ownTransaction = true.
 *
 * The copy uses an EXPLICIT column list, not SELECT *. The pre-existing
 * `applications` rebuild in db.js used SELECT *, which works only while column
 * order matches exactly — and column order here depends on the order historical
 * addColumnIfMissing() calls happened to run on that particular database. That
 * is not hypothetical: on the pilot database `email_verified` sits before
 * `account_status`/`deleted_at`, while a freshly seeded database has it after
 * them. SELECT * would have written email_verified into account_status.
 */

export const EXPECTED_USER_COLUMNS = [
  'id', 'name', 'email', 'password_hash', 'grade', 'role', 'verified',
  'avatar', 'bio', 'school', 'skills', 'leaderboard_opt_in', 'username',
  'profile_visibility', 'created_at', 'token_version', 'email_opt_out',
  'account_status', 'deleted_at', 'email_verified', 'username_changed_at',
];

/**
 * Row counts for every table holding a foreign key to `users`.
 *
 * Derived from the schema rather than hardcoded: 15+ tables reference users(id)
 * and more get added over time, so a literal list would silently stop covering
 * the newest ones — the exact tables a stale guard would fail to protect. Tables
 * absent from a given database (a partially-built test fixture) simply do not
 * appear in the result. On the pilot schema this covers 19 tables.
 *
 * Only DIRECT references are collected, and that is sufficient: a table like
 * `slots` cascades from `events` rather than from `users`, so it cannot be
 * emptied without `events` — which is in this set — being emptied first.
 */
function countCascadingChildren(db) {
  const counts = {};
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);

  for (const table of tables) {
    if (table === 'users' || table === 'users_new') continue;
    // Table names come from sqlite_master, never from user input.
    const references = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .some(fk => fk.table === 'users');
    if (references) counts[table] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  }
  return counts;
}

function up(db) {
  // Already rebuilt? The CHECK text is the cheapest reliable probe.
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (existing?.sql?.includes("'super_admin'")) return;

  // Guard: if this database has columns this migration doesn't know about, the
  // explicit copy below would silently DROP them. Fail loudly instead.
  const actual = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  const unknown = actual.filter(c => !EXPECTED_USER_COLUMNS.includes(c));
  const missing = EXPECTED_USER_COLUMNS.filter(c => !actual.includes(c));
  if (unknown.length) {
    throw new Error(
      `users has unexpected columns [${unknown.join(', ')}]. Add them to `
      + 'EXPECTED_USER_COLUMNS and to the CREATE TABLE below, then re-run. '
      + 'Copying without them would delete that data.'
    );
  }
  if (missing.length) {
    throw new Error(
      `users is missing expected columns [${missing.join(', ')}]. `
      + 'initDatabase() must run its addColumnIfMissing() pass before migrations.'
    );
  }

  const cols = EXPECTED_USER_COLUMNS.join(', ');
  const fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;

  db.exec('PRAGMA foreign_keys = OFF');       // MUST be outside the transaction
  try {
    /**
     * Verify the pragma actually took. This is the one failure in this file that
     * nothing else can catch:
     *
     *   - the row-count check below counts `users`, and users rows are COPIED —
     *     they survive a cascade untouched;
     *   - `PRAGMA foreign_key_check` finds nothing, because a cascade DELETES the
     *     children rather than orphaning them, so no violation remains to report;
     *   - the ROLLBACK below never fires, because nothing threw.
     *
     * So without this check the migration would commit an emptied database and
     * report success. Setting the pragma inside an open transaction is a silent
     * no-op, which is exactly how that would happen. Today the registry does not
     * wrap `ownTransaction` migrations — but that is a property of a different
     * file, and this one should not depend on it silently.
     */
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 0) {
      throw new Error(
        'PRAGMA foreign_keys = OFF did not take effect — a transaction is already open. '
        + 'Aborting: DROP TABLE users would cascade-delete the database.'
      );
    }

    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          grade TEXT CHECK(grade IN ('9', '10', '11', '12', 'Adult', 'N/A')) NOT NULL,
          role TEXT CHECK(role IN ('student', 'organizer', 'admin', 'super_admin', 'partner')) NOT NULL,
          verified INTEGER DEFAULT 1,
          avatar TEXT,
          bio TEXT,
          school TEXT,
          skills TEXT,
          leaderboard_opt_in INTEGER DEFAULT 0,
          username TEXT UNIQUE,
          profile_visibility TEXT CHECK(profile_visibility IN ('private', 'friends', 'public')) DEFAULT 'private',
          created_at TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 0,
          email_opt_out INTEGER DEFAULT 0,
          account_status TEXT CHECK(account_status IN ('active', 'deleted', 'suspended')) DEFAULT 'active',
          deleted_at TEXT,
          email_verified INTEGER DEFAULT 0,
          username_changed_at TEXT
        )
      `);

      // Second layer of defence for the same failure. The pragma check above
      // proves foreign keys are off *now*; this proves no child row actually
      // vanished, whatever the cause. Snapshot before anything is mutated, and
      // compare after the rename so a loss throws and the ROLLBACK below undoes
      // it — the catastrophic path becomes recoverable rather than merely
      // detectable.
      const childCounts = countCascadingChildren(db);

      const before = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      db.exec(`INSERT INTO users_new (${cols}) SELECT ${cols} FROM users`);
      const after = db.prepare('SELECT COUNT(*) c FROM users_new').get().c;
      if (before !== after) throw new Error(`Row count changed during copy: ${before} -> ${after}`);

      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');

      for (const [table, expected] of Object.entries(childCounts)) {
        const actual = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
        if (actual !== expected) {
          throw new Error(
            `${table} lost rows during the users rebuild: ${expected} -> ${actual}. `
            + 'Foreign keys were enforced during DROP TABLE users and cascade-deleted them.'
          );
        }
      }

      // DROP TABLE took the indexes with it. Recreate all three, matching db.js.
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE) WHERE username IS NOT NULL');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)');

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error(`${violations.length} foreign key violations after users rebuild`);
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
  }
}

export default { version: 1, name: 'authz_roles', ownTransaction: true, up };
