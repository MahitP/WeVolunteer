/**
 * Error monitoring storage: one row per problem, bounded evidence for each.
 *
 * ── Additive, so §8.3's guards do not apply ──
 *
 * `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, nothing else.
 * No table is rebuilt, no column is dropped, no constraint on an existing table
 * changes. ENGINEERING_GUIDE §8.3's six destructive-rebuild guards — backup
 * first, pragma-took-effect assertion, explicit column list, unknown-column
 * guard, schema-derived child-row count, `foreign_key_check` before commit —
 * exist for the one sanctioned rebuild (001) and are **not** applicable here.
 * Said out loud so the next reader does not go looking for them and conclude
 * they were forgotten.
 *
 * `ownTransaction` is deliberately unset: the registry wraps this in
 * BEGIN/COMMIT, which is correct for additive DDL. Only a rebuild needs to
 * manage its own transaction, because `PRAGMA foreign_keys` is a silent no-op
 * inside an open one.
 *
 * ── Rollback: there is none, and that is the posture ──
 *
 * The registry is forward-only — no migration exports a `down()` and
 * `runMigrations` only ever moves forward. For additive DDL that is right, and
 * recovery is manual:
 *
 *     DROP TABLE error_events;   -- children first
 *     DROP TABLE error_groups;
 *     DELETE FROM schema_migrations WHERE version = 4;
 *
 * Do NOT delete that row while the tables still exist. Re-running `up` against
 * a database it has already changed is the failure ENGINEERING_GUIDE §8.5
 * exists to prevent; it lists three distinct causes with three different fixes.
 *
 * ── Two tables, not one ──
 *
 * A single `errors` table forces every dashboard read to either `GROUP BY` or
 * show a wall of duplicates. `error_groups` holds the identity of a problem;
 * `error_events` holds bounded evidence for it. That split is what makes
 * retention possible without losing the fact that something happened 4,000
 * times: the counter survives, the evidence expires.
 */
function up(db) {
  /**
   * ── Why there is no column here that wants a real URL, a request body, an IP
   * or a raw user id ──
   *
   * Every field is written from hostile input in the client-report case, so the
   * schema's contribution to privacy is offering nowhere for personal data to
   * land. A body column would be filled; an `ip` column would be filled; a
   * `user_id` column would make this table a second index of who did what,
   * retained on a different schedule from everything else. They are absent by
   * construction rather than by policy, which is the difference between a rule
   * and a habit.
   *
   * `message` is REDACTED and normalised before it arrives, `route` is an
   * Express pattern (server) or a matched client pattern (client) and never a
   * URL — a URL carries a query string, and query strings carry search terms,
   * addresses and email addresses.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS error_groups (
      fingerprint   TEXT PRIMARY KEY,
      source        TEXT NOT NULL CHECK(source IN ('server','client','worker')),
      kind          TEXT NOT NULL,
      message       TEXT NOT NULL,
      route         TEXT,
      status        TEXT NOT NULL DEFAULT 'open'
                      CHECK(status IN ('open','resolved','ignored')),
      occurrences   INTEGER NOT NULL DEFAULT 0,
      users_seen    INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL,
      resolved_at   TEXT,
      resolved_by   TEXT,
      release       TEXT
    )
  `);

  // Triage: open groups, newest first — the dashboard's only default query, and
  // the 30/180-day retention sweeps, which both filter on status.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_error_groups_triage
      ON error_groups(status, last_seen_at DESC)
  `);

  /**
   * The ceiling query's index, and the reason it is not optional.
   *
   * `POST /api/errors/report` is unauthenticated by design, so the number of
   * DISTINCT client fingerprints is attacker-chosen: the fingerprint is computed
   * over a client-supplied message, and distinct messages are one line of
   * script. The plan bounds that with a ceiling of 500 open `source='client'`
   * groups, which means `COUNT(*) WHERE source = ? AND status = ?` runs on every
   * client report that opens a new group.
   *
   * `idx_error_groups_triage` above cannot serve it — `source` is not its
   * leading column — so without this the ceiling check scans the table it is
   * meant to be bounding, on an unauthenticated path, once per attack request.
   * That turns the defence into the amplifier.
   *
   * Same reasoning as `idx_error_events_occurred` below: the plan requires the
   * numbers to be enforced in SQL, and an enforcement that degrades to a full
   * scan under exactly the load it exists for is not enforcement.
   */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_error_groups_source
      ON error_groups(source, status)
  `);

  /**
   * ── `user_hash`, and why it carries no foreign key ──
   *
   * The questions a dashboard actually asks are "how many distinct people hit
   * this" and "is this just one person's odd data". A hash answers both. Storing
   * the id would answer a third question nobody asked, and would make this table
   * a second record of who did what, expiring on a different schedule from the
   * account itself. Precedent: `reauth_challenges.ip_hash` (v1.2b).
   *
   * The absence of `FOREIGN KEY(user_hash) REFERENCES users(id)` is deliberate
   * and not an oversight — it could not exist even in principle, since the
   * column holds a digest and not an id. The consequence is worth stating: when
   * an account is deleted, its error events are NOT cascaded away. What remains
   * is a hash that cannot be resolved back to a person without the original id,
   * on rows the 30-day sweep removes anyway. Keeping the events is also the
   * point — an error is a fact about the software, and losing the evidence
   * because the reporter later closed their account would be the wrong trade.
   *
   * `role` is coarse and `user_agent` is a family ("Safari/iOS"), not a full
   * UA string, for the same reason: enough to characterise a failure, not
   * enough to single somebody out.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS error_events (
      id           TEXT PRIMARY KEY,
      fingerprint  TEXT NOT NULL,
      occurred_at  TEXT NOT NULL,
      stack        TEXT,
      route        TEXT,
      method       TEXT,
      status_code  INTEGER,
      user_hash    TEXT,
      role         TEXT,
      user_agent   TEXT,
      context      TEXT,
      FOREIGN KEY(fingerprint) REFERENCES error_groups(fingerprint) ON DELETE CASCADE
    )
  `);

  // The dashboard's "recent occurrences for this group" read, and the
  // per-fingerprint 50-event cap, which deletes the oldest beyond that.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_error_events_group
      ON error_events(fingerprint, occurred_at DESC)
  `);

  /**
   * The retention sweep filters on `occurred_at` ALONE, across every
   * fingerprint. `idx_error_events_group` cannot serve that query — `occurred_at`
   * is not its leading column — so without this index the 30-day pass full-scans
   * the largest table in the schema on every run, which is precisely the table
   * this release exists to keep bounded.
   */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_error_events_occurred
      ON error_events(occurred_at)
  `);
}

export default { version: 4, name: 'error_events', up, fileUrl: import.meta.url };
