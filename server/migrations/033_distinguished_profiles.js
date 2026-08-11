/**
 * Two nullable text columns — and why they are a migration rather than a guard.
 *
 * ── What they hold ──
 *
 * `profile_headline` is one line under an account's name, in the account
 * holder's own words: what this account IS. `profile_highlights` is a JSON array
 * of short strings — the handful of things worth knowing about a community
 * partner or about the person who runs the platform, which an ordinary member
 * profile has no shape for.
 *
 * Neither column names a role. Which accounts get the distinguished
 * presentation is decided at READ time, from `users.role`, by `distinctionFor`
 * in server/profileSerializer.js — so an account that changes role gets the
 * right page with no row to rewrite, and no row ever has to be kept in step with
 * a persona.
 *
 * ── Why not `addColumnIfMissing` in db.js ──
 *
 * That is the normal home for an additive column (docs/ENGINEERING_GUIDE.md, "still correct for
 * almost everything") and it was where these two started. It does not work here,
 * and the reason is worth writing down because the next person will reach for it
 * too.
 *
 * `db.js` runs its additive guards BEFORE the versioned registry. Migration 001
 * rebuilds `users` from an EXPLICIT column list and refuses outright when it
 * finds a column it does not know about — correctly, since copying an explicit
 * list past an unknown column would silently delete that column's data. So on a
 * fresh database the two guards added the columns, 001 then found them, and boot
 * failed:
 *
 *     Migration 1_authz_roles failed: users has unexpected columns
 *     [profile_headline, profile_highlights]
 *
 * The error's own advice is to add them to `EXPECTED_USER_COLUMNS`, and that is
 * right for a column that predates 001. It is wrong for one added now: 001 has
 * been applied on every existing database and its source checksum is recorded in
 * `schema_migrations` and re-verified on every boot. Editing it would fail that
 * check everywhere it has already run — turning a new profile field into a
 * refusal to start.
 *
 * Ordering after 001 in `index.js` is what makes both true at once: 001 rebuilds
 * a table that does not yet carry these, and they exist by the time anything
 * reads them. It is the same position, and the same reasoning, as 031's
 * `location` and `hobbies`.
 */

/** Idempotent ADD COLUMN. SQLite has no `IF NOT EXISTS` for it. */
function addColumn(db, table, column, definition) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (has) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export default {
  version: 33,
  name: 'distinguished_profiles',
  fileUrl: import.meta.url,

  up(db) {
    /* Nullable, with no default. An absent headline is the correct state for
       every account that has not written one, which is nearly all of them —
       and `NULL` says that, where `''` would claim somebody cleared it. */
    addColumn(db, 'users', 'profile_headline', 'TEXT');
    /* A JSON array of strings, stored as TEXT exactly like `skills` and
       `hobbies` beside it. Parsed defensively on read (`parseHighlights` in
       profileSerializer.js): a profile that throws is a profile nobody can look
       at, including the moderator who came to look at it. */
    addColumn(db, 'users', 'profile_highlights', 'TEXT');
  },
};
