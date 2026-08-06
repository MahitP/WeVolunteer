/**
 * Conversations that are not about an event, so an administrator can reach a person.
 *
 * ── The defect ──
 *
 * `conversations` was `(event_id, student_id, organizer_id)`, all NOT NULL, keyed
 * `UNIQUE(student_id, organizer_id, event_id)`. Every thread the schema could hold
 * was a student and an organizer talking about one event.
 *
 * `messaging.js`'s `eligibleRelationship` has an admin branch, which is what made
 * admin messaging look built. It is not: `resolveConversation` always writes the
 * row between `student_id` and `organizer_id`, so an admin who resolved one was
 * NOT a participant and received 404 on both read and send. That branch exists to
 * let an admin inspect a student↔organizer thread, not to message anybody.
 *
 * Granting `message.send` to admin — which was tried, and reverted — replaced the
 * permission error with an empty inbox. The shape of the table was the problem.
 *
 * ── Why not put the admin in `organizer_id` ──
 *
 * It would work mechanically, and it is the wrong record: it states in the data
 * that an administrator is the event's organizer. It also inherits
 * `computeConversationLifecycle`, which turns a thread read-only 30 days after the
 * event ends — a rule with no meaning for a moderation contact, and one that would
 * silently close the channel a student was using to reach an administrator.
 *
 * ── Why a rebuild ──
 *
 * SQLite cannot drop NOT NULL. An admin thread has no event and no counterparty in
 * one of the two role columns, so those three constraints have to go, and the only
 * way there is a table rebuild. This is the SECOND sanctioned destructive rebuild
 * in this repo, and it carries all six guards ENGINEERING_GUIDE §8.3 requires —
 * copied from `001_authz_roles.js` as that section instructs, because
 * `conversations` has three ON DELETE CASCADE children (`messages`,
 * `conversation_participants`, `conversation_reports`) and one of them holds
 * students' private messages. A rebuild with foreign keys ON would silently empty
 * all three.
 *
 * **Take a backup before running this**, per §8.3. `wevolunteer-backup.timer`
 * exists; a restore has not been drilled.
 *
 * ── Where membership lives ──
 *
 * In `conversation_participants`, which already existed and which
 * `isConversationParticipant` already reads — the two role columns were never what
 * authorised a read. So the admin is a participant row like anybody else, and
 * `kind` records what sort of thread it is. Nothing parallel is introduced.
 *
 * `created_by` identifies WHICH administrator a moderation thread belongs to. That
 * matters for uniqueness: see the partial index below.
 *
 * ── Rollback ──
 *
 * There is no clean automatic down. Reverting means recreating the old table with
 * the NOT NULLs, which fails if any admin thread exists. Delete admin threads
 * first (they cascade to their messages and participants), then rebuild with the
 * original CREATE TABLE from db.js, then `DELETE FROM schema_migrations WHERE
 * version = 18`.
 */

/**
 * The columns copied, spelled out.
 *
 * NEVER `SELECT *`. Column ORDER differs between databases — one built by
 * `initDatabase()`'s bootstrap and one built by an earlier rebuild are not
 * guaranteed to agree — and `INSERT ... SELECT *` matches by position, so a
 * mismatch writes `student_id` into `organizer_id`. That is the incident
 * §8.3 records against the old `applications` rebuild in db.js.
 */
export const EXPECTED_CONVERSATION_COLUMNS = [
  'id', 'event_id', 'student_id', 'organizer_id', 'created_by', 'created_at',
  'last_message_id', 'last_message_at', 'lifecycle_state', 'read_only_reason',
  'read_only_at', 'archived_by_system_at',
];

/**
 * Row counts for every table that would be cascade-emptied by dropping
 * `conversations`, derived from the schema rather than listed.
 *
 * A hand-written list is a guard that stops covering a child added later — and the
 * child most likely to be added to this table is another evidence table.
 */
function countCascadingChildren(db) {
  const counts = {};
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);

  for (const table of tables) {
    if (table === 'conversations' || table === 'conversations_new') continue;
    // Table names come from sqlite_master, never from user input.
    const references = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .some(fk => fk.table === 'conversations');
    if (references) counts[table] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  }
  return counts;
}

function up(db) {
  // Already rebuilt? The `kind` column is the cheapest reliable probe.
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'"
  ).get();
  if (!existing) return;                       // fresh database; db.js has not run yet
  if (existing.sql.includes('kind')) return;

  /**
   * A column this migration does not know about would be silently DROPPED by the
   * explicit copy. Fail loudly instead — the data in it is somebody's messages.
   */
  const actual = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
  const unknown = actual.filter(c => !EXPECTED_CONVERSATION_COLUMNS.includes(c));
  const missing = EXPECTED_CONVERSATION_COLUMNS.filter(c => !actual.includes(c));
  if (unknown.length) {
    throw new Error(
      `conversations has unexpected columns [${unknown.join(', ')}]. Add them to `
      + 'EXPECTED_CONVERSATION_COLUMNS and to the CREATE TABLE in '
      + '018_admin_conversations.js, then re-run. Copying without them would delete '
      + 'that data.'
    );
  }
  if (missing.length) {
    throw new Error(
      `conversations is missing expected columns [${missing.join(', ')}]. `
      + 'initDatabase() must create the table before migrations run.'
    );
  }

  const cols = EXPECTED_CONVERSATION_COLUMNS.join(', ');
  const fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;

  db.exec('PRAGMA foreign_keys = OFF');        // MUST be outside the transaction
  try {
    /**
     * Verify the pragma took effect. This is the one failure here that nothing
     * else can catch: the copy's own row count only covers `conversations`, whose
     * rows are copied and survive; `PRAGMA foreign_key_check` reports nothing
     * because a cascade DELETES children rather than orphaning them; and the
     * ROLLBACK never fires because nothing throws. Without this, the migration
     * would commit a database with every message gone and report success.
     *
     * Setting the pragma inside an open transaction is a silent no-op, which is
     * exactly how that would happen — hence `ownTransaction: true`.
     */
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 0) {
      throw new Error(
        'PRAGMA foreign_keys = OFF did not take effect — a transaction is already open. '
        + 'Aborting: DROP TABLE conversations would cascade-delete every message.'
      );
    }

    db.exec('BEGIN');
    try {
      /**
       * The new shape. Three columns lose NOT NULL; `kind` is added.
       *
       * `kind` defaults to 'student_organizer' so the copy below does not have to
       * name it and every existing row is classified correctly — which is what
       * every existing row IS, since no other kind could be created.
       *
       * The role columns keep their meaning: `student_id` is the student in this
       * conversation and `organizer_id` is the organizer, whichever of them is
       * present. An admin thread fills exactly one of them — the counterparty —
       * and identifies the administrator through `created_by` and the participant
       * row. Nobody is misrepresented as somebody they are not.
       */
      db.exec(`
        CREATE TABLE conversations_new (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'student_organizer'
            CHECK(kind IN ('student_organizer', 'admin_student', 'admin_organizer')),
          event_id TEXT,
          student_id TEXT,
          organizer_id TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_message_id TEXT,
          last_message_at TEXT,
          lifecycle_state TEXT CHECK(lifecycle_state IN ('active', 'read_only')) DEFAULT 'active',
          read_only_reason TEXT,
          read_only_at TEXT,
          archived_by_system_at TEXT,
          /**
           * An event-scoped thread still requires all three. Enforced as a CHECK
           * rather than by NOT NULL, because the constraint is now conditional:
           * dropping NOT NULL to admit admin threads must not also admit a
           * student_organizer row with no event, which every event query and the
           * lifecycle rules would then read as a thread about nothing.
           */
          CHECK(
            kind != 'student_organizer'
            OR (event_id IS NOT NULL AND student_id IS NOT NULL AND organizer_id IS NOT NULL)
          ),
          /** A moderation thread has exactly one counterparty and no event. */
          CHECK(kind != 'admin_student' OR (student_id IS NOT NULL AND organizer_id IS NULL)),
          CHECK(kind != 'admin_organizer' OR (organizer_id IS NOT NULL AND student_id IS NULL)),
          FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
          FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(organizer_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(student_id, organizer_id, event_id)
        )
      `);

      /**
       * Second layer of defence for the same failure the pragma check covers. The
       * pragma proves foreign keys are off NOW; this proves no child row actually
       * vanished, whatever the cause. Snapshot before anything is mutated and
       * compare after the rename, so a loss throws and the ROLLBACK undoes it —
       * the catastrophic path becomes recoverable rather than merely detectable.
       */
      const childCounts = countCascadingChildren(db);

      const before = db.prepare('SELECT COUNT(*) c FROM conversations').get().c;
      db.exec(`INSERT INTO conversations_new (${cols}) SELECT ${cols} FROM conversations`);
      const after = db.prepare('SELECT COUNT(*) c FROM conversations_new').get().c;
      if (before !== after) throw new Error(`Row count changed during copy: ${before} -> ${after}`);

      db.exec('DROP TABLE conversations');
      db.exec('ALTER TABLE conversations_new RENAME TO conversations');

      for (const [table, expected] of Object.entries(childCounts)) {
        const seen = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
        if (seen !== expected) {
          throw new Error(
            `${table} lost rows during the conversations rebuild: ${expected} -> ${seen}. `
            + 'Foreign keys were enforced during DROP TABLE and cascade-deleted them.'
          );
        }
      }

      // DROP TABLE took the index with it. Recreate it, matching db.js.
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_event ON conversations(event_id)');

      /**
       * One moderation thread per (administrator, counterparty), enforced.
       *
       * `UNIQUE(student_id, organizer_id, event_id)` cannot do this job: SQLite
       * treats NULLs as distinct, so every admin thread — which has NULLs in two of
       * those three columns — is unique to that constraint no matter how many times
       * it is created. Without this index, pressing "message" twice would silently
       * produce a second thread and split the conversation in half.
       *
       * `COALESCE(student_id, organizer_id)` is the counterparty, and the CHECKs
       * above guarantee exactly one of the two is present, so it is never NULL for
       * the rows this index covers.
       *
       * Keyed on `created_by` rather than being global, so two administrators can
       * each hold their own thread with the same person — which is the correct
       * semantics for a moderation contact, not a shared mailbox.
       */
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_admin_thread
          ON conversations(kind, created_by, COALESCE(student_id, organizer_id))
          WHERE kind IN ('admin_student', 'admin_organizer')
      `);

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error(
          `${violations.length} foreign key violations after the conversations rebuild`
        );
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

export default {
  version: 18,
  name: 'admin_conversations',
  ownTransaction: true,
  up,
  fileUrl: import.meta.url,
};
