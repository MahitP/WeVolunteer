/**
 * Hours Ledger — append-only history of every change to credited service hours.
 *
 * ── What this is, and what it is deliberately not ────────────────────────────
 *
 * `attendance` remains the single source of truth for a volunteer's hours.
 * Every existing total in the product is still derived the same way it always
 * was: SUM(hours_awarded) WHERE present = 1. Nothing in this module changes
 * that, and nothing here is read by any hours calculation.
 *
 * This table records *what changed, when, and who changed it* — the one
 * question the schema could not previously answer. When a parent asks why a
 * total dropped, `attendance` can only show the current state; the ledger can
 * show the history.
 *
 * Keeping the ledger alongside `attendance` rather than replacing it is the
 * whole reason existing volunteer records cannot be disturbed by this change:
 * the 24 queries that produce today's numbers are not touched, so they cannot
 * produce different numbers.
 *
 * ── Why there are no foreign keys ────────────────────────────────────────────
 *
 * Every other table here uses ON DELETE CASCADE, and foreign key enforcement is
 * on by default in node:sqlite. An audit log with a cascading foreign key
 * deletes itself at exactly the moment it becomes valuable — when the user or
 * event it describes is removed. Referential integrity is traded for
 * survivability. The denormalised name columns are what keep an orphaned row
 * readable.
 */
import { insertionTiebreak } from './db/dialectSql.js';

/** What kind of change a row represents. */
export const LEDGER_ACTIONS = ['credited', 'revoked', 'adjusted', 'migrated', 'voided'];

/** Which code path produced the change. */
export const LEDGER_SOURCES = [
  'attendance_screen',
  'event_edit',
  'event_delete',
  'migration',
  'admin_correction'
];

/** Hours are REAL; rounding at a fixed precision keeps sums comparable. */
const PRECISION = 4;
const round = (n) => Number(Number(n || 0).toFixed(PRECISION));

/**
 * Hours that actually count toward a total.
 *
 * `hours_awarded` is retained on rows where present = 0 — it means "what this
 * shift was worth", and `present` gates whether it is credited. So absence is a
 * zero-delta event, not a missing one.
 */
const credited = (present, hours) => (present === 1 ? round(hours) : 0);

export function createHoursLedgerTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hours_ledger (
      id              TEXT PRIMARY KEY,

      user_id         TEXT NOT NULL,
      event_id        TEXT NOT NULL,
      slot_id         TEXT NOT NULL,

      -- Snapshots, so the row survives deletion of what it describes
      user_name       TEXT,
      event_title     TEXT,
      slot_name       TEXT,

      action          TEXT NOT NULL CHECK(action IN ('credited','revoked','adjusted','migrated','voided')),
      present_before  INTEGER CHECK(present_before IN (0,1)),
      present_after   INTEGER CHECK(present_after IN (0,1)),
      hours_before    REAL,
      hours_after     REAL,
      delta           REAL NOT NULL,

      actor_id        TEXT,
      actor_role      TEXT CHECK(actor_role IN ('organizer','admin','system')),
      source          TEXT NOT NULL CHECK(source IN ('attendance_screen','event_edit','event_delete','migration','admin_correction')),
      reason          TEXT,

      created_at      TEXT NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_user ON hours_ledger(user_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_event ON hours_ledger(event_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_slot ON hours_ledger(slot_id, user_id)');
}

/**
 * Appends one entry. The only supported write — rows are never updated or
 * deleted.
 *
 * `delta` is always computed here rather than accepted from the caller, so the
 * invariant `SUM(delta) per user == credited hours per user` cannot be broken
 * by a call site doing its own arithmetic.
 *
 * NOTE: not yet wired into any endpoint. It is the interface the attendance
 * rewrite will consume, and exists now so the invariant can be tested before
 * anything depends on it.
 */
export async function recordHoursChange(db, entry) {
  const {
    id,
    userId, eventId, slotId,
    userName = null, eventTitle = null, slotName = null,
    action,
    presentBefore = null, presentAfter = null,
    hoursBefore = null, hoursAfter = null,
    actorId = null, actorRole = null,
    source, reason = null,
    createdAt
  } = entry;

  if (!LEDGER_ACTIONS.includes(action)) {
    throw new Error(`Unknown ledger action: ${action}`);
  }
  if (!LEDGER_SOURCES.includes(source)) {
    throw new Error(`Unknown ledger source: ${source}`);
  }
  if (!userId || !eventId || !slotId) {
    throw new Error('Ledger entry requires userId, eventId and slotId');
  }

  const delta = round(
    credited(presentAfter, hoursAfter) - credited(presentBefore, hoursBefore)
  );

  const rowId = id || `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  await db.prepare(`
    INSERT INTO hours_ledger (
      id, user_id, event_id, slot_id,
      user_name, event_title, slot_name,
      action, present_before, present_after, hours_before, hours_after, delta,
      actor_id, actor_role, source, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `).run(
    rowId, userId, eventId, slotId,
    userName, eventTitle, slotName,
    action,
    presentBefore === null ? null : (presentBefore ? 1 : 0),
    presentAfter === null ? null : (presentAfter ? 1 : 0),
    hoursBefore === null ? null : round(hoursBefore),
    hoursAfter === null ? null : round(hoursAfter),
    delta,
    actorId, actorRole, source, reason,
    createdAt || new Date().toISOString()
  );

  return { id: rowId, delta };
}

/**
 * Writes one `migrated` entry per existing attendance row.
 *
 * Idempotent by construction: the id is derived from the attendance primary key
 * (`migrate:<slot_id>:<user_id>`), so re-running inserts nothing.
 *
 * This deliberately does not invent history. Real prior state is unknowable —
 * the old schema recorded no timestamps and no actors — so before-values are
 * NULL and created_at is the migration time, not a guessed event date. A ledger
 * that fabricates plausible-looking history would be worse than one that
 * honestly starts here, because the entire value of the table is that it can be
 * trusted.
 *
 * Never writes to `attendance`.
 */
export async function backfillHoursLedger(db, { now = new Date().toISOString() } = {}) {
  const rows = await db.prepare(`
    SELECT a.event_id, a.slot_id, a.user_id, a.present, a.hours_awarded,
           u.name AS user_name, e.title AS event_title, s.name AS slot_name
    FROM attendance a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN events e ON e.id = a.event_id
    LEFT JOIN slots s ON s.id = a.slot_id
  `).all();

  /**
   * Every (slot, user) the ledger ALREADY knows about, from any source.
   *
   * ── The bug this replaces ──
   *
   * This was `SELECT id FROM hours_ledger WHERE source = 'migration'`, which
   * made the backfill idempotent against its own rows and blind to everybody
   * else's. A slot credited through the attendance screen wrote a real entry;
   * this function then ran on the next boot, found no `migrate:<slot>:<user>`
   * id, and wrote a second entry for the same credited hours.
   *
   * `INSERT OR IGNORE` did not help — the two rows have different primary keys,
   * which is precisely why they both survived.
   *
   * Found on the pilot database: one student with fourteen attendance rows and
   * twenty-eight ledger rows, a ledger total of 419.44 against 209.72 credited.
   * Exactly double, which is what a duplicate of every row looks like.
   *
   * Credited hours were never affected — `attendance` is the source of truth and
   * nothing reads the ledger to compute them — but `verifyLedgerParity` reported
   * the mismatch on every boot and the admin dashboard showed it, which is
   * exactly what it is for.
   *
   * ── Why the key is the attendance row, not the id ──
   *
   * The question this needs to answer is "has this credit already been
   * recorded", and the answer belongs to the (slot, user) pair — that is the
   * primary key of `attendance`. Any id-based test is a test of who wrote the
   * row rather than of whether the fact is already there.
   *
   * One query rather than one per attendance row: this runs on every boot, so
   * an N+1 would be tens of thousands of round-trips at startup once the
   * platform has a year of records.
   */
  const alreadyRecorded = new Set(
    (await db.prepare('SELECT slot_id, user_id FROM hours_ledger').all())
      .map(r => `${r.slot_id}:${r.user_id}`)
  );

  let inserted = 0;
  let skipped = 0;

  for (const r of rows) {
    const id = `migrate:${r.slot_id}:${r.user_id}`;
    if (alreadyRecorded.has(`${r.slot_id}:${r.user_id}`)) { skipped++; continue; }

    await recordHoursChange(db, {
      id,
      userId: r.user_id,
      eventId: r.event_id,
      slotId: r.slot_id,
      userName: r.user_name,
      eventTitle: r.event_title,
      slotName: r.slot_name,
      action: 'migrated',
      presentBefore: null,
      hoursBefore: null,
      presentAfter: r.present,
      hoursAfter: r.hours_awarded,
      actorId: null,
      actorRole: 'system',
      source: 'migration',
      reason: 'Backfilled from attendance when the hours ledger was introduced. '
            + 'Prior history was not recorded by the old schema and is not reconstructable.',
      createdAt: now
    });
    inserted++;
  }

  return { inserted, skipped, total: rows.length };
}

/**
 * Checks that the ledger agrees with the source of truth, per user.
 *
 * While the ledger is additive this is an early-warning signal rather than a
 * correctness dependency — but it is the gate that proves the backfill did not
 * disturb anything, and it is what a migration should refuse to proceed past.
 *
 * SQLite lacks FULL OUTER JOIN before 3.39, so the join is done here.
 */
export async function verifyLedgerParity(db) {
  const ledger = new Map();
  for (const r of await db.prepare(
    'SELECT user_id, SUM(delta) AS total FROM hours_ledger GROUP BY user_id'
  ).all()) {
    ledger.set(r.user_id, round(r.total));
  }

  const attendance = new Map();
  for (const r of await db.prepare(
    'SELECT user_id, SUM(hours_awarded) AS total FROM attendance WHERE present = 1 GROUP BY user_id'
  ).all()) {
    attendance.set(r.user_id, round(r.total));
  }

  const mismatches = [];
  for (const userId of new Set([...ledger.keys(), ...attendance.keys()])) {
    const ledgerTotal = ledger.get(userId) || 0;
    const attendanceTotal = attendance.get(userId) || 0;
    if (ledgerTotal !== attendanceTotal) {
      mismatches.push({ userId, ledgerTotal, attendanceTotal });
    }
  }

  return { ok: mismatches.length === 0, mismatches, usersChecked: ledger.size };
}

/**
 * Every hours change recorded for one volunteer, newest first.
 *
 * Ties on `created_at` are broken by `rowid` on SQLite, which assigns it in
 * insertion order. Several rows share a timestamp whenever one save changes more
 * than one record, and the id's random suffix would otherwise order them
 * arbitrarily — an audit log has to read back in the order things happened.
 *
 * ── The difference on PostgreSQL, and why it is acceptable here ──
 *
 * PostgreSQL has no `rowid`, and `ctid` is not a substitute: it is a physical
 * location that moves when a row is updated. `insertionTiebreak()` gives the
 * primary key there, which is deterministic — the same query returns the same
 * order every time — but for rows sharing a timestamp it orders
 * *lexicographically by id*, not by insertion.
 *
 * That difference is real and is deliberately not hidden. It is acceptable in
 * this function today for a reason that was checked rather than assumed: no
 * route calls `getLedgerForUser`, and nothing reads the `seq` column it selects.
 * The two tests that cover it use distinct `created_at` values, so the tiebreak
 * is never exercised. There is currently no behaviour that can observe the
 * difference.
 *
 * If this is ever wired to a screen, that stops being true, and the fix is a
 * monotonic column on `hours_ledger` plus a backfill for existing rows — a
 * schema change and a cutover decision, not something to slip into a dialect
 * helper. `moderation_actions` has the identical construct and the identical
 * caveat. Both are recorded as open items in POSTGRES_MIGRATION_STATUS.md.
 */
export async function getLedgerForUser(db, userId) {
  const seq = insertionTiebreak(db);
  return await db.prepare(
    `SELECT ${seq} AS seq, * FROM hours_ledger WHERE user_id = ? ORDER BY created_at DESC, ${seq} DESC`
  ).all(userId);
}

/**
 * Whether the append-only ledger still agrees with `attendance`, as a count.
 *
 * `attendance` is the source of truth for credited hours and the ledger is the
 * history; a divergence means one of them is wrong about a student's service
 * record. Boot logs a mismatch and carries on by design (taking the platform
 * down over a reporting discrepancy would be worse), and `verifyHours.js` can
 * be run by hand — but neither of those puts the answer in front of the person
 * who would be asked to defend the numbers.
 *
 * ── Why this exists beside `verifyLedgerParity` ──
 *
 * They answer different questions at different costs. `verifyLedgerParity`
 * returns the mismatched users themselves, which means loading every user's two
 * totals into memory — right for the CLI, which is going to print them. This
 * counts, in one query, so a status panel refreshed every minute stays flat as
 * the ledger grows and never holds the roster in memory.
 *
 * Lived in `adminRoutes.js` until the Owner Center became its second reader.
 * Moved here rather than copied: two spellings of "do the numbers agree" is two
 * answers to it, and this is the file the question is about.
 *
 * Fails soft. A status panel that goes down during an incident is worse than
 * one that admits partial ignorance, so a broken check reports `null` rather
 * than throwing into the handler.
 */
export async function hoursLedgerStatus(db) {
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS mismatches FROM (
        SELECT a.user_id
        FROM attendance a
        WHERE a.present = 1
        GROUP BY a.user_id
        HAVING COALESCE(SUM(a.hours_awarded), 0) <> COALESCE((
          SELECT SUM(l.delta) FROM hours_ledger l WHERE l.user_id = a.user_id
        ), 0)
      )
    `).get();

    return { inParity: row.mismatches === 0, mismatchedUsers: row.mismatches };
  } catch (err) {
    console.error('[hours] Could not check hours ledger parity:', err);
    return { inParity: null, mismatchedUsers: null, error: true };
  }
}
