/**
 * Repairs a `tfa_login_attempts` whose key column is not the one the code writes.
 *
 * ── The failure this fixes ──
 *
 * Every second-factor submission on the pilot database answered:
 *
 *   HTTP 500  {"error":"Internal server error during 2FA login"}
 *
 * for a CORRECT code and a wrong one alike, on email and recovery both. The
 * server log carried the real cause:
 *
 *   Error: table tfa_login_attempts has no column named token_hash
 *
 * `/api/auth/login-2fa` claims an attempt before it checks anything — the
 * INSERT … ON CONFLICT(token_hash) beside `TOKEN_ATTEMPT_CEILING` — so the throw
 * lands above every verification branch and takes all of them down together.
 * Two-factor sign-in was not degraded on that database; it was impossible.
 *
 * ── Why it survived a full test suite ──
 *
 * Migration 025 creates the table with `token_hash`, and it has said `token_hash`
 * since the commit that introduced it — this is not an edited migration. But it
 * creates it with `CREATE TABLE IF NOT EXISTS`, and on the pilot database a table
 * of that name was already present with `preauth_jti` as its primary key. A name
 * that appears nowhere in this repository's history, at any commit, so it was
 * created outside the migration system entirely.
 *
 * `IF NOT EXISTS` does not compare shapes. It saw the name, did nothing, and
 * recorded 025 as applied. Every database built from scratch — which is every
 * database any test has ever run against — got the correct column and passed,
 * while the only database anyone actually signs in to could not complete a
 * sign-in. That asymmetry is why this went unfound for so long: there was no
 * failing test to find, because the fault is not in the code.
 *
 * ── Why the rows are dropped rather than carried across ──
 *
 * The two columns do not hold the same value. `preauth_jti` held a grant's `jti`;
 * `token_hash` holds `sha256(preauthToken)`. Copying one into the other would
 * file each old row under a key no future request can compute, so the counters
 * would be neither honoured nor cleared — they would simply sit in the table
 * inflating the per-ACCOUNT sum, whose window is keyed on `user_id`, and charge
 * live users for guesses recorded against a different scheme.
 *
 * Discarding them is safe in the direction that matters. The table is a rolling
 * rate-limit counter, swept hourly by `utils.js`, and holds nothing anybody can
 * be denied service for losing: the worst case is that an attack in progress at
 * the moment of the upgrade gets its budget reset once — against a database where
 * the same attacker could not have completed a sign-in either way, since every
 * attempt was throwing.
 *
 * ── Why the whole table is rebuilt ──
 *
 * SQLite cannot rename a PRIMARY KEY column into existence, and `ALTER TABLE …
 * RENAME COLUMN preauth_jti TO token_hash` would preserve exactly the rows the
 * paragraph above explains must not be preserved. Dropping and recreating gives
 * one shape with one definition, identical to what 025 produces on a fresh
 * database — so after this runs there is no longer a "pilot schema" and a "test
 * schema" to keep in step.
 */
const CANONICAL = `
  CREATE TABLE tfa_login_attempts (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`;

export function up(db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = 'tfa_login_attempts'"
  ).get();

  /* A database that has not reached 025 yet will get the correct shape from it.
     Creating the table here as well would only add a second definition to keep
     in step with the first. */
  if (!exists) return;

  const columns = db.prepare('PRAGMA table_info(tfa_login_attempts)').all().map(c => c.name);

  /* Already correct — every fresh database, and every database this has already
     repaired. Idempotent by inspection rather than by relying on the version
     record, so it stays safe if it is ever re-run by hand. */
  if (columns.includes('token_hash')) return;

  db.exec('DROP TABLE tfa_login_attempts');
  db.exec(CANONICAL);

  console.warn(
    '[2fa] Rebuilt tfa_login_attempts: its key column was '
    + `"${columns[0] ?? 'unknown'}" where the sign-in path writes "token_hash", so every `
    + 'second-factor submission on this database was answering HTTP 500. '
    + 'Rate-limit counters were discarded; they are rebuilt on the next attempt.'
  );
}

export default {
  version: 55,
  name: 'repair_tfa_login_attempts',
  up,
  fileUrl: import.meta.url,
};
