/**
 * `users.date_of_birth`, for the age gate.
 *
 * ── Why this exists ──
 *
 * `grade` accepted '9'–'12', 'Adult' and 'N/A', and nothing else about age was
 * collected. Ninth-graders are commonly 13 at enrollment and 'N/A' accepted
 * anyone, so an under-13 account was not merely possible — nothing anywhere in
 * the product could notice one.
 *
 * COPPA attaches on actual knowledge of a user under 13, and as an independent
 * platform there is no district standing between WeVolunteer and the child. The
 * amended Rule (fully enforceable since 2026-04-22) also requires a written
 * retention policy that references a time period — which is squarely
 * incompatible with the product decision to keep certificates and volunteer
 * hours indefinitely. Those two facts together mean the age gate is not just a
 * compliance item: **it is what makes the indefinite-retention decision lawful.**
 *
 * ── Why the date, rather than a stored age or a band ──
 *
 * An age is wrong within a year of being written, and a band ('13-17') cannot
 * tell you when someone turns 18 — which is exactly when guardian involvement
 * should end and the account becomes an adult's. A birth date is the only value
 * that stays correct without a job re-computing it, and it is the minimum that
 * answers both questions the product actually asks: "are they at least 13" at
 * signup, and "are they under 18" for guardian handling.
 *
 * Nullable, because every account that predates this column has no answer and
 * inventing one would be worse than the gap. `validateDateOfBirth` refuses new
 * signups without it; existing accounts are grandfathered and reported by the
 * backfill query in the release notes rather than being guessed at.
 *
 * ── Additive; §8.3's rebuild guards do not apply ──
 *
 * One nullable ALTER TABLE ADD COLUMN. No rebuild, no constraint change.
 * Ordered after 001 for the reason 006 records: `runMigrations` runs last in
 * `initDatabase()`, so a column added by `addColumnIfMissing` would exist before
 * 001 rebuilds `users`, and 001's unknown-column guard would correctly refuse
 * to copy it.
 *
 * ── Rollback ──
 *
 *     ALTER TABLE users DROP COLUMN date_of_birth;
 *     DELETE FROM schema_migrations WHERE version = 8;
 */
function up(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (columns.some(c => c.name === 'date_of_birth')) return;
  db.exec('ALTER TABLE users ADD COLUMN date_of_birth TEXT');
}

export default { version: 8, name: 'date_of_birth', up, fileUrl: import.meta.url };
