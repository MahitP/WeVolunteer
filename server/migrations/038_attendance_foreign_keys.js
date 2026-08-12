/**
 * Foreign keys for the two attendance tables that never declared any.
 *
 * ── What was actually missing ──
 *
 * `attendance` has declared foreign keys since it was created — event, slot and
 * user, all `ON DELETE CASCADE`. So do forty-three other tables. The two that
 * did not were `attendance_checkin` and `checkin_tokens`, the second because it
 * was written to match its neighbour and inherited the omission.
 *
 * ── The larger finding, which this migration does NOT act on ──
 *
 * None of those declarations have ever been enforced. `PRAGMA foreign_keys`
 * defaults to OFF in SQLite and `db.js` sets only `journal_mode` and
 * `busy_timeout`, so every `ON DELETE CASCADE` in this schema is currently
 * documentation. Turning enforcement on is a separate decision with a much
 * wider blast radius — it changes what every DELETE in the product does — and
 * it belongs in its own change, with its own pass over the delete paths.
 *
 * What can be said now, from evidence rather than hope: `PRAGMA
 * foreign_key_check` over the production database returns nothing. Every
 * declared relationship is already satisfied by the data, so enabling
 * enforcement would not orphan or reject anything that exists today. That is
 * the prerequisite, and it holds.
 *
 * ── Cascade policy, chosen rather than defaulted ──
 *
 * Both tables cascade on event, slot and user, matching `attendance`.
 *
 * That is deliberate for these two and would NOT be for a table of credited
 * hours. A check-in mark records that somebody was seen at a shift; a token is
 * a five-minute credential. Neither is a service record, neither appears on a
 * transcript, and both are meaningless once the shift they point at is gone. By
 * contrast the product protects real attendance at the application layer —
 * `PUT /api/events/:id` refuses to remove a slot that has attendance against
 * it, naming the volunteers who would lose credited hours.
 *
 * Users are tombstoned rather than hard-deleted (`account_status = 'deleted'`,
 * the row stays), so in practice the user cascade is a backstop for a path the
 * product does not take.
 *
 * ── Orphans ──
 *
 * Checked before the rebuild, and the migration REFUSES rather than dropping
 * anything. A row whose slot has vanished is a fact about a bug somewhere, and
 * a migration that silently deletes the evidence is worse than one that stops
 * and says so.
 *
 * ── Reversal ──
 *
 * Rebuild both tables without the FOREIGN KEY clauses. No data changes here, so
 * a reversal loses nothing.
 */

/** Rows pointing at something that no longer exists. */
function findOrphans(db, table, checks) {
  const found = [];
  for (const { column, parent } of checks) {
    const n = db.prepare(`
      SELECT COUNT(*) AS n FROM ${table} t
      WHERE t.${column} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = t.${column})
    `).get().n;
    if (n > 0) found.push(`${n} row(s) in ${table}.${column} with no matching ${parent}`);
  }
  return found;
}

/** Whether a table already declares a foreign key, so the rebuild is skipped. */
function hasForeignKeys(db, table) {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all().length > 0;
}

function up(db) {
  const orphans = [
    ...findOrphans(db, 'attendance_checkin', [
      { column: 'event_id', parent: 'events' },
      { column: 'slot_id', parent: 'slots' },
      { column: 'user_id', parent: 'users' },
    ]),
    ...findOrphans(db, 'checkin_tokens', [
      { column: 'event_id', parent: 'events' },
      { column: 'slot_id', parent: 'slots' },
      { column: 'user_id', parent: 'users' },
    ]),
  ];

  if (orphans.length > 0) {
    throw new Error(
      'Refusing to add foreign keys while orphaned rows exist:\n  '
      + orphans.join('\n  ')
      + '\n\nThese rows point at records that no longer exist. Adding the constraint '
      + 'would either fail or require deleting them, and deleting them would destroy '
      + 'the evidence of whatever created them. Investigate first.',
    );
  }

  /**
   * `attendance_checkin`.
   *
   * `method` is included because migration 037 added it by ALTER TABLE, so a
   * database migrated up has it and a rebuild must carry it through. The
   * DEFAULT is restated for the same reason.
   */
  if (!hasForeignKeys(db, 'attendance_checkin')) {
    db.exec(`
      CREATE TABLE attendance_checkin_new (
        event_id   TEXT NOT NULL,
        slot_id    TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        present    INTEGER CHECK(present IN (0,1)) NOT NULL,
        marked_by  TEXT,
        marked_at  TEXT NOT NULL,
        method     TEXT NOT NULL DEFAULT 'manual',
        PRIMARY KEY(slot_id, user_id),
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
        FOREIGN KEY(slot_id)  REFERENCES slots(id)  ON DELETE CASCADE,
        FOREIGN KEY(user_id)  REFERENCES users(id)  ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO attendance_checkin_new (event_id, slot_id, user_id, present, marked_by, marked_at, method)
      SELECT event_id, slot_id, user_id, present, marked_by, marked_at, method FROM attendance_checkin
    `);
    db.exec('DROP TABLE attendance_checkin');
    db.exec('ALTER TABLE attendance_checkin_new RENAME TO attendance_checkin');
    /* The index does not survive a DROP, so it is recreated by name. */
    db.exec('CREATE INDEX IF NOT EXISTS idx_checkin_event ON attendance_checkin(event_id)');
  }

  /**
   * `checkin_tokens`.
   *
   * `application_id` is deliberately NOT a foreign key. A token is resolved by
   * re-reading the application and re-checking it, so a dangling id already
   * resolves to a refusal — and cascading on it would delete a spent token's
   * record, which is the only durable trail of who scanned what.
   */
  if (!hasForeignKeys(db, 'checkin_tokens')) {
    db.exec(`
      CREATE TABLE checkin_tokens_new (
        id             TEXT PRIMARY KEY,
        token_hash     TEXT NOT NULL UNIQUE,
        application_id TEXT NOT NULL,
        event_id       TEXT NOT NULL,
        slot_id        TEXT NOT NULL,
        user_id        TEXT NOT NULL,
        status         TEXT NOT NULL CHECK(status IN ('pending', 'used', 'replaced')),
        created_at     TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        resolved_at    TEXT,
        resolved_by    TEXT,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
        FOREIGN KEY(slot_id)  REFERENCES slots(id)  ON DELETE CASCADE,
        FOREIGN KEY(user_id)  REFERENCES users(id)  ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO checkin_tokens_new
        (id, token_hash, application_id, event_id, slot_id, user_id, status, created_at, expires_at, resolved_at, resolved_by)
      SELECT id, token_hash, application_id, event_id, slot_id, user_id, status, created_at, expires_at, resolved_at, resolved_by
      FROM checkin_tokens
    `);
    db.exec('DROP TABLE checkin_tokens');
    db.exec('ALTER TABLE checkin_tokens_new RENAME TO checkin_tokens');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_tokens_live
        ON checkin_tokens(application_id) WHERE status = 'pending'
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_checkin_tokens_expiry ON checkin_tokens(expires_at)');
  }
}

export default {
  version: 38,
  name: 'attendance_foreign_keys',
  up,
  fileUrl: import.meta.url,
};
