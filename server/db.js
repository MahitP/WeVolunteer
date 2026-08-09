import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { createHoursLedgerTable, backfillHoursLedger, verifyLedgerParity } from './hoursLedger.js';
import { createCertificatesTable, backfillCertificates } from './certificates.js';
import { createCheckinTable } from './attendance.js';
import { createInstanceLockTable } from './instanceLock.js';
import { DEMO_MODE, REQUIRE_EMAIL_VERIFICATION } from './config.js';
import { runMigrations } from './migrations/index.js';
/* Safe to import here: seed_badges.js keeps its own `db.js` import inside its
   CLI guard precisely so requiring the catalogue cannot open a connection, so
   there is no cycle at module scope. */
import { reconcileBadgeCatalogue } from './scripts/seed_badges.js';
import { syncLegalDocuments } from './consent.js';
// Same reasoning as auditLog.js below: organizerAgreement.js takes `db` as an
// argument and reaches only consent.js and legalDocuments.js, neither of which
// imports this file, so there is no cycle.
import { acceptOrganizerAgreement } from './organizerAgreement.js';
// Safe to import here despite this module opening the database at module scope:
// auditLog.js imports `node:crypto` and nothing else, and takes `db` as an
// argument, so there is no cycle back into this file.
import { recordAudit } from './auditLog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// WEV_DB_PATH lets tests point at a throwaway file. Unset in normal operation.
const dbPath = process.env.WEV_DB_PATH || path.join(__dirname, 'wevolunteer.db');

const db = new DatabaseSync(dbPath);

// Connection durability/concurrency settings, applied before any statement runs.
//
// WAL lets readers continue while a write is in progress, instead of the
// default rollback journal where a writer locks the whole file. busy_timeout
// gives a blocked writer a retry window rather than failing instantly with
// SQLITE_BUSY — the default is 0. The app is single-process, but the boot
// backfills, the 15-minute notification sweep, and the standalone scripts
// (verify:hours, bin/make-admin.mjs) can all open this file, so a zero-length
// window is an avoidable failure mode.
//
// WAL is written into the database header and persists; it also creates -wal
// and -shm sidecar files, which any backup must copy alongside the .db (see
// the runbook in README.md).
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * Adds a column only if it isn't already present. `ALTER TABLE ... ADD COLUMN`
 * throws on a duplicate, so existing databases would fail to boot otherwise.
 */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(c => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Migration: added ${table}.${column}`);
  return true;
}

/**
 * Reconciles pre-existing case-variant email duplicates (F-11) before the
 * case-insensitive unique index is created.
 *
 * A fresh seeded database has zero case-insensitive collisions, so this is a
 * no-op there — it only does work defensively, against a production database
 * that already has duplicates from the case-sensitive era.
 *
 * For each colliding group, the account with the most CREDITED hours
 * (attendance.present = 1) survives unchanged; ties broken by oldest
 * created_at, then lowest rowid. Every other account in the group is
 * RENAMED (never merged, never deleted) to a reserved `local+dup-<rowid>@domain`
 * form and has its token_version bumped so its existing sessions drop. No
 * user_id ever changes, no application/attendance row is ever moved, and no
 * user is ever deleted — merging risks colliding with attendance's
 * PRIMARY KEY(slot_id, user_id) / applications' UNIQUE(user_id, slot_id), and
 * deleting would cascade away the account's credited hours. The renamed
 * account's records stay intact-but-parked for an admin to reconcile by hand.
 */
function dedupeCaseInsensitiveEmails(db) {
  const groups = db.prepare(
    'SELECT LOWER(email) AS key FROM users GROUP BY key HAVING COUNT(*) > 1'
  ).all();
  if (groups.length === 0) return;

  db.exec('BEGIN TRANSACTION');
  try {
    const hoursForUser = db.prepare(
      'SELECT COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ? AND present = 1'
    );
    const renameStmt = db.prepare(
      'UPDATE users SET email = ?, token_version = token_version + 1 WHERE rowid = ?'
    );

    for (const { key } of groups) {
      const members = db.prepare(
        'SELECT rowid, id, email, created_at FROM users WHERE LOWER(email) = ?'
      ).all(key);

      const withHours = members.map(m => ({
        ...m,
        hours: hoursForUser.get(m.id).hours
      }));

      // Survivor: most credited hours, then oldest created_at, then lowest rowid.
      withHours.sort((a, b) => {
        if (b.hours !== a.hours) return b.hours - a.hours;
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.rowid - b.rowid;
      });
      const survivor = withHours[0];

      for (const member of withHours) {
        if (member.rowid === survivor.rowid) continue;

        const at = member.email.lastIndexOf('@');
        const newEmail = at === -1
          ? `${member.email}+dup-${member.rowid}`
          : `${member.email.slice(0, at)}+dup-${member.rowid}${member.email.slice(at)}`;

        renameStmt.run(newEmail, member.rowid);
        console.log(`[Email dedupe] ${member.email} -> ${newEmail} (id ${member.id})`);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Reconciles pre-existing case-variant USERNAME duplicates before the
 * case-insensitive unique index is created.
 *
 * The same asymmetry email had, found by the v1.1 audit and left behind when
 * the email half was fixed: `username TEXT UNIQUE` and `idx_users_username`
 * are both case-SENSITIVE, while every application-level check runs
 * `COLLATE NOCASE`. Two concurrent signups for `Alice` and `alice` therefore
 * both pass their SELECT and both INSERT — and login's
 * `WHERE ... OR username = ? COLLATE NOCASE` uses `.get()`, so it returns one
 * arbitrary row of the two and the other person can never sign in with their
 * username again.
 *
 * Resolution differs from the email case on purpose. An email is a route to a
 * human being, so a duplicate there is parked for an admin. A username is a
 * label, so the oldest account keeps it and the newer ones are given a numeric
 * suffix — nobody loses access, and each renamed account is told what happened
 * and why. No user_id changes, nothing is merged, nothing is deleted, and
 * token_version is untouched because a username does not authenticate anything.
 *
 * A fresh seeded database has no collisions, so this is a no-op there.
 */
function dedupeCaseInsensitiveUsernames(db) {
  const groups = db.prepare(`
    SELECT LOWER(username) AS key FROM users
    WHERE username IS NOT NULL AND username != ''
    GROUP BY key HAVING COUNT(*) > 1
  `).all();
  if (groups.length === 0) return;

  db.exec('BEGIN TRANSACTION');
  try {
    const isTaken = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE');
    const renameStmt = db.prepare('UPDATE users SET username = ? WHERE rowid = ?');
    const notifyStmt = db.prepare(`
      INSERT INTO notifications (id, user_id, kind, title, body, link, read, created_at)
      VALUES (?, ?, 'info', ?, ?, NULL, 0, ?)
    `);
    const now = new Date().toISOString();

    for (const { key } of groups) {
      const members = db.prepare(`
        SELECT rowid, id, username, created_at FROM users
        WHERE LOWER(username) = ?
        ORDER BY created_at ASC, rowid ASC
      `).all(key);

      // Oldest account keeps the username it has been using.
      for (const member of members.slice(1)) {
        // USERNAME_MAX is 20, so the base has to give up room for the suffix
        // rather than produce a name the validator would now reject.
        let renamed = null;
        for (let n = 2; n < 1000; n++) {
          const suffix = String(n);
          const base = member.username.slice(0, Math.max(1, 20 - suffix.length));
          const candidate = `${base}${suffix}`;
          if (!isTaken.get(candidate)) { renamed = candidate; break; }
        }
        // Exhausting 998 candidates means something pathological; fall back to
        // the row id, which is unique by construction, rather than give up and
        // leave the index uncreatable.
        if (!renamed) renamed = `user${member.rowid}`.slice(0, 20);

        renameStmt.run(renamed, member.rowid);
        notifyStmt.run(
          `notif-dedupe-${member.id}`,
          member.id,
          'Your username changed',
          `Another account was already using "${member.username}" with different capitalisation, `
            + `which stopped one of you from signing in with it. Your username is now "${renamed}" — `
            + `you can change it in Settings. Your email address and password are unchanged.`,
          now
        );
        // admin_id is NOT NULL with a foreign key to users, and no administrator
        // performed this — the migration did. Attribute it to the affected
        // account, which is what the self-deletion audit row already does for
        // the same reason, so the row is traceable without inventing a user.
        recordAudit(db, {
          adminId: member.id,
          action: 'USERNAME_DEDUPED',
          targetUserId: member.id,
          details: `Case-insensitive username collision on "${key}": renamed "${member.username}" to "${renamed}"`
        });
        console.log(`[Username dedupe] ${member.username} -> ${renamed} (id ${member.id})`);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Columns `rebuildApplicationsForWithdrawn` knows how to copy.
 *
 * Order here is irrelevant — the copy names every column explicitly on both
 * sides — but membership is not: a column on the real table and absent from
 * this list would be dropped by the rebuild.
 */
const EXPECTED_APPLICATION_COLUMNS = [
  'id', 'user_id', 'event_id', 'slot_id', 'status', 'applied_at', 'waitlist_order',
];

/**
 * Rebuilds `applications` so its status CHECK admits 'withdrawn'.
 *
 * SQLite cannot alter a CHECK constraint, so the table is copied. This used to
 * copy with `INSERT INTO applications_new SELECT * FROM applications`, which is
 * positional: it depends on the two tables' column ORDER matching exactly.
 *
 * That is not a theoretical hazard on this codebase. Migration
 * 001_authz_roles.js documents the same pattern failing for real on `users` —
 * column order there depends on the order historical addColumnIfMissing() calls
 * happened to run, and on the pilot database `email_verified` sits before
 * `account_status`/`deleted_at` while a freshly seeded database has it after.
 * `applications` acquires `waitlist_order` the same way (addColumnIfMissing, in
 * initDatabase above), so it has the same exposure: a SELECT * copy would
 * silently write each value into whatever column happened to share its
 * position. Nothing would throw; the data would simply be wrong.
 *
 * So: an explicit column list on both sides, and — following 001 — a
 * PRAGMA table_info guard that refuses to run at all if the real table has a
 * column this function does not know about (the copy would DROP it) or is
 * missing one it expects (the copy would fail, or worse, succeed against a
 * half-built table). Failing loudly beats losing a column quietly.
 *
 * Known, deliberately-unaddressed hazard: `application_conflicts` holds
 * `FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE`,
 * and node:sqlite enables foreign keys by default, so `DROP TABLE applications`
 * below can cascade-delete that table's rows. 001 solves the equivalent problem
 * with `PRAGMA foreign_keys = OFF`, which only works OUTSIDE a transaction and
 * would therefore mean restructuring this block's transaction handling. Instead
 * the child row count is snapshotted and compared after the rename, so a
 * cascade throws and the ROLLBACK below undoes it — detectable and recoverable
 * rather than silent. Reworking the pragma handling belongs with moving this
 * whole block into the migration registry, which is tracked separately.
 */
export function rebuildApplicationsForWithdrawn(db) {
  const actual = db.prepare('PRAGMA table_info(applications)').all().map(c => c.name);
  const unknown = actual.filter(c => !EXPECTED_APPLICATION_COLUMNS.includes(c));
  const missing = EXPECTED_APPLICATION_COLUMNS.filter(c => !actual.includes(c));
  if (unknown.length) {
    throw new Error(
      `applications has unexpected columns [${unknown.join(', ')}]. Add them to `
      + 'EXPECTED_APPLICATION_COLUMNS and to the CREATE TABLE in '
      + 'rebuildApplicationsForWithdrawn(), then re-run. Copying without them '
      + 'would delete that data.'
    );
  }
  if (missing.length) {
    throw new Error(
      `applications is missing expected columns [${missing.join(', ')}]. `
      + 'The addColumnIfMissing() pass must run before this rebuild.'
    );
  }

  const cols = EXPECTED_APPLICATION_COLUMNS.join(', ');
  const conflictsExist = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='application_conflicts'"
  ).get();
  const conflictsBefore = conflictsExist
    ? db.prepare('SELECT COUNT(*) c FROM application_conflicts').get().c
    : null;

  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      CREATE TABLE applications_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        status TEXT CHECK(status IN ('pending', 'accepted', 'waitlisted', 'rejected', 'withdrawn')) DEFAULT 'pending',
        applied_at TEXT NOT NULL,
        waitlist_order INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
        FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE,
        UNIQUE(user_id, slot_id)
      )
    `);

    const before = db.prepare('SELECT COUNT(*) c FROM applications').get().c;
    db.exec(`INSERT INTO applications_new (${cols}) SELECT ${cols} FROM applications`);
    const after = db.prepare('SELECT COUNT(*) c FROM applications_new').get().c;
    if (before !== after) throw new Error(`Row count changed during copy: ${before} -> ${after}`);

    db.exec('DROP TABLE applications');
    db.exec('ALTER TABLE applications_new RENAME TO applications');

    if (conflictsBefore !== null) {
      const conflictsAfter = db.prepare('SELECT COUNT(*) c FROM application_conflicts').get().c;
      if (conflictsAfter !== conflictsBefore) {
        throw new Error(
          `application_conflicts lost rows during the applications rebuild: `
          + `${conflictsBefore} -> ${conflictsAfter}. Foreign keys were enforced during `
          + 'DROP TABLE applications and cascade-deleted them.'
        );
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function initDatabase() {
  // Safe for restarts — only creates tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      grade TEXT CHECK(grade IN ('9', '10', '11', '12', 'Adult', 'N/A')) NOT NULL,
      role TEXT CHECK(role IN ('student', 'organizer', 'admin')) NOT NULL,
      verified INTEGER DEFAULT 1,
      avatar TEXT,
      bio TEXT,
      school TEXT,
      skills TEXT,
      leaderboard_opt_in INTEGER DEFAULT 0,
      username TEXT UNIQUE,
      profile_visibility TEXT CHECK(profile_visibility IN ('private', 'friends', 'public')) DEFAULT 'private',
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT CHECK(category IN ('School', '5K', 'Food Pantry', 'Fundraiser', 'Other')) NOT NULL,
      location TEXT NOT NULL,
      application_deadline TEXT NOT NULL,
      organizer_id TEXT NOT NULL,
      status TEXT CHECK(status IN ('open', 'closed', 'completed', 'cancelled')) DEFAULT 'open',
      auto_approve INTEGER DEFAULT 0,
      selection_summary TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(organizer_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      start_datetime TEXT NOT NULL,
      end_datetime TEXT NOT NULL,
      max_spots INTEGER NOT NULL,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      status TEXT CHECK(status IN ('pending', 'accepted', 'waitlisted', 'rejected', 'withdrawn')) DEFAULT 'pending',
      applied_at TEXT NOT NULL,
      waitlist_order INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE,
      UNIQUE(user_id, slot_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance (
      event_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      present INTEGER CHECK(present IN (0, 1)) NOT NULL,
      hours_awarded REAL NOT NULL,
      PRIMARY KEY(slot_id, user_id),
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  /**
   * Organizer-created event tags. See server/eventTags.js for the model.
   *
   * `tag` is the normalised key (lower-cased, `#` stripped, whitespace collapsed)
   * and `label` is what the organizer typed. The composite primary key is what
   * makes a duplicate tag on one event impossible in the DATA rather than only in
   * the validator — `#NHS` and `#nhs` normalise to the same key and the second
   * insert is refused by the engine.
   *
   * `ON DELETE CASCADE` so deleting an event takes its tags with it. Without it
   * the table would accumulate rows pointing at nothing, and `tagVocabulary`
   * would keep suggesting tags whose only event was removed.
   *
   * The index on `tag` is the one that matters: tag filtering is an
   * `EXISTS (SELECT 1 FROM event_tags WHERE event_id = e.id AND tag IN (…))`
   * inside the browse query's WHERE clause, which without it is a table scan per
   * candidate event on the endpoint the browse screen calls on every keystroke.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_tags (
      event_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY (event_id, tag),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_event_tags_tag ON event_tags(tag)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      provider_email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(provider, provider_user_id)
    )
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_user_provider ON oauth_accounts (user_id, provider)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_signup_sessions (
      id TEXT PRIMARY KEY,
      signup_data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      nonce TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  // ── V2: New tables for enhanced features ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      priority TEXT DEFAULT 'NORMAL',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, category, channel),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_jobs (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      error_log TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      organizer_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_message_id TEXT,
      last_message_at TEXT,
      lifecycle_state TEXT CHECK(lifecycle_state IN ('active', 'read_only')) DEFAULT 'active',
      read_only_reason TEXT,
      read_only_at TEXT,
      archived_by_system_at TEXT,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(organizer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(student_id, organizer_id, event_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS application_conflicts (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      conflicting_application_id TEXT NOT NULL,
      conflict_type TEXT CHECK(conflict_type IN ('pending', 'accepted', 'waitlisted')) NOT NULL,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE,
      FOREIGN KEY(conflicting_application_id) REFERENCES applications(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_at_creation TEXT NOT NULL,
      last_read_message_id TEXT,
      last_read_at TEXT,
      archived_at TEXT,
      muted_until TEXT,
      joined_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id, user_id),
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('inappropriate', 'spam', 'safety', 'other')),
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'reviewing', 'resolved', 'dismissed')),
      snapshot_created_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_report_messages (
      report_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(report_id, message_id),
      FOREIGN KEY(report_id) REFERENCES conversation_reports(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_comments (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, event_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('event', 'comment')),
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS data_export_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
      file_location TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Announcements: one-way updates from the organizer to everyone signed up —
  // location changes, what to bring, weather calls. Deliberately not a
  // messaging system: no replies, no direct messages between users.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_announcements (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_select_runs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      selected_ids TEXT NOT NULL,
      waitlist_ids TEXT NOT NULL,
      is_confirmed INTEGER DEFAULT 0,
      reason TEXT,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  /**
   * Sessions revoked before their token expired.
   *
   * Sessions are stateless JWTs, so signing out could not previously invalidate
   * anything: `POST /api/auth/logout` cleared the cookie and the token stayed
   * valid for the rest of its seven days. The only revocation available was
   * `users.token_version`, which is all-or-nothing per account — bumping it on
   * logout is exactly the "signing out here signed me out on my phone" bug that
   * was fixed deliberately, so it cannot be reused for this.
   *
   * This is the per-session half: each token carries a `jti`, logout records that
   * one id, and authenticateToken refuses it. Small on purpose — one row per
   * explicit sign-out, deleted once the token would have expired anyway
   * (purgeExpiredRevocations, called from the notification sweep).
   *
   * No foreign key to users: a revocation must outlive the account being deleted,
   * or deleting an account would silently un-revoke its outstanding sessions.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS revoked_sessions (
      jti TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      revoked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
  // Supports the purge, which is the only query that is not a primary-key lookup.
  db.exec('CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expiry ON revoked_sessions(expires_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  /**
   * Pending email-address changes.
   *
   * The new address lives here, not on the users row, until the person proves
   * they can read it. Writing it straight to `users.email` would let a typo — or
   * someone else's address — take over the account's only recovery channel
   * before anyone had confirmed it was reachable.
   *
   * One live request per user, enforced by the caller deleting first.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_change_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      new_email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Columns added after the first release. CREATE TABLE IF NOT EXISTS won't
  // add them to an existing database, so they're applied explicitly.
  // Lets a repeating sweep (deadline reminders, shift reminders) know it has
  // already told this user about this thing, so notifications never duplicate.
  addColumnIfMissing('notifications', 'dedupe_key', 'TEXT');
  addColumnIfMissing('notifications', 'priority', "TEXT DEFAULT 'NORMAL'");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL');

  addColumnIfMissing('events', 'instructions', 'TEXT');
  addColumnIfMissing('events', 'attendee_visibility', "TEXT NOT NULL DEFAULT 'accepted'");
  addColumnIfMissing('applications', 'waitlist_order', 'INTEGER');
  addColumnIfMissing('events', 'selection_summary', 'TEXT');
  addColumnIfMissing('auto_select_runs', 'reason', 'TEXT');
  addColumnIfMissing('users', 'leaderboard_opt_in', 'INTEGER DEFAULT 0');
  addColumnIfMissing('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'email_opt_out', 'INTEGER DEFAULT 0');
  addColumnIfMissing('users', 'account_status', "TEXT CHECK(account_status IN ('active', 'deleted', 'suspended')) DEFAULT 'active'");
  addColumnIfMissing('users', 'deleted_at', 'TEXT');

  /**
   * Suspension detail lives in migration 006, NOT here.
   *
   * The obvious placement is an `addColumnIfMissing` on the line above, next to
   * `account_status`, and it does not work: `runMigrations` runs LAST in
   * `initDatabase()`, so any column added here exists before migration 001
   * rebuilds the `users` table — and 001's unknown-column guard (ENGINEERING_GUIDE
   * §8.3) correctly refuses to copy a table carrying columns its explicit column
   * list does not name. On a fresh database that is a hard boot failure.
   *
   * Adding them to 001 instead would change its source checksum, which the
   * registry re-verifies on every boot, breaking every database that has already
   * run it. So they go in a migration ordered after the rebuild. See
   * server/migrations/006_account_suspension.js.
   */


  // Location Picker: structured geo data alongside the existing text `location`.
  addColumnIfMissing('events', 'address', 'TEXT');
  addColumnIfMissing('events', 'latitude', 'REAL');
  addColumnIfMissing('events', 'longitude', 'REAL');

  const addedEmailVerified = addColumnIfMissing('users', 'email_verified', 'INTEGER DEFAULT 0');
  if (addedEmailVerified) {
    // The first time this column exists, every current account predates email
    // verification — none of their 0s is a real pending confirmation. Backfill
    // them verified regardless of REQUIRE_EMAIL_VERIFICATION, or enabling
    // verification on an existing database would lock out every current user.
    // This runs before seeding, so on a fresh database it touches no rows.
    db.exec('UPDATE users SET email_verified = 1');
  }

  // Migrate applications table to allow 'withdrawn' status
  // SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we check if the schema has 'withdrawn'
  const appSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='applications'").get();
  if (appSchema && !appSchema.sql.includes("'withdrawn'")) {
    console.log("Migrating 'applications' table to support 'withdrawn' status...");
    rebuildApplicationsForWithdrawn(db);
  }

  // Pre-pilot social/profile prep
  addColumnIfMissing('users', 'username', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL');

  // When the account last changed its username, for the change cooldown. NULL
  // means "never changed" and so is never in cooldown.
  addColumnIfMissing('users', 'username_changed_at', 'TEXT');

  /**
   * The case-insensitive backstop for username uniqueness.
   *
   * `idx_users_username` above is case-SENSITIVE, so it let `Alice` and `alice`
   * coexist while every application check said they collide — which locked one
   * of the two people out of username sign-in permanently. This index is what
   * makes the application-level check enforceable rather than advisory.
   *
   * The case-sensitive index is kept: this one is strictly stricter, so it is
   * redundant rather than wrong, and dropping an index on live pilot data buys
   * nothing. Collisions are reconciled first, or CREATE UNIQUE INDEX fails.
   */
  dedupeCaseInsensitiveUsernames(db);
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase '
    + 'ON users(username COLLATE NOCASE) WHERE username IS NOT NULL'
  );
  addColumnIfMissing('users', 'profile_visibility', "TEXT CHECK(profile_visibility IN ('private', 'friends', 'public')) DEFAULT 'private'");

  // F-11: email uniqueness was case-sensitive while forgot-password already
  // matched COLLATE NOCASE, so one person could hold leo@x and Leo@x with
  // service hours split across them. Reconcile any pre-existing case-variant
  // duplicates BEFORE the unique index is created below — CREATE UNIQUE INDEX
  // would otherwise fail (or silently forbid) on a database that already has
  // colliding rows.
  dedupeCaseInsensitiveEmails(db);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)');

  // Indexes for performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_participants_user ON conversation_participants(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_event ON conversations(event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_event ON event_comments(event_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_announcements_event ON event_announcements(event_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_applications_event ON applications(event_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id, present)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_export_jobs_user ON data_export_jobs(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_export_jobs_status ON data_export_jobs(status)`);

  // Added after a query-plan audit found these filters running full table scans.
  // Each one is on a path the app hits constantly, so at district scale they
  // would degrade together rather than one at a time.
  //   slots(event_id)              — every event render, edit, and completion check
  //   applications(slot_id, status)— per-slot capacity counting, in loops
  //   events(organizer_id)         — every organizer dashboard and stats call
  //   attendance(event_id)         — deletion guard and per-event hours rollups
  // applications(user_id) is already covered by the UNIQUE(user_id, slot_id)
  // index as a leftmost prefix, so it is deliberately not repeated here.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_slots_event ON slots(event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_applications_slot ON applications(slot_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_event ON attendance(event_id)`);

  // Seed data is a demo affordance, never a production one: the seed accounts
  // share a password that is printed in the README. A real deployment comes up
  // empty, and its first admin is made with `node bin/make-admin.mjs <email>`
  // after that person has signed up normally.
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count > 0) {
    console.log('Database already initialized.');

    /**
     * DEMO_MODE over a database that already has accounts.
     *
     * The warning below this branch is louder and better known, and it only ever
     * fires while SEEDING — that is, on an empty database. The dangerous case is
     * the opposite one and it was silent: a real database, populated weeks ago,
     * served by somebody running `npm run dev` because that is the command they
     * remember. It printed "Database already initialized." and nothing else.
     *
     * DEMO_MODE is not cosmetic. It exempts the seeded administrator from the
     * two-factor policy (see `isDemoExemptAccount` in utils.js), and if that
     * account is present it holds administrative capabilities behind a password
     * published in the README. Whether that matters depends entirely on whose
     * data is in the file, which is a question only the operator can answer — so
     * this states the facts and names the account rather than guessing.
     *
     * Not a refusal. Demo mode over a seeded database is the normal development
     * loop, and failing it would break the everyday case in order to warn about
     * the rare one. `server.js` already refuses the combination that is never
     * legitimate: DEMO_MODE with NODE_ENV=production.
     */
    if (DEMO_MODE) {
      const exempt = db.prepare(
        "SELECT email FROM users WHERE email = 'admin@example.gov'"
      ).get();
      /* Padded rather than hand-aligned: one line carries a variable-width count,
         and a box whose border wanders reads as a broken message rather than an
         urgent one. */
      const WIDTH = 60;
      const box = (text = '') => console.warn(`  *  ${text.padEnd(WIDTH)} *`);
      const rule = () => console.warn(`  ${'*'.repeat(WIDTH + 6)}`);

      console.warn('');
      rule();
      box('DEMO_MODE is ON over a database that already has');
      box(`accounts — ${userCount.count} present. Demo relaxations apply to them.`);
      if (exempt) {
        box();
        box('admin@example.gov is present and is EXEMPT from the');
        box('2FA policy while DEMO_MODE is set, and its password is');
        box('published in the README. Remove that account, or start');
        box('without DEMO_MODE (`npm start --prefix server`).');
      }
      rule();
      console.warn('');
    }
  } else if (DEMO_MODE) {
    // Loud on purpose. The realistic way this fires unexpectedly is an operator
    // running `npm run dev` on a server instead of `npm start` — DEMO_MODE is
    // only refused when NODE_ENV=production, so on a host that has not set it
    // this silently inserts accounts whose shared password is published in the
    // README, and they persist after the service is later started correctly.
    console.warn('');
    console.warn('  ****************************************************************');
    console.warn('  *  DEMO_MODE: seeding demo accounts into an empty database.     *');
    console.warn('  *  These accounts share a PUBLISHED password and include an     *');
    console.warn('  *  administrator. This must never happen on a real deployment.  *');
    console.warn('  *  If you did not intend this, stop the server, delete the      *');
    console.warn('  *  database file, and start it with `npm start --prefix server` *');
    console.warn('  *  and NODE_ENV=production.                                     *');
    console.warn('  ****************************************************************');
    console.warn('');
    seedDatabase();
    console.log('Seeding complete.');
  } else {
    console.log('Empty database initialized. DEMO_MODE is off, so no demo accounts were created.');
  }

  if (DEMO_MODE) {
    /**
     * Seeded fixtures are always confirmed.
     *
     * The seed addresses are invented (leo.chen28@gmail.com and friends) and
     * no confirmation mail can ever reach them, so leaving them unconfirmed
     * puts every demo account behind a wall with nothing behind it — the demo
     * sign-in buttons land on "check your email" forever, and the whole test
     * suite 403s. This is scoped to DEMO_MODE, so it can never quietly confirm
     * a real person's address in a live deployment.
     */
    db.exec('UPDATE users SET email_verified = 1 WHERE email_verified = 0');
  } else if (!REQUIRE_EMAIL_VERIFICATION) {
    // Verification switched off deliberately: a stale 0 would put an otherwise
    // fine account behind a wall it cannot get past. Idempotent, and it stops
    // applying the moment verification is switched back on.
    db.exec('UPDATE users SET email_verified = 1 WHERE email_verified = 0');
  }

  // Check-in marks taken during an event. Separate from `attendance` so that
  // marking someone off on the day never credits hours by itself.
  createCheckinTable(db);

  // Single-instance lock. Created here so it is part of the schema like every
  // other table, rather than appearing the first time something takes the lock.
  createInstanceLockTable(db);

  initHoursLedger();
  initCertificates();

  addColumnIfMissing('certificates', 'volunteer_name_snapshot', 'TEXT');
  addColumnIfMissing('certificates', 'event_name_snapshot', 'TEXT');
  addColumnIfMissing('certificates', 'organization_snapshot', 'TEXT');
  addColumnIfMissing('certificates', 'hours_snapshot', 'REAL');
  addColumnIfMissing('certificates', 'completed_at_snapshot', 'TEXT');

  /**
   * The PKCE code verifier for an in-flight OAuth authorization.
   *
   * ── Why it lives HERE and not in the signed `state` ──
   *
   * PKCE's whole premise is that whoever holds the authorization code cannot
   * redeem it without a secret they never saw. The `state` parameter travels
   * through the browser and back, so a verifier carried in it would be visible to
   * exactly the party PKCE exists to defend against, and the protection would be
   * decorative. It is stored server-side against the same single-use nonce row
   * the replay check already reads, and it never leaves this process.
   *
   * ── Why PKCE at all, for a confidential client ──
   *
   * `OAUTH_REDIRECT_URI` points at the SPA (`/oauth/callback`), not at the API —
   * so the authorization code is delivered to the BROWSER and posted to the
   * server afterwards. That is the deployment where an intercepted code (a
   * malicious extension, a referrer leak, a shared machine's history) is
   * redeemable by whoever picks it up, because the client secret alone is not
   * bound to the request that started the flow. PKCE binds them.
   *
   * Nullable, and the callback treats a missing value as "this flow began before
   * PKCE existed" rather than as a failure — an authorization already in flight
   * across the deploy must not break. Rows are short-lived (15 minutes) and
   * purged, so the tolerance closes by itself.
   */
  addColumnIfMissing('oauth_states', 'code_verifier', 'TEXT');



  // Versioned migrations run last: they may rebuild tables the bootstrap above
  // just created, and they assume the pre-v1.2 schema is fully in place.
  runMigrations(db);

  /**
   * Publish the legal document catalogue.
   *
   * After `runMigrations`, because migration 007 creates the table it writes to.
   *
   * Deliberately NOT seeded inside that migration: document versions change far
   * more often than the schema does, and freezing the catalogue into a migration
   * would mean a new migration file every time a policy is revised. This is
   * idempotent and derived from `server/legalDocuments.js`, so it converges on
   * every boot — and it throws if a published version's content hash has
   * changed, because that means acceptance rows now point at text nobody
   * actually agreed to.
   */
  syncLegalDocuments(db);

  /**
   * Reconcile the badge catalogue, for the same reason and in the same way.
   *
   * ── Why at init rather than in a migration ──
   *
   * The argument on `syncLegalDocuments` above transfers exactly: a catalogue of
   * definitions changes far more often than the schema does, and freezing it into
   * a migration would mean a new migration file every time a badge is added,
   * reworded or retired. `reconcileBadgeCatalogue` is idempotent and derived from
   * `scripts/seed_badges.js`, so it converges on every boot.
   *
   * ── Why it MUST run automatically ──
   *
   * Migration 024 seeds seven badges on a fresh database, four of which are hour
   * thresholds that duplicate a milestone: a 10-hour "Helping Hand" beside the
   * 10-hour milestone, a 50-hour "Community Champion" beside the 50-hour one. The
   * reconciliation that retires them existed as a hand-run CLI script wired into
   * no npm script, so on every database that nobody remembered to run it against
   * — which is all of them, including a fresh test database — the volunteer
   * profile still showed the same achievement twice under two names.
   *
   * A correction that only lands where somebody remembers to apply it has not
   * landed. This is what makes the catalogue in source the catalogue in the
   * database.
   *
   * It never touches `user_badges`: retiring a definition sets `active = 0`,
   * which freezes the awards already made under it. Somebody's earned badge is
   * their history, and a catalogue clean-up is not a reason to take it.
   */
  reconcileBadgeCatalogue(db);
  seedOrganizerAcceptance();
  assertNoDemoOwner();
}

/**
 * Gives the seeded approved organizer an Organizer Agreement acceptance row.
 *
 * ── Why the demo needs this ──
 *
 * An organizer holds none of the capabilities that reach a student —
 * `applicant.review`, `attendance.mark`, `event.create` and the rest — until an
 * acceptance is on record. See `server/organizerAgreement.js`. Without this row
 * the demo's only working organizer could not open the applicant list for the
 * events they are seeded as running.
 *
 * ── Why a row rather than an exemption ──
 *
 * The tempting alternative is to skip the check for seeded accounts. That would
 * be a second code path in which the gate does not apply, and the demo would stop
 * demonstrating the system it is a demo of. Writing the row keeps the mechanism
 * identical for seeded and real organizers.
 *
 * `user-org-pending` deliberately gets nothing. It is seeded as awaiting approval,
 * so an account with the organizer role and no acceptance is exactly what it
 * should be — which also makes it the natural fixture for the withheld state.
 *
 * ── Why here and not in `seedDatabase` ──
 *
 * `seedDatabase` runs before `runMigrations`, and migration 007 is what creates
 * `legal_acceptances`. Writing it there threw `no such table` on every boot with
 * an empty database. Same constraint, and same reason, as `syncLegalDocuments`
 * above.
 *
 * Idempotent: `acceptOrganizerAgreement` returns early when the current version
 * is already accepted, so this converges on every boot rather than accumulating a
 * row per restart.
 */
function seedOrganizerAcceptance() {
  if (!DEMO_MODE) return;

  const organizer = db.prepare("SELECT id, role FROM users WHERE id = 'user-org-1'").get();
  if (!organizer) return;

  acceptOrganizerAgreement(db, { userId: organizer.id, now: new Date().toISOString() });
}

/**
 * Refuses to boot if a demo database contains a platform owner.
 *
 * ── What used to be here ──
 *
 * `seedSuperAdmin()`, which inserted `user-super` / `owner@wevolunteer.local`
 * with the role `super_admin` and a known password whenever DEMO_MODE was set.
 * It was gated and it was convenient, and it was also the only code in this
 * repository that could create an owner.
 *
 * That mattered more than the gate did. The platform's strongest defence
 * against privilege escalation is not a permission check — it is that no code
 * path exists: there is no `UPDATE users SET role` anywhere in `server/`, and
 * `bin/make-admin.mjs` refuses any role but student and organizer. A seeding
 * function made that "no path except this one", and an invariant with an
 * exception is a convention.
 *
 * Ownership is now created in exactly two ways, both requiring direct access to
 * the database file: `bin/grant-ownership.mjs`, or a deliberate bootstrap by an
 * operator. Neither can be reached by anything running in the application.
 *
 * ── Why a guard rather than simply deleting the function ──
 *
 * Deleting it stops NEW demo databases getting an owner. It does nothing about
 * the ones that already have `user-super` sitting in them from before this
 * change, and those are the dangerous artefact: an account with full control
 * over the platform whose password is a string in this file's git history.
 *
 * So the rule is enforced rather than intended. A demo database carrying an
 * owner fails to start, and says how to remove it.
 */
function assertNoDemoOwner() {
  if (!DEMO_MODE) return;

  /**
   * The SEEDED owner specifically, not every owner.
   *
   * The first version of this refused to boot on any `super_admin` at all, and
   * that was wrong in a way worth recording: a development database is exactly
   * where the real owner accounts get bootstrapped, so the guard fought the
   * thing it was written to protect and would have been switched off within the
   * week.
   *
   * The danger was never "an owner exists". It is this particular row: the one
   * `seedSuperAdmin()` inserted, whose password is a literal in this
   * repository's git history and therefore known to everyone who has ever
   * cloned it. Matched on the fixed id and address that function used, because
   * that is the artefact — an owner created deliberately by an operator is not.
   */
  const seeded = db.prepare(`
    SELECT id, email FROM users
     WHERE role = 'super_admin'
       AND (id = 'user-super' OR email = 'owner@wevolunteer.local')
  `).all();
  if (seeded.length === 0) return;

  const who = seeded.map(o => `${o.email} (${o.id})`).join(', ');
  throw new Error(
    `This database contains the seeded demo owner: ${who}\n\n`
    + 'That account was created by `seedSuperAdmin()`, removed in v1.2.0. Its\n'
    + 'password is a string in this repository\'s git history, so it is a\n'
    + 'full-control account whose credentials are public.\n\n'
    + 'Delete it before starting again:\n'
    + "  DELETE FROM users WHERE id = 'user-super';\n\n"
    + 'Real ownership is granted by bin/bootstrap-owners.mjs or\n'
    + 'bin/grant-ownership.mjs — never by anything the application runs.'
  );
}

/**
 * Creates the hours ledger and backfills it from existing attendance.
 *
 * Safe to run on every boot: creation is IF NOT EXISTS and the backfill is
 * idempotent on a deterministic id. It is additive only — it never writes to
 * `attendance`, so a failure here cannot alter a single volunteer's hours.
 *
 * Parity is checked and reported but does not halt startup. The ledger is not
 * yet read by any hours calculation, so a mismatch is a signal to investigate,
 * not a reason to take the platform down for every user. `npm run verify:hours`
 * is the blocking gate for operators and CI.
 */
function initHoursLedger() {
  createHoursLedgerTable(db);

  const { inserted, skipped, total } = backfillHoursLedger(db);
  if (inserted > 0) {
    console.log(`[Hours ledger] Backfilled ${inserted} entr${inserted === 1 ? 'y' : 'ies'} from ${total} attendance record(s).`);
  }

  const parity = verifyLedgerParity(db);
  if (parity.ok) {
    if (inserted > 0 || skipped > 0) {
      console.log(`[Hours ledger] Parity verified against attendance for ${parity.usersChecked} volunteer(s).`);
    }
  } else {
    console.error('[Hours ledger] PARITY MISMATCH — ledger disagrees with attendance:');
    for (const m of parity.mismatches) {
      console.error(`  ${m.userId}: ledger ${m.ledgerTotal} vs attendance ${m.attendanceTotal}`);
    }
    console.error('[Hours ledger] Credited hours are unaffected (attendance is still the source of truth). Investigate before wiring ledger writes.');
  }
}

/**
 * Creates the certificates table and issues codes for any credited
 * attendance that doesn't have one yet.
 *
 * Safe to run on every boot: creation is IF NOT EXISTS and the backfill is
 * idempotent (skips any (user, event) pair that already has a stored code).
 * Never writes to `attendance`.
 */
function initCertificates() {
  createCertificatesTable(db);

  const { inserted } = backfillCertificates(db);
  if (inserted > 0) {
    console.log(`[Certificates] Issued ${inserted} code(s).`);
  }
}

function seedDatabase() {
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync('password123', salt);
  const nowStr = new Date().toISOString();

  /**
   * Seeded accounts carry a username.
   *
   * They previously did not — the column was simply omitted from this INSERT —
   * so every demo account had `username = NULL`. Signing in with a username is
   * a headline feature of the sign-in screen, and there was no account on a
   * demo or test database that could exercise it. `migrate_usernames.js`
   * backfills real deployments, but it is a manual one-off and never runs here.
   */
  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, avatar, bio, school, skills, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Admins & Organizers
  insertUser.run('user-admin', 'System Admin', 'admin@example.gov', 'sysadmin', passwordHash, 'N/A', 'admin', 1, '🛠️', 'Platform administrator.', 'South Brunswick', JSON.stringify(['Moderation']), nowStr);
  insertUser.run('user-org-1', 'Jacquelyn Katzenback', 'jkatzenback@vikings.org', 'jkatzenback', passwordHash, 'Adult', 'organizer', 1, '👩‍💼', 'Coordinator for Vikings Softball.', 'Vikings Softball', JSON.stringify(['Coordination']), nowStr);
  insertUser.run('user-org-pending', 'Robert Miller', 'rmiller@sbpl.info', 'rmiller', passwordHash, 'Adult', 'organizer', 0, '👨‍🏫', 'Library Director. Pending admin approval.', 'SBPL', JSON.stringify(['Events']), nowStr);


  // Softball volunteers
  insertUser.run('user-diana', 'Diana Sanger', 'diana.sanger@gmail.com', 'dianasanger', passwordHash, 'Adult', 'student', 1, '👩', 'Parent volunteer.', 'SB Softball Booster', JSON.stringify(['Cooking']), nowStr);
  insertUser.run('user-matthew', 'Matthew Polizzotto', 'mpolizzotto@outlook.com', 'mpolizzotto', passwordHash, 'Adult', 'student', 1, '👨', 'Parent volunteer.', 'SB Softball Booster', JSON.stringify(['Grilling']), nowStr);
  insertUser.run('user-norma', 'Norma Carbin', 'ncarbin@comcast.net', 'ncarbin', passwordHash, 'Adult', 'student', 1, '👩', 'Parent volunteer, glad to restock and reset.', 'SB Softball Booster', JSON.stringify(['Restocking']), nowStr);
  insertUser.run('user-colin', 'Colin Carbin', 'colin.carbin29@outlook.com', 'colincarbin', passwordHash, '11', 'student', 1, '🧑', 'High school volunteer.', 'South Brunswick HS', JSON.stringify(['Cashier']), nowStr);
  insertUser.run('user-alexia', 'Alexia Burnett', 'aburnett@gmail.com', 'aburnett', passwordHash, 'Adult', 'student', 1, '👩', 'Parent volunteer.', 'SB Softball Booster', JSON.stringify(['Cooking']), nowStr);
  insertUser.run('user-advait', 'Advaitkrishna G.', 'advait.g@yahoo.com', 'advaitg', passwordHash, '10', 'student', 1, '🧑', 'High school volunteer.', 'South Brunswick HS', JSON.stringify(['Food Prep']), nowStr);
  insertUser.run('user-david', 'David Sanger', 'dsanger@outlook.com', 'dsanger', passwordHash, 'Adult', 'student', 1, '👨', 'Parent volunteer, usually on clean-up.', 'SB Softball Booster', JSON.stringify(['Cleanup']), nowStr);
  insertUser.run('user-pranathi', 'Pranathi Sukumar', 'pranathi.s@gmail.com', 'pranathis', passwordHash, '11', 'student', 1, '👩', 'Interested in environmental clean-ups.', 'South Brunswick HS', JSON.stringify(['Litter cleanup']), nowStr);

  // Core simulated students
  insertUser.run('user-student-1', 'Leo Chen', 'leo.chen28@gmail.com', 'leochen', passwordHash, '10', 'student', 1, '🧑‍💻', 'First year volunteering — keen to try everything.', 'South Brunswick HS', JSON.stringify(['Setup', 'Math']), nowStr);
  insertUser.run('user-student-2', 'Priya Patel', 'priya.patel.nhs@outlook.com', 'priyapatel', passwordHash, '11', 'student', 1, '👩‍⚕️', 'Happy to help with anything hands-on.', 'South Brunswick HS', JSON.stringify(['First Aid']), nowStr);
  insertUser.run('user-student-3', 'Ethan Miller', 'emiller2027@gmail.com', 'ethanmiller', passwordHash, '12', 'student', 1, '🧑‍🎨', 'Enjoys set-up and anything creative.', 'South Brunswick HS', JSON.stringify(['Art']), nowStr);

  /**
   * Seed dates are relative to seeding time, never absolute.
   *
   * They were hardcoded — the only open event's shifts were pinned to
   * 2026-07-11 — so from 2026-07-12 onwards a freshly seeded demo database had
   * no upcoming shift at all. Every screen the product is judged on came up
   * empty: nothing to browse, nothing to apply to, an empty dashboard and an
   * empty calendar, with no hint that the cause was a stale constant. A demo
   * that silently expires is worse than one that fails loudly, because whoever
   * is being shown it concludes the product does not work.
   *
   * `atDay` keeps the wall-clock time of day so the seeded shifts still read as
   * plausible morning slots rather than landing at whatever time seeding ran.
   */
  const atDay = (daysFromNow, hh, mm = 0) => {
    const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
    d.setUTCHours(hh, mm, 0, 0);
    return d.toISOString();
  };

  // Seed Events
  const insertEvent = db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, auto_approve, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertEvent.run(
    'event-softball',
    'Softball Tournament Snack Shack',
    'Every shift must have an adult volunteer due to cooking/grilling. The remaining slots can be taken by either high school volunteers, or additional parents. We are requesting that each family signs up for at least one time slot. Thank you!',
    'Other',
    'Reichler Park',
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    'user-org-1',
    'open',
    0,
    nowStr
  );

  insertEvent.run(
    'event-pantry-past',
    'Food Pantry Boxing & Distribution',
    'Load delivery boxes and sort food cans for South Brunswick families.',
    'Food Pantry',
    'SB Food Pantry Hall',
    atDay(-26, 17),
    'user-org-1',
    'completed',
    0,
    nowStr
  );

  // Seed Slots
  const insertSlot = db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Softball slots
  insertSlot.run('slot-softball-1', 'event-softball', 'Adult', 'Grilling & cooking helper (Adult volunteer).', atDay(12, 7, 30), atDay(12, 9, 30), 1);
  insertSlot.run('slot-softball-2', 'event-softball', 'Volunteer (any age)', 'High school volunteer or additional parent help.', atDay(12, 7, 30), atDay(12, 9, 30), 2);
  insertSlot.run('slot-softball-3', 'event-softball', 'Adult', 'Grilling & cooking helper (Adult volunteer).', atDay(12, 9, 30), atDay(12, 11, 30), 1);
  insertSlot.run('slot-softball-4', 'event-softball', 'Volunteer (any age)', 'High school volunteer or additional parent help.', atDay(12, 9, 30), atDay(12, 11, 30), 2);
  insertSlot.run('slot-softball-5', 'event-softball', 'Adult', 'Grilling & cooking helper (Adult volunteer).', atDay(12, 11, 30), atDay(12, 13, 30), 1);
  insertSlot.run('slot-softball-6', 'event-softball', 'Volunteer (any age)', 'High school volunteer or additional parent help.', atDay(12, 11, 30), atDay(12, 13, 30), 2);
  insertSlot.run('slot-softball-7', 'event-softball', 'Check park for litter', 'Walk around entire softball area. Pick up and throw away any litter.', atDay(12, 11, 30), atDay(12, 13, 30), 2);

  // Past event slots
  insertSlot.run('slot-pantry-1', 'event-pantry-past', 'Box Packer', 'Sort and pack grocery boxes.', atDay(-25, 9), atDay(-25, 12), 2);

  // Seed Applications
  const insertApp = db.prepare(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertApp.run('app-sb-1', 'user-diana',    'event-softball', 'slot-softball-1', 'accepted', nowStr);
  insertApp.run('app-sb-2', 'user-matthew',  'event-softball', 'slot-softball-3', 'accepted', nowStr);
  insertApp.run('app-sb-3', 'user-norma',    'event-softball', 'slot-softball-4', 'accepted', nowStr);
  insertApp.run('app-sb-4', 'user-colin',    'event-softball', 'slot-softball-4', 'accepted', nowStr);
  insertApp.run('app-sb-5', 'user-alexia',   'event-softball', 'slot-softball-5', 'accepted', nowStr);
  insertApp.run('app-sb-6', 'user-student-1','event-softball', 'slot-softball-6', 'accepted', nowStr);
  insertApp.run('app-sb-7', 'user-advait',   'event-softball', 'slot-softball-6', 'accepted', nowStr);
  insertApp.run('app-sb-8', 'user-david',    'event-softball', 'slot-softball-7', 'accepted', nowStr);
  insertApp.run('app-sb-9', 'user-pranathi', 'event-softball', 'slot-softball-7', 'accepted', nowStr);
  insertApp.run('app-sb-10','user-student-2','event-softball', 'slot-softball-2', 'pending',  nowStr);

  insertApp.run('app-past-p1', 'user-student-2', 'event-pantry-past', 'slot-pantry-1', 'accepted', nowStr);
  insertApp.run('app-past-p2', 'user-student-3', 'event-pantry-past', 'slot-pantry-1', 'accepted', nowStr);

  // Seed Attendance
  const insertAttendance = db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertAttendance.run('event-pantry-past', 'slot-pantry-1', 'user-student-2', 1, 3.0);
  insertAttendance.run('event-pantry-past', 'slot-pantry-1', 'user-student-3', 0, 3.0);

  // ── Seed a few notifications and a sample comment so the new features
  // don't look empty on first run ──
  const insertNotif = db.prepare(`
    INSERT INTO notifications (id, user_id, kind, title, body, link, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertNotif.run('notif-1', 'user-student-1', 'reminder', 'Upcoming shift tomorrow',
    'Softball Tournament Snack Shack — Adult shift at 7:30 AM. Don\'t forget!',
    null, 0, nowStr);
  insertNotif.run('notif-2', 'user-student-1', 'hours', 'New hours credited',
    'You earned 2.0 hrs from Softball Tournament Snack Shack.',
    null, 0, nowStr);
  insertNotif.run('notif-3', 'user-org-1', 'application', 'New volunteer application',
    'A student applied to your Softball Tournament — General Shift.',
    null, 0, nowStr);

  const insertComment = db.prepare(`
    INSERT INTO event_comments (id, event_id, user_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertComment.run('cmt-1', 'event-softball', 'user-org-1',
    'Please arrive 15 minutes before your shift for setup. Wear closed-toe shoes!', nowStr);
  insertComment.run('cmt-2', 'event-softball', 'user-diana',
    'Thanks for organizing this! Looking forward to helping out.', nowStr);

  const insertAnnouncement = db.prepare(`
    INSERT INTO event_announcements (id, event_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertAnnouncement.run('ann-1', 'event-softball', 'user-org-1',
    'Park at the Reichler Park south lot and check in at the snack shack window. ' +
    'Wear closed-toe shoes — anyone on the grill also needs long sleeves.', nowStr);
}

export { db };
