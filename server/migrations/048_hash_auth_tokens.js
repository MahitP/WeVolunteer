import { hashToken } from '../tokenDigest.js';

/**
 * Verification, password-reset and email-change tokens stop being stored in
 * plaintext.
 *
 * ── What was wrong ──
 *
 * Three tables — `email_verification_tokens`, `password_reset_tokens` and
 * `email_change_tokens` — each held its token verbatim as the primary key.
 *
 * Every one of those strings is a bearer credential. A password-reset token IS
 * the account until it expires or is spent: whoever has it can set a new
 * password without knowing the old one, and on this platform that account may
 * belong to a fourteen-year-old. So anybody who could read the database could
 * take over any account with an outstanding reset — no password needed, no
 * failed-login trail, nothing in the audit log that looks unusual.
 *
 * "Who can read the database" is a longer list than it sounds: a backup copied
 * to the wrong place, a support question with a query result pasted into it,
 * the developer laptop the file lives on, or any future read-only SQL flaw
 * anywhere else in the application. None of those needs to be a full compromise
 * to hand over accounts.
 *
 * The rest of the codebase already knew better. `admin_invitations` (migration
 * 023) stores `token_hash`, and `checkin_tokens` (migration 037) stores
 * `token_hash`, both with a written rationale. These three predate that habit
 * and never caught up.
 *
 * ── Why the column is RENAMED and not just repurposed ──
 *
 * Storing a digest in a column still called `token` would work and would be a
 * trap. The next person to add a code path here writes `INSERT ... (token) ...`
 * with the plaintext, it succeeds, and the hole is quietly reopened with no
 * error and no test failure — the exact shape of the bug being fixed.
 *
 * After this migration there is no `token` column. A plaintext write fails
 * immediately with "no such column", which is the difference between a mistake
 * that is caught in development and one that ships.
 *
 * ── Why outstanding links keep working ──
 *
 * The existing rows are carried over as `hashToken(old_plaintext)`, so a
 * verification link mailed ten minutes before the deploy still verifies
 * afterwards. Dropping the rows instead would have been simpler and would have
 * silently broken every link in flight — for verification that means an account
 * nobody can get into, which is precisely the failure this platform's email
 * work has been trying to eliminate.
 *
 * ── Why a rebuild ──
 *
 * `token` is the PRIMARY KEY of each table, and SQLite cannot rename or retype
 * a primary key in place. The tables are small and short-lived by nature, so
 * the rebuild is cheap. The copy names its columns rather than using `SELECT *`
 * so a column added later cannot shift the mapping.
 */

const TABLES = [
  {
    name: 'email_verification_tokens',
    columns: ['user_id', 'expires_at'],
    ddl: `
      CREATE TABLE email_verification_tokens_new (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `,
  },
  {
    name: 'password_reset_tokens',
    columns: ['user_id', 'expires_at'],
    ddl: `
      CREATE TABLE password_reset_tokens_new (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `,
  },
  {
    name: 'email_change_tokens',
    columns: ['user_id', 'new_email', 'expires_at'],
    ddl: `
      CREATE TABLE email_change_tokens_new (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        new_email  TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `,
  },
];

export function up(db) {
  for (const table of TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
    if (columns.length === 0) continue; // Table arrives with db.js's bootstrap.

    const have = new Set(columns.map((c) => c.name));
    if (have.has('token_hash')) continue; // Already migrated; re-running is a no-op.

    db.exec(table.ddl);

    /* Hashed in JS rather than in SQL, because SQLite has no built-in SHA-256
       and `hashToken` is the one definition the application reads with. A second
       implementation here could disagree with it, and the symptom would be every
       outstanding link failing with no explanation. */
    const rest = table.columns.join(', ');
    const placeholders = table.columns.map(() => '?').join(', ');
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${table.name}_new (token_hash, ${rest}) VALUES (?, ${placeholders})`
    );

    for (const row of db.prepare(`SELECT token, ${rest} FROM ${table.name}`).all()) {
      insert.run(hashToken(row.token), ...table.columns.map((c) => row[c]));
    }

    db.exec(`DROP TABLE ${table.name}`);
    db.exec(`ALTER TABLE ${table.name}_new RENAME TO ${table.name}`);
  }
}

export default {
  version: 48,
  name: 'hash_auth_tokens',
  up,
  fileUrl: import.meta.url,
};
