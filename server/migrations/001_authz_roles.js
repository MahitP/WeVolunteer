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

      const before = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      db.exec(`INSERT INTO users_new (${cols}) SELECT ${cols} FROM users`);
      const after = db.prepare('SELECT COUNT(*) c FROM users_new').get().c;
      if (before !== after) throw new Error(`Row count changed during copy: ${before} -> ${after}`);

      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');

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
