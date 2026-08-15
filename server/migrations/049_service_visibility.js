/**
 * A student decides who can see their service history and their certificates.
 *
 * ── What was true before ──
 *
 * `GET /api/users/:id/profile` returned the COMPLETE completed-service list for
 * any subject — every event, its category, its location, the organizer's name,
 * the hours and the dates — to any caller holding `directory.read`. Every
 * student holds `directory.read`. So one student could read another's whole
 * volunteering history, including where they were and when, by asking for it.
 *
 * That is the same data the printed transcript is built from. The profile page
 * happened to render only part of it, which is not a protection: the response
 * carried all of it and the network tab shows the response.
 *
 * ── The two columns ──
 *
 * `hours_visibility`        the service history and the hour totals
 * `certificates_visibility` the certificates somebody has earned
 *
 * Both default to `'public'`, and that is a deliberate product decision rather
 * than an oversight. Hours were already visible to every signed-in member, so
 * defaulting them to public changes nothing for anybody who has not asked for a
 * change — a migration that silently made every existing profile emptier would
 * be a surprise in the other direction. Certificates default to public because
 * being able to see what somebody has actually done is the point of having a
 * profile at all; what changes is that it is now a decision the student can
 * reverse, rather than one the software made for them permanently.
 *
 * ── Why there is no CHECK constraint ──
 *
 * SQLite cannot add one with `ALTER TABLE`, and `users` is the most
 * foreign-keyed table in the schema — a rebuild to gain a two-value constraint
 * would be a large risk for a small guarantee. The allowed values are enforced
 * where they are written (`VISIBILITY_VALUES` in server/serviceVisibility.js)
 * and, more importantly, where they are READ: anything that is not exactly
 * `'private'` is treated as public, so a corrupted value fails towards the
 * behaviour that was already in place rather than towards silently hiding a
 * student's record from themselves.
 *
 * That direction is chosen on purpose. The opposite default — unknown means
 * private — sounds safer and is worse here: it would mean a typo in a column
 * blanks the service record of every student on the platform at once, with no
 * error, and the people affected would have no way to tell it was a bug rather
 * than the product.
 */
const COLUMNS = [
  ['hours_visibility', "TEXT NOT NULL DEFAULT 'public'"],
  ['certificates_visibility', "TEXT NOT NULL DEFAULT 'public'"],
];

export function up(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (columns.length === 0) return;

  const have = new Set(columns.map((c) => c.name));
  for (const [name, ddl] of COLUMNS) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`);
    }
  }

  /* Existing rows take the column default, so nothing has to be backfilled —
     but a row written before the DEFAULT existed could hold NULL, and NULL is
     not 'private', so it reads as public. Normalised anyway so the stored data
     says what it means. */
  db.exec("UPDATE users SET hours_visibility = 'public' WHERE hours_visibility IS NULL");
  db.exec("UPDATE users SET certificates_visibility = 'public' WHERE certificates_visibility IS NULL");
}

export default {
  version: 49,
  name: 'service_visibility',
  up,
  fileUrl: import.meta.url,
};
