/**
 * The handful of SQL expressions the two engines genuinely spell differently.
 *
 * ── Why this module is small, and meant to stay small ──
 *
 * Most of the SQLite-only SQL in this codebase does not belong here, because
 * most of it has a form both engines accept and the right fix is to write that
 * form once:
 *
 *   `INSERT OR IGNORE`            → `ON CONFLICT (cols) DO NOTHING`, since 3.24
 *   `strftime('%Y-%m', iso_col)`  → `substr(iso_col, 1, 7)`
 *   `datetime('now')`             → a JS timestamp, bound as a parameter
 *
 * Every one of those is portable *and better*: `DO NOTHING` ignores only the
 * collision it names instead of swallowing NOT NULL and foreign-key violations
 * too, and a bound timestamp cannot disagree with the ISO-8601 the application
 * writes everywhere else. A dialect branch would have preserved the worse form
 * on both engines.
 *
 * What is left here is the residue: expressions with no common spelling at all.
 * Each one is a place the two engines can drift, so each is exercised against
 * both in `db.dialectSql.test.js` rather than trusted.
 *
 * The dialect comes from the handle — `db.dialect` is `'postgres'` on the
 * PostgreSQL adapter and `undefined` on `DatabaseSync`, so an absent value
 * reads as SQLite. `services/autoSelect.js` already uses it the same way for
 * `FOR UPDATE`.
 */

export const POSTGRES_DIALECT = 'postgres';

/** `true` when the handle speaks PostgreSQL. An unknown handle reads as SQLite. */
export const isPostgres = (db) => db?.dialect === POSTGRES_DIALECT;

/**
 * The number of hours between two ISO-8601 timestamp columns.
 *
 * SQLite has `julianday()`, which returns a fractional day count; multiplying by
 * 24 gives hours. PostgreSQL has neither that function nor implicit text→time
 * conversion, so the columns are cast and the interval extracted.
 *
 * ── The rounding is part of the contract, not a detail ──
 *
 * `julianday` arithmetic on a two-and-a-half hour shift returns
 * 2.4999999962747097 — a double's answer to a subtraction of two large numbers.
 * The existing SQL rounds to two places for exactly that reason, and the
 * PostgreSQL form must round identically or a shift that credits 2.5 hours on
 * one engine credits 2.5000000 on the other and the ledger's parity check, which
 * compares stored totals against recomputed ones, fails on every row.
 *
 * `EXTRACT(EPOCH …)` is exact rather than floating-point, so the rounding is
 * redundant there — and applied anyway, because two expressions that agree by
 * accident are not the same as two that agree by construction.
 */
export function hoursBetween(db, startColumn, endColumn) {
  if (isPostgres(db)) {
    return `ROUND((EXTRACT(EPOCH FROM (${endColumn}::timestamptz - ${startColumn}::timestamptz)) / 3600)::numeric, 2)`;
  }
  return `ROUND((julianday(${endColumn}) - julianday(${startColumn})) * 24, 2)`;
}

/**
 * `GREATEST`, which SQLite spells `max` and PostgreSQL spells `GREATEST`.
 *
 * SQLite overloads `max`: with one argument it is the aggregate, with two or
 * more it is the scalar. PostgreSQL keeps them apart, and passing two arguments
 * to its aggregate `max` is an error rather than the scalar. Nothing about this
 * is guessable from reading the SQLite version, which is why it is named here.
 */
export function greatest(db, ...values) {
  return `${isPostgres(db) ? 'GREATEST' : 'max'}(${values.join(', ')})`;
}

/**
 * `LEAST`, which SQLite spells `min` — the same overload hazard as `greatest`.
 *
 * The call sites are both halves of the browse haversine, which clamps the
 * cosine with `min(1.0, …)` before `acos`: floating-point error can push it a
 * hair above 1 for two nearly identical points, and `acos` of that is NaN.
 *
 * PostgreSQL reads the two-argument form as its *aggregate* `min` and refuses
 * with "function min(numeric, double precision) does not exist", so the
 * distance filter and the nearest-first sort both answered 500 there while
 * every other browse filter worked.
 */
export function least(db, ...values) {
  return `${isPostgres(db) ? 'LEAST' : 'min'}(${values.join(', ')})`;
}

/**
 * The `YYYY-MM` month of an ISO-8601 timestamp column.
 *
 * Both engines take `substr`, so this needs no branch — it exists so that call
 * sites stop reaching for `strftime`, and so the reasoning has somewhere to
 * live: the columns hold `2026-08-16T17:53:04.120Z`, always UTC and always
 * zero-padded, so the first seven characters ARE the month. `strftime` would
 * additionally parse and re-render, which costs time and, on a value it cannot
 * parse, silently returns NULL where this returns the wrong seven characters —
 * a difference that matters only if the column stops being ISO-8601, which the
 * schema and `auditLog.js` both forbid.
 */
export function monthOf(column) {
  return `substr(${column}, 1, 7)`;
}

/**
 * Whether a table exists — asked of the engine's own catalogue.
 *
 * SQLite keeps its schema in `sqlite_master`; PostgreSQL has no such relation
 * and answers from `information_schema.tables`. Four call sites ask this
 * question (`legalStore` three times, `verifyHours` once), each guarding a
 * feature against a database that predates the migration which created its
 * table, so all four would have failed at the query rather than answering
 * "no".
 *
 * `to_regclass(name) IS NOT NULL` would be the shorter PostgreSQL spelling and
 * is deliberately not used: it resolves through the search_path and returns a
 * row for a table in ANY visible schema, so a leftover `public.legal_documents`
 * would make a namespaced deployment believe it had one. The
 * `information_schema` form is scoped to the current schema.
 */
export async function tableExists(db, name) {
  const sql = isPostgres(db)
    ? `SELECT 1 AS present FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ?`
    : "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?";
  return Boolean(await db.prepare(sql).get(name));
}

/**
 * A probe that fails on a database that can be read but not written.
 *
 * The SQLite version reads `PRAGMA user_version` and writes it back unchanged:
 * a genuine page write, so it fails on a full disk and on a read-only remount,
 * while leaving no logical trace — no scratch table, no row, no value anything
 * else reads.
 *
 * PostgreSQL has no pragmas, and the plausible substitutes do not work.
 * `txid_current()` was the first attempt — it allocates a transaction id, which
 * sounds like a write — and PostgreSQL 17 happily returns one **inside a
 * `SET TRANSACTION READ ONLY` block**, so the probe passed on a database that
 * could not be written. `db.dialectSql.test.js` caught it; the reasoning is
 * recorded here because it is the same wrong turn the next person would take.
 *
 * `CREATE TEMP TABLE IF NOT EXISTS` is a real write and behaves correctly:
 * refused in a read-only transaction, refused on a hot standby, and it needs
 * actual disk. It leaves no logical trace either — a temp table is visible only
 * to its own session and vanishes when the pooled connection closes, so at worst
 * one exists per connection in the pool.
 *
 * `SELECT 1` would satisfy none of this, and that is the exact mistake the
 * SQLite probe was written to correct: a read-only database reporting healthy
 * while every mutation in the app returned 500.
 */
export async function probeWritable(db) {
  if (isPostgres(db)) {
    await db.exec('CREATE TEMP TABLE IF NOT EXISTS wev_write_probe (x integer)');
    return true;
  }
  const current = await db.prepare('PRAGMA user_version').get();
  const value = Number(current?.user_version ?? 0);
  // Interpolated rather than bound: PRAGMA does not accept bind parameters. The
  // value comes from SQLite itself and is coerced through Number(), so it cannot
  // carry anything but a number.
  await db.exec(`PRAGMA user_version = ${value}`);
  return true;
}

/**
 * An `EXISTS` over the elements of a JSON-array text column.
 *
 * `organizations.tags` holds a JSON array as TEXT — `["robotics","stem"]` — and
 * the directory's tag search has to match one element exactly rather than
 * substring-matching the whole blob, which would find "stem" inside "system".
 *
 * SQLite walks it with the `json_each` table-valued function, whose rows expose
 * `.value`. PostgreSQL has no `json_each` returning that shape; the equivalent
 * is `jsonb_array_elements_text`, and the column has to be cast because it is
 * declared TEXT on both engines.
 *
 * The cast is the part that needs care. `o.tags::jsonb` throws on a row whose
 * text is not valid JSON, and a thrown error inside a `WHERE` clause fails the
 * whole search rather than skipping the row — so the caller must have already
 * excluded NULLs, and this is documented as requiring it. The application
 * writes this column only through `JSON.stringify`, so malformed content means
 * something else has been writing to it, and failing loudly is right.
 *
 * @param {object} db      the handle, for its dialect
 * @param {string} column  the JSON-array column, already known non-NULL
 * @param {string} param   the placeholder the element is compared against
 */
export function jsonArrayContains(db, column, param) {
  if (isPostgres(db)) {
    return `EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${column}::jsonb) AS element(value)
      WHERE lower(trim(element.value)) = ${param}
    )`;
  }
  return `EXISTS (
    SELECT 1 FROM json_each(${column})
    WHERE lower(trim(json_each.value)) = ${param}
  )`;
}

/**
 * Null-safe equality: true when both sides are NULL, false when only one is.
 *
 * SQLite spells this `a IS ?` — its `IS` operator is exactly this, and it
 * accepts a bound parameter on the right. PostgreSQL's `IS` takes only the
 * keywords `NULL`, `NOT NULL`, `TRUE`, `FALSE` and `UNKNOWN`, so `a IS $1` is a
 * syntax error; the standard spelling is `IS NOT DISTINCT FROM`, which SQLite
 * in turn does not have.
 *
 * There is no common form, so this is one of the few genuine branches.
 *
 * The two call sites are the duplicate-appeal check, which asks "is there
 * already an open appeal about this same thing" — and `subject_ref` is NULL for
 * an appeal about the account itself. Plain `=` would answer false for those,
 * so every account-level appeal would be treated as new and a suspended user
 * could file without limit.
 */
export function nullSafeEquals(db, column, param) {
  return isPostgres(db)
    ? `${column} IS NOT DISTINCT FROM ${param}`
    : `${column} IS ${param}`;
}

/**
 * The negation: "different from this value, and NULL counts as different".
 *
 * The call sites are the two leaderboard predicates, which ask that a student's
 * `hours_visibility` is not `'private'`. The column is nullable on older rows,
 * and the intent — recorded at the call site — is that a NULL reads as public
 * and therefore stays on the board.
 *
 * `<> 'private'` would NOT do that: NULL compared with `<>` is NULL, which is
 * not true, so every older row would silently drop off the leaderboard. SQLite's
 * `IS NOT 'private'` gets it right and PostgreSQL rejects the form outright, so
 * this answered 500 there rather than answering wrongly.
 */
/**
 * Did this error come from a UNIQUE constraint?
 *
 * The engines report it completely differently, and the difference is not
 * cosmetic — this is how "insert, and if it collides read the existing row"
 * gets written, so a failed match turns a handled duplicate into a 500.
 *
 *   SQLite      Error: UNIQUE constraint failed: reports.reporter_id, …
 *   PostgreSQL  error: duplicate key value violates unique constraint "…"
 *               with err.code === '23505'
 *
 * PostgreSQL's SQLSTATE is checked first because it is a stable code rather
 * than prose; SQLite has no equivalent on the error object, so its message is
 * the only signal available there.
 *
 * The one call site is the report-duplicate path, where matching only SQLite's
 * wording meant a second report of the same thing answered 500 on PostgreSQL
 * instead of returning the original id — and the comment at that site is
 * explicit that showing a distressed student an error after they worked up to
 * pressing the button is the outcome it exists to prevent.
 */
/**
 * A row lock, so a read-then-write on that row cannot interleave.
 *
 * The shape this exists for is capacity: read `COUNT(*) … WHERE status =
 * 'accepted'`, compare it to `max_spots`, then write. Two requests that read
 * before either writes both believe there is room, and the slot ends up
 * oversubscribed. Measured, not theorised — before this existed, five
 * simultaneous accepts put five volunteers into a two-spot shift.
 *
 * On PostgreSQL, `SELECT … FOR UPDATE` on the SLOT row serialises every accept
 * for that slot: the second transaction blocks until the first commits and then
 * re-reads the count it actually has to respect. The lock is taken on the slot
 * rather than on the applications, because the rows being counted are not the
 * rows being locked — a new application can be inserted between the two, and a
 * lock on "the rows I read" would not cover it.
 *
 * On SQLite this is an empty string, deliberately. Its writes are serialised
 * process-wide by the write queue, so the interleaving cannot occur; and
 * `FOR UPDATE` is not syntax it accepts. That asymmetry is the whole reason
 * this bug was invisible until the application ran on a connection pool.
 */
/**
 * A case-insensitive LIKE.
 *
 * SQLite's `LIKE` ignores case for ASCII by default. PostgreSQL's does not, and
 * the difference is silent: the directory search simply stopped matching
 * `@Ana` against the handle `ana` — no error, just an empty result, which reads
 * as "no such person".
 *
 * `ILIKE` is the PostgreSQL answer rather than `COLLATE nocase`, because
 * PostgreSQL refuses a nondeterministic collation inside `LIKE` outright —
 * noted in this file's own COLLATE reasoning, and the reason that route cannot
 * simply reuse the shared collation here.
 */
export function caseInsensitiveLike(db) {
  return isPostgres(db) ? 'ILIKE' : 'LIKE';
}

export function forUpdate(db) {
  return isPostgres(db) ? ' FOR UPDATE' : '';
}

export function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;                       // PostgreSQL
  return /UNIQUE constraint failed/i.test(String(err.message ?? ''));  // SQLite
}

export function nullSafeNotEquals(db, column, param) {
  return isPostgres(db)
    ? `${column} IS DISTINCT FROM ${param}`
    : `${column} IS NOT ${param}`;
}

/**
 * A deterministic tie-break for rows sharing a timestamp.
 *
 * `moderation_actions` and `hours_ledger` both order a history by `created_at`
 * and break ties on `rowid`, because one transaction writes several rows with
 * an identical timestamp — a PATCH that changes status, priority and assignment
 * shares one `created_at` — and without a tiebreak the order is whatever the
 * planner chose, which for a history is not a detail.
 *
 * PostgreSQL has no `rowid`. `ctid` is not a substitute: it is a physical
 * location that changes when a row is updated, so ordering by it is stable only
 * until something touches the table.
 *
 * ── What each engine gets, and the difference that remains ──
 *
 * SQLite keeps `rowid`, unchanged. It is the authoritative engine today and
 * this must not alter its behaviour: `rowid` is assigned in insertion order, so
 * the history reads in the order things happened.
 *
 * PostgreSQL gets the primary key. That is deterministic — the same query
 * returns the same order every time, which is what stops the timeline
 * reshuffling between requests — but for rows sharing a timestamp it is
 * *lexicographic by id*, not insertion order. Those ids are UUID-based, so the
 * two can differ.
 *
 * This is deliberately not solved here. Making PostgreSQL insertion-ordered
 * needs a monotonic column on both tables, which is a schema change and a data
 * migration for existing rows — an owner-level decision to take at cutover, not
 * a translation to slip into a dialect helper. It is recorded in
 * POSTGRES_MIGRATION_STATUS.md as an open item.
 */
export function insertionTiebreak(db, alias) {
  const prefix = alias ? `${alias}.` : '';
  return isPostgres(db) ? `${prefix}id` : `${prefix}rowid`;
}

/**
 * "Does this text contain that text", as a position test.
 *
 * The one call site is the browse search box (`eventQuery.buildEventWhere`),
 * which matches the typed string against an event's title, description and
 * location and against the organizer's name.
 *
 * ── Why a position test and not LIKE ──
 *
 * `LIKE` gives `%` and `_` meaning, so a user typing `100%` or `a_b` would be
 * running a pattern rather than searching for their own characters. Escaping
 * that correctly on both engines is more moving parts than asking for a
 * position, and the position form has no metacharacters at all.
 *
 * ── The translation ──
 *
 * SQLite spells it `instr(haystack, needle)` and PostgreSQL spells it
 * `strpos(haystack, needle)`. The argument order and the result agree exactly:
 * a 1-based index, or 0 when the needle is absent, so `> 0` means "contains" on
 * both. PostgreSQL has no `instr` at all, which is not a silent difference —
 * the browse endpoint answered 500 on every search until this branch existed,
 * and answered correctly the moment a filter other than `q` was used, so it
 * only showed up when someone actually typed in the box.
 */
export function substringPosition(db, haystack, needle) {
  return `${isPostgres(db) ? 'strpos' : 'instr'}(${haystack}, ${needle}) > 0`;
}
