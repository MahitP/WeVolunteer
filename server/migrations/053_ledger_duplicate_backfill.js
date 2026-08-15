/**
 * Removes the duplicate ledger rows the backfill wrote before it was fixed.
 *
 * ── What went wrong ──
 *
 * `backfillHoursLedger` skipped an attendance row only if a ledger entry with
 * the id `migrate:<slot>:<user>` already existed — so it was idempotent against
 * its OWN rows and blind to everybody else's. A slot credited through the
 * attendance screen wrote a real entry; the next boot found no matching
 * `migrate:` id and wrote a second entry for the same credited hours.
 *
 * Found on the pilot database: one student with fourteen attendance rows and
 * twenty-eight ledger rows — a ledger total of 419.44 against 209.72 actually
 * credited. Exactly double, which is what a duplicate of every row looks like.
 *
 * Credited hours were never wrong. `attendance` is the source of truth and
 * nothing reads the ledger to compute them, which is why this surfaced as a
 * parity warning at boot and on the admin dashboard rather than as a student
 * seeing the wrong number. That warning is the whole reason the parity check
 * exists, and it worked.
 *
 * ── Why deleting is right here, in a table that is otherwise append-only ──
 *
 * `hours_ledger` is deliberately append-only: rows are never updated or deleted,
 * because the value of an audit trail is that it cannot be rewritten. This is
 * not a rewrite of history. These rows record a credit that happened once and
 * was written down twice; the second copy is an artifact of a defect in the
 * writer, not a fact about a student. Leaving them would mean the ledger
 * permanently disagreed with the hours it exists to explain, which is a worse
 * outcome for exactly the reason the table is append-only.
 *
 * ── Which copy survives ──
 *
 * The `migration`-sourced one is deleted and the real one kept, whenever both
 * exist for the same (slot, user). The real row carries actual before/after
 * state and an actor; the migrated row carries NULLs and a reason that says
 * prior history "is not reconstructable". Keeping the richer record is the
 * obvious choice, and it also means a (slot, user) that only ever had a
 * migrated row — the ordinary case for genuinely historical attendance — is
 * untouched.
 *
 * ── Safety ──
 *
 * Scoped to rows that are duplicates by (slot_id, user_id) AND sourced from the
 * migration AND accompanied by a surviving non-migration row for the same pair.
 * A database with no duplicates loses nothing.
 */
export function up(db) {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='hours_ledger'"
  ).get();
  /* The ledger is created by `initHoursLedger` in db.js rather than by a
     migration, and that runs BEFORE the migration runner — but a database that
     somehow reaches here without it should skip rather than throw. */
  if (!table) return;

  const before = db.prepare('SELECT COUNT(*) AS n FROM hours_ledger').get().n;

  db.exec(`
    DELETE FROM hours_ledger
     WHERE source = 'migration'
       AND EXISTS (
         SELECT 1 FROM hours_ledger other
          WHERE other.slot_id = hours_ledger.slot_id
            AND other.user_id = hours_ledger.user_id
            AND other.source <> 'migration'
       )
  `);

  const removed = before - db.prepare('SELECT COUNT(*) AS n FROM hours_ledger').get().n;
  if (removed > 0) {
    console.log(
      `[Hours ledger] Removed ${removed} duplicate backfill entr${removed === 1 ? 'y' : 'ies'}. `
      + 'Credited hours were never affected — attendance is the source of truth.'
    );
  }
}

export default {
  version: 53,
  name: 'ledger_duplicate_backfill',
  up,
  fileUrl: import.meta.url,
};
