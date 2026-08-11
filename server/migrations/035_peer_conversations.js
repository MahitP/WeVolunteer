/**
 * Conversations between two members who are friends.
 *
 * ── The defect ──
 *
 * A student could not message a friend. Not "the button was missing" — the
 * schema had no shape for it. Every row `conversations` could hold was a student
 * and an organizer talking about one event (`kind = 'student_organizer'`), or an
 * administrator's moderation thread with one person (018's two `admin_*` kinds).
 * A student↔student thread is neither, and `kind`'s CHECK constraint listed
 * exactly those three values, so an attempt to write one was refused by SQLite.
 *
 * Friendship itself has existed since 031: `user_relationships`, `areFriends`,
 * accept/remove, mute, restrict, block. It gated the friends-only profile tier
 * and the signup notifications. It unlocked no way to actually talk, which is
 * the thing a fourteen-year-old means by "friend".
 *
 * ── Why a fourth `kind` and not one of the three ──
 *
 * `student_organizer` is out: its CHECK demands an event, and the whole point is
 * a thread that is not about one. Its lifecycle rules would also apply, so a
 * friendship would go read-only 30 days after some unrelated event ended.
 *
 * Reusing `admin_student` is worse — it would state in the data that an ordinary
 * student is an administrator conducting moderation, and would put the thread in
 * front of anything reading `kind` to decide whether a conversation is staff
 * contact.
 *
 * ── Where the two participants are recorded ──
 *
 * In `conversation_participants`, which is already the authority — 018's header
 * says it outright: "the two role columns were never what authorised a read",
 * and `isConversationParticipant` is what every handler actually checks. So a
 * peer thread leaves `event_id`, `student_id` AND `organizer_id` all NULL rather
 * than picking one of the two friends to call "the student" and the other "the
 * organizer". Both are students. Neither is an organizer. Writing one of them
 * into `organizer_id` would be the same category of lie 018 refused when it
 * declined to seat an administrator there.
 *
 * ── `pair_key`, and why the existing indexes cannot do this job ──
 *
 * Two friends must have ONE thread, however many times either of them presses
 * "message" and whichever of them presses it first.
 *
 * `UNIQUE(student_id, organizer_id, event_id)` cannot enforce that: all three are
 * NULL for a peer row, and SQLite treats NULLs as distinct, so every peer thread
 * is unique to that constraint no matter how many exist. 018's
 * `idx_conversations_admin_thread` cannot either, and not only because of its
 * WHERE clause — it is keyed on `created_by`, which for a peer thread is
 * whichever friend opened it. A→B and B→A would differ in that column and both
 * be admitted, splitting one friendship's messages across two threads that each
 * party sees half of.
 *
 * So the key has to be the unordered PAIR. `pair_key` stores it canonically as
 * `min(a,b) || ':' || max(a,b)`, which is direction-independent by construction,
 * and a partial unique index over it is what makes a concurrent double-tap
 * collide in the database rather than in a lookup that two requests can both
 * miss. `messaging.js` owns the one function that builds the string
 * (`peerPairKey`) so the ordering rule has a single definition.
 *
 * NULL for every other kind, so the partial index covers only peer rows and the
 * three existing kinds are untouched by it.
 *
 * ── Why a rebuild ──
 *
 * SQLite cannot alter a CHECK constraint. `kind`'s CHECK names three values and
 * a fourth has to be admitted, so the table has to be recreated. This is the
 * THIRD sanctioned destructive rebuild in this repo and it carries all six
 * guards ENGINEERING_GUIDE §8.3 requires, copied from `018_admin_conversations.js`
 * as that section instructs — `conversations` still has three ON DELETE CASCADE
 * children (`messages`, `conversation_participants`, `conversation_reports`) and
 * one of them holds students' private messages. A rebuild with foreign keys ON
 * would silently empty all three.
 *
 * **Take a backup before running this**, per §8.3.
 *
 * ── Rollback ──
 *
 * Delete peer threads first (`DELETE FROM conversations WHERE kind = 'peer'` —
 * they cascade to their messages and participants), then rebuild with 018's
 * CREATE TABLE, then `DELETE FROM schema_migrations WHERE version = 35`.
 */

/**
 * The columns copied, spelled out.
 *
 * NEVER `SELECT *`. Column ORDER differs between databases — one built by
 * `initDatabase()`'s bootstrap and one built by an earlier rebuild are not
 * guaranteed to agree — and `INSERT ... SELECT *` matches by position, so a
 * mismatch writes `student_id` into `organizer_id`. That is the incident §8.3
 * records against the old `applications` rebuild in db.js.
 *
 * `pair_key` is deliberately absent: it is the column this migration ADDS, so
 * there is nothing in the old table to copy into it.
 */
export const EXPECTED_CONVERSATION_COLUMNS = [
  'id', 'kind', 'event_id', 'student_id', 'organizer_id', 'created_by', 'created_at',
  'last_message_id', 'last_message_at', 'lifecycle_state', 'read_only_reason',
  'read_only_at', 'archived_by_system_at',
];

/**
 * Row counts for every table that would be cascade-emptied by dropping
 * `conversations`, derived from the schema rather than listed.
 *
 * A hand-written list is a guard that stops covering a child added later — and
 * `conversation_reports` was exactly such a child once.
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
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'"
  ).get();
  if (!existing) return;                       // fresh database; db.js has not run yet

  /**
   * Already rebuilt? `pair_key` is the cheapest reliable probe — it is the one
   * thing this migration adds that 018 could not have left behind.
   *
   * Deliberately NOT probing for the string 'peer': `kind` is compared against a
   * list that will grow, and a substring test against the whole CREATE TABLE
   * would also match a future kind whose name merely contains it.
   */
  if (existing.sql.includes('pair_key')) return;

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
      + '035_peer_conversations.js, then re-run. Copying without them would delete '
      + 'that data.'
    );
  }
  if (missing.length) {
    throw new Error(
      `conversations is missing expected columns [${missing.join(', ')}]. `
      + '018_admin_conversations.js must run before this migration.'
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
       * The new shape. `kind` admits 'peer'; `pair_key` is added.
       *
       * The three existing CHECKs are carried across UNCHANGED — an event-scoped
       * thread still requires all three columns, and a moderation thread still
       * requires exactly one counterparty and no event. A rebuild is the moment
       * those are easiest to lose, and losing one would admit precisely the rows
       * 018 wrote them to forbid.
       */
      db.exec(`
        CREATE TABLE conversations_new (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'student_organizer'
            CHECK(kind IN ('student_organizer', 'admin_student', 'admin_organizer', 'peer')),
          event_id TEXT,
          student_id TEXT,
          organizer_id TEXT,
          /**
           * The two friends, canonically ordered, for peer threads only. See the
           * header: this is the only constraint that can make one friendship mean
           * one thread regardless of who opened it.
           */
          pair_key TEXT,
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
           * rather than by NOT NULL, because the constraint is conditional:
           * admitting admin and peer threads with no event must not also admit a
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
          /**
           * A peer thread names NOBODY in the role columns and everybody in
           * pair_key.
           *
           * The NULLs are asserted rather than merely expected. Both friends are
           * students, so a well-meaning future writer could reasonably think
           * student_id should hold one of them — and that row would then be
           * picked up by every query that reads student_id to mean "the student
           * this thread is about", including the admin-thread lookup. Requiring
           * pair_key in the same breath is what stops a peer row existing
           * without the only key that makes it unique.
           */
          CHECK(
            kind != 'peer'
            OR (event_id IS NULL AND student_id IS NULL AND organizer_id IS NULL
                AND pair_key IS NOT NULL)
          ),
          /* ...and no other kind may carry one, so the partial index is exact. */
          CHECK(kind = 'peer' OR pair_key IS NULL),
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
       * compare after the rename, so a loss throws and the ROLLBACK undoes it.
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

      /* DROP TABLE took both indexes with it. Recreate them — the first matching
         db.js, the second matching 018. Losing the admin one would silently allow
         a second moderation thread per (administrator, person). */
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_event ON conversations(event_id)');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_admin_thread
          ON conversations(kind, created_by, COALESCE(student_id, organizer_id))
          WHERE kind IN ('admin_student', 'admin_organizer')
      `);

      /**
       * One thread per friendship, enforced by the database.
       *
       * The lookup in `resolvePeerConversation` handles the normal case; this
       * handles two requests that both miss it. Without it, a double-tap on a slow
       * connection produces two threads for one friendship and each friend sees
       * half the conversation.
       */
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_peer_pair
          ON conversations(pair_key)
          WHERE kind = 'peer'
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
  version: 35,
  name: 'peer_conversations',
  ownTransaction: true,
  up,
  fileUrl: import.meta.url,
};
