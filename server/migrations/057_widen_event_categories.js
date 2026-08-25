/**
 * A vocabulary of sixteen categories instead of four and a shrug.
 *
 * ── What changes ──
 *
 * `events.category` carried `CHECK(category IN ('School', '5K', 'Food Pantry',
 * 'Fundraiser', 'Other'))` from the original schema. The reasoning for the wider
 * list lives in `server/eventCategories.js`; this migration is only the part
 * SQLite makes expensive.
 *
 * The change is **purely additive to the vocabulary**. Every one of the five
 * original values survives, spelled identically, so no existing row can fail the
 * new constraint and no row's value is rewritten. There is no backfill and
 * nothing to roll back at the data level.
 *
 * ── Why a rebuild ──
 *
 * SQLite cannot alter a CHECK constraint in place. The alternatives were
 * dropping the constraint (which is the thing keeping a typo out of a column the
 * Impact Dashboard aggregates on) or leaving the vocabulary as it was. Migration
 * 046 made the same trade for `organization_members.member_role`.
 *
 * ── Why the full guard set, when 046 needed none of it ──
 *
 * `organization_members` has no children. `events` has ELEVEN tables holding
 * `ON DELETE CASCADE` foreign keys to it — `slots`, `applications`,
 * `attendance`, `attendance_checkin`, `checkin_tokens`, `event_tags`,
 * `event_comments`, `event_announcements`, `user_favorites`, `auto_select_runs`
 * and `conversations`. Two of those are the ones this platform exists to
 * protect: `attendance` is students' credited service hours, and
 * `conversations` cascades to their private messages.
 *
 * So `DROP TABLE events` with foreign keys live would silently empty the
 * database of everything that matters, commit, and report success. This is the
 * third sanctioned destructive rebuild in the repo and it carries all six
 * guards ENGINEERING_GUIDE §8.3 requires, copied from `018_admin_conversations.js`
 * as that section instructs.
 *
 * **Take a backup before running this**, per §8.3.
 *
 * ── Rollback ──
 *
 * Recreate the table with the narrow CHECK using the original `CREATE TABLE`
 * from `db.js`, then `DELETE FROM schema_migrations WHERE version = 57`. That
 * fails while any event holds one of the new values, which is correct: the fix
 * then is to re-file those events under one of the five, and the failure names
 * the constraint rather than deleting the rows.
 *
 * ── PostgreSQL ──
 *
 * A NEW PostgreSQL database gets the widened CHECK for free: its schema is
 * generated from a freshly-migrated SQLite database, so `postgresSchema.js`
 * carries the sixteen values and `db.postgresSchema.test.js` fails the build
 * until it has been regenerated.
 *
 * An EXISTING one gets nothing that way, and that is the whole reason `postgres`
 * below exists. Every statement in the generated schema is
 * `CREATE TABLE IF NOT EXISTS`, which against a table that already exists is a
 * no-op — so a deployment provisioned last week would have kept the five-value
 * constraint, accepted `School` and refused `Animals`, with the boot reporting
 * success and the first symptom being a constraint violation on a value the
 * dropdown offered. `runPostgresMigrations` walks it through instead.
 *
 * The PostgreSQL version is four lines rather than a rebuild, because
 * PostgreSQL can `ALTER` a CHECK constraint in place. That asymmetry is the
 * point the schema generator's header makes: the SQLite rebuild is a workaround
 * for a limitation the target engine does not have, and porting the workaround
 * would be a longer route to the same schema.
 */
import { VALID_CATEGORIES } from '../eventCategories.js';

/**
 * The columns copied, spelled out.
 *
 * NEVER `SELECT *`. Column ORDER differs between databases — the tail of this
 * list is whatever order the historical `addColumnIfMissing()` calls happened to
 * run in — and `INSERT ... SELECT *` matches by position, so a mismatch writes
 * `latitude` into `longitude`.
 */
export const EXPECTED_EVENT_COLUMNS = [
  'id', 'title', 'description', 'category', 'location', 'application_deadline',
  'organizer_id', 'status', 'auto_approve', 'selection_summary', 'created_at',
  'instructions', 'attendee_visibility', 'address', 'latitude', 'longitude',
  'organization_id', 'credits_hours', 'audience',
];

/**
 * The CHECK list, built from the vocabulary module rather than typed out here.
 *
 * A hand-copied list is a second place to add a category to, and forgetting it
 * turns "the dropdown offers it" into a constraint violation at INSERT — a 500
 * on the publish button. Single-quoted values are safe to interpolate because
 * the source is a frozen literal in this repo, not input; the assertion below
 * refuses anything that could not have come from it.
 */
function checkList() {
  for (const value of VALID_CATEGORIES) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9 &]+$/.test(value)) {
      throw new Error(
        `Event category ${JSON.stringify(value)} cannot be written into a CHECK `
        + 'constraint. Categories are plain words; see server/eventCategories.js.'
      );
    }
  }
  return VALID_CATEGORIES.map(v => `'${v}'`).join(', ');
}

/**
 * Row counts for every table that would be cascade-emptied by dropping
 * `events`, derived from the schema rather than listed.
 *
 * A hand-written list is a guard that stops covering a child added later, and
 * `events` gains children often.
 */
function countCascadingChildren(db) {
  const counts = {};
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);

  for (const table of tables) {
    if (table === 'events' || table === 'events_new') continue;
    // Table names come from sqlite_master, never from user input.
    const references = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .some(fk => fk.table === 'events');
    if (references) counts[table] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  }
  return counts;
}

export function up(db) {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
  ).get();
  if (!existing) return;                        // fresh database; db.js has not run yet

  /* Already widened. Probed on a value that only the new vocabulary contains, so
     a re-run is a no-op rather than a second rebuild that drops the indexes
     again for nothing. */
  if (existing.sql.includes("'Donation Drive'")) return;

  /**
   * A column this migration does not know about would be silently DROPPED by the
   * explicit copy, and a column it expects and cannot find means the table is
   * not in the state assumed here.
   */
  const actual = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  const unknown = actual.filter(c => !EXPECTED_EVENT_COLUMNS.includes(c));
  const missing = EXPECTED_EVENT_COLUMNS.filter(c => !actual.includes(c));
  if (unknown.length) {
    throw new Error(
      `events has unexpected columns [${unknown.join(', ')}]. Add them to `
      + 'EXPECTED_EVENT_COLUMNS and to the CREATE TABLE in '
      + '057_widen_event_categories.js, then re-run. Copying without them would '
      + 'delete that data.'
    );
  }
  if (missing.length) {
    throw new Error(
      `events is missing expected columns [${missing.join(', ')}]. `
      + 'initDatabase() must create the table before migrations run.'
    );
  }

  const cols = EXPECTED_EVENT_COLUMNS.join(', ');
  const fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;

  db.exec('PRAGMA foreign_keys = OFF');         // MUST be outside the transaction
  try {
    /**
     * Verify the pragma took effect. Nothing else can catch this failure: the
     * copy's own row count only covers `events`, whose rows survive; `PRAGMA
     * foreign_key_check` reports nothing because a cascade DELETES children
     * rather than orphaning them; and the ROLLBACK never fires because nothing
     * throws. Without this the migration would commit a database with every
     * application, every attendance record and every message gone, and report
     * success.
     */
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 0) {
      throw new Error(
        'PRAGMA foreign_keys = OFF did not take effect — a transaction is already open. '
        + 'Aborting: DROP TABLE events would cascade-delete every application, '
        + 'attendance record and event conversation.'
      );
    }

    db.exec('BEGIN');
    try {
      /**
       * The new shape, character-for-character the old one but for the CHECK on
       * `category`. Written out in full rather than derived from
       * `existing.sql`, so what this migration produces is readable here and
       * cannot be surprised by whatever an earlier `ALTER TABLE ADD COLUMN`
       * left in the stored DDL.
       */
      db.exec(`
        CREATE TABLE events_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          category TEXT CHECK(category IN (${checkList()})) NOT NULL,
          location TEXT NOT NULL,
          application_deadline TEXT NOT NULL,
          organizer_id TEXT NOT NULL,
          status TEXT CHECK(status IN ('open', 'closed', 'completed', 'cancelled')) DEFAULT 'open',
          auto_approve INTEGER DEFAULT 0,
          selection_summary TEXT,
          created_at TEXT NOT NULL,
          instructions TEXT,
          attendee_visibility TEXT NOT NULL DEFAULT 'accepted',
          address TEXT,
          latitude REAL,
          longitude REAL,
          organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
          credits_hours INTEGER NOT NULL DEFAULT 1,
          audience TEXT NOT NULL DEFAULT 'everyone',
          FOREIGN KEY(organizer_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      /**
       * Second layer of defence for the same failure the pragma check covers.
       * The pragma proves foreign keys are off NOW; this proves no child row
       * actually vanished, whatever the cause. Snapshot before anything is
       * mutated and compare after the rename, so a loss throws and the ROLLBACK
       * undoes it.
       */
      const childCounts = countCascadingChildren(db);

      const before = db.prepare('SELECT COUNT(*) c FROM events').get().c;
      db.exec(`INSERT INTO events_new (${cols}) SELECT ${cols} FROM events`);
      const after = db.prepare('SELECT COUNT(*) c FROM events_new').get().c;
      if (before !== after) throw new Error(`Row count changed during copy: ${before} -> ${after}`);

      db.exec('DROP TABLE events');
      db.exec('ALTER TABLE events_new RENAME TO events');

      for (const [table, expected] of Object.entries(childCounts)) {
        const seen = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
        if (seen !== expected) {
          throw new Error(
            `${table} lost rows during the events rebuild: ${expected} -> ${seen}. `
            + 'Foreign keys were enforced during DROP TABLE and cascade-deleted them.'
          );
        }
      }

      /* DROP TABLE took the indexes with it. Recreated exactly as db.js and
         migration 045 declare them. */
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_organization ON events(organization_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_audience ON events(audience, organization_id)');

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error(
          `${violations.length} foreign key violations after the events rebuild`
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

/**
 * The same widening, on PostgreSQL.
 *
 * ── Why the constraint is looked up rather than named ──
 *
 * PostgreSQL names an inline column CHECK automatically, and the name it picks
 * depends on how the table was created: `events_category_check` for the
 * generated schema, `events_category_check1` if a second one ever existed
 * alongside it, and something else entirely for a database restored from a dump
 * that renamed it. `DROP CONSTRAINT events_category_check` would then either
 * fail the boot or — with `IF EXISTS` — silently drop nothing and add a second
 * constraint beside the first, leaving the old five-value rule still enforced
 * and the migration recorded as applied.
 *
 * So it asks the catalogue instead. Matched on the COLUMN the constraint
 * references (`conkey` joined to `pg_attribute`) rather than on the text of
 * `pg_get_constraintdef` — searching the text would also match a constraint
 * that merely mentions the word for some other reason, and dropping that would
 * remove a rule nobody asked to remove. `array_length(conkey, 1) = 1` keeps it
 * to single-column checks, so a future composite constraint involving
 * `category` is left alone rather than silently discarded.
 *
 * ── Idempotent, like its SQLite twin ──
 *
 * The named constraint it adds is dropped first if present, so a re-run after a
 * partial failure converges rather than colliding. The runner records the
 * version inside the same transaction, so in practice a second run cannot
 * happen — this is belt and braces for a hand-run repair.
 *
 * ── Why no data check ──
 *
 * The vocabulary only grew, so every existing row already satisfies the new
 * constraint and `ADD CONSTRAINT` validates them all on the way in. If a row
 * somehow did not, PostgreSQL refuses the ALTER and the transaction rolls back —
 * which is the correct outcome and a louder one than any check written here.
 */
async function postgresUp(db) {
  const existing = await db.prepare(`
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'events'::regclass
       AND c.contype = 'c'
       AND array_length(c.conkey, 1) = 1
       AND a.attname = 'category'
  `).all();

  for (const { conname } of existing) {
    /* Identifier, not a value, so it cannot be bound as a parameter. It comes
       from the system catalogue rather than from input, and is quoted. */
    await db.exec(`ALTER TABLE events DROP CONSTRAINT "${conname}"`);
  }

  await db.exec(
    `ALTER TABLE events ADD CONSTRAINT events_category_check CHECK (category IN (${checkList()}))`
  );
}

export default {
  version: 57,
  name: 'widen_event_categories',
  ownTransaction: true,
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
