/**
 * `users.graduation_year` — "Class of ____".
 *
 * ── Why this exists ──
 *
 * Registration collected `grade` and nothing else about where someone is in
 * school. A grade is only true for one school year: nothing in this application
 * advances it — no scheduled job, no login hook — so every account's grade is
 * silently wrong from the following August onward, and a tenth grader who
 * registered in 2026 is still recorded as a tenth grader after they graduate.
 * Every eligibility question asked of that column then gets a stale answer that
 * looks perfectly valid, which is the worst shape a data error can take.
 *
 * ── Why the class year, rather than a second grade-shaped field ──
 *
 * Grade level and graduation year are the same fact expressed two ways, and one
 * of the two expressions does not decay. "Class of 2029" is as true in 2031 as
 * the day it was typed, and today's grade falls out of it with one subtraction
 * against the current school year. So this column is the SOURCE OF TRUTH for
 * grade level and `users.grade` is derived from it — see
 * `gradeForGraduationYear` and `validateGraduationYear` in
 * `server/accountValidation.js`, which is the only thing that decides what goes
 * into `users.grade` at signup. `users.grade` predates this column and is NOT
 * NULL, so it still holds a value; recomputing it from `graduation_year` is
 * always safe, and the reverse is not.
 *
 * INTEGER rather than TEXT because it is a year, ordered and compared as a
 * number, and a text '2027' sorts correctly only by accident of digit count.
 *
 * ── Why nullable, with no CHECK constraint ──
 *
 * Two reasons, and they are different:
 *
 *   - NULL means "no class year", which is the correct and permanent answer for
 *     an organizer (`grade: 'Adult'`) and for `'N/A'`. It is also the answer for
 *     every account that predates this column: inventing one from a grade that
 *     may already be years stale would manufacture a fact rather than record
 *     one. Those rows are grandfathered, exactly as 008 grandfathered
 *     `date_of_birth`.
 *   - No CHECK, because the valid range MOVES. It is `[current senior class,
 *     that plus three]` — 2027–2030 during the 2026–27 school year — so a CHECK
 *     would be a literal that is right for one year and then starts refusing
 *     legitimate signups while accepting graduated ones. A moving rule belongs
 *     in code that can read the clock, and `graduationYearRange()` is it.
 *
 * ── Additive; §8.3's rebuild guards do not apply ──
 *
 * One nullable ALTER TABLE ADD COLUMN. No rebuild, no constraint change, no
 * backfill. Ordered after 001 for the reason 006 and 008 record: `runMigrations`
 * runs last in `initDatabase()`, so a column added by `addColumnIfMissing` would
 * exist before 001 rebuilds `users`, and 001's unknown-column guard would
 * correctly refuse to copy it. That is why this is a registry migration and not
 * an `addColumnIfMissing` line in db.js.
 *
 * ── Rollback ──
 *
 *     ALTER TABLE users DROP COLUMN graduation_year;
 *     DELETE FROM schema_migrations WHERE version = 10;
 */
function up(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (columns.some(c => c.name === 'graduation_year')) return;
  db.exec('ALTER TABLE users ADD COLUMN graduation_year INTEGER');
}

export default { version: 10, name: 'graduation_year', up, fileUrl: import.meta.url };
