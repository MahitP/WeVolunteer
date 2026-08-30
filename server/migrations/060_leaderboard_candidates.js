/**
 * An index for the leaderboard's candidate set.
 *
 * ── What was slow ──
 *
 * `GET /api/leaderboard` selects opted-in students, aggregates their attendance,
 * sorts, and then takes 25. The audit of 2026-08-06 recorded it as finding P-2:
 * there is no index on `users(role, leaderboard_opt_in)`, so choosing the
 * candidates is a full scan of `users` — every row read and discarded to find
 * the few that opted in.
 *
 * That was correctly judged "fine at target scale, the first index to add if the
 * population reaches the thousands". It is added now because the scan is also
 * the reason the endpoint looked like a candidate for a Redis cache, and an
 * index is the cheaper answer to that question by a wide margin: no second
 * source of truth, no invalidation, no vendor, and it keeps working when
 * anything else is down.
 *
 * ── What this changes, and what it deliberately does not ──
 *
 * Both predicates are equalities, so the composite seeks straight to
 * (student, opted-in) and the scan disappears.
 *
 * It does NOT help the sort. The ORDER BY is on `SUM(hours_awarded)` and a
 * COUNT — values computed per group, which no index on `users` can carry — so
 * the aggregate and the sort happen either way. This narrows the input to them,
 * which at any realistic opt-in rate is most of the work.
 *
 * ── Column order ──
 *
 * `role` first even though `leaderboard_opt_in` is far more selective (it
 * defaults to 0, so almost nothing is in the opted-in set). For two equality
 * predicates the seek is equally direct either way, and a leading `role` leaves
 * a usable prefix for the other queries that filter on role alone. Selectivity
 * would decide it only if one of them were a range.
 *
 * ── Why not a partial index ──
 *
 * `ON users(role) WHERE leaderboard_opt_in = 1` would be smaller still, and
 * ordinary profile writes would never touch it. It was not chosen because it is
 * usable only while the query keeps saying exactly `leaderboard_opt_in = 1`: a
 * later edit to `<> 0`, or to a bound parameter, silently stops matching the
 * index predicate on both engines and the scan comes back with nothing to say
 * so. A plain composite is slightly larger and cannot fail that way.
 *
 * ── Write cost ──
 *
 * Two narrow columns on a table written a few times per user per day —
 * sign-in stamps, profile edits. `role` and `leaderboard_opt_in` change almost
 * never, so on PostgreSQL most of those updates stay HOT and do not touch this
 * index at all.
 *
 * ── Reversal ──
 *
 *     DROP INDEX idx_users_leaderboard;
 *
 * Nothing depends on it for correctness. The endpoint answers identically
 * without it, only by reading every user row to do it.
 */
function up(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_leaderboard
      ON users(role, leaderboard_opt_in)
  `);

  /* The planner needs statistics before it will prefer a new index over the
     scan it has been doing. Without this the index exists and goes unused,
     which is the worst of both — the write cost with none of the read benefit.
     Same reasoning as migration 036. */
  db.exec('ANALYZE');
}

/**
 * The same index on PostgreSQL.
 *
 * A fresh database already has it — `bin/generate-postgres-schema.mjs` derives
 * the baseline DDL from the SQLite schema, so the index appears there the
 * moment the migration above exists. This is for a database that was
 * provisioned BEFORE that regeneration, which is the case the migration
 * contract exists to cover: the generated schema describes a new database, and
 * only the migration reaches an old one.
 *
 * `IF NOT EXISTS` for the reason 059 gives — the clause exists, it is atomic,
 * and it makes re-running the migration the database's problem rather than a
 * read-then-write race in application code. So this is a no-op on any database
 * created from the current baseline, and the fix on any created before it.
 *
 * No `ANALYZE`. On SQLite it is required for the planner to use a new index at
 * all; PostgreSQL's autovacuum daemon keeps its own statistics and a manual
 * ANALYZE inside a migration transaction would block on a table that is
 * concurrently written, for a benefit the daemon supplies within a minute
 * anyway.
 */
async function postgresUp(db) {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_leaderboard
      ON users(role, leaderboard_opt_in);
  `);
}

export default {
  version: 60,
  name: 'leaderboard_candidates',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
