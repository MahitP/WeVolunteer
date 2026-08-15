/**
 * A background colour behind an emoji avatar.
 *
 * ── Why a colour at all ──
 *
 * An emoji on the same tinted circle as everybody else's emoji is not an
 * identity, it is a placeholder that happens to differ. The colour is what makes
 * a pick feel chosen — the same reason group chats offer one — and it costs a
 * single nullable column per table.
 *
 * ── Why a token name and not a hex ──
 *
 * The column stores a short key like `sage` or `clay`, resolved to a value by
 * `src/utils/avatarColors.js`, never a raw `#rrggbb`. Three reasons, in order of
 * how much they matter:
 *
 *   1. A hex from a client is arbitrary text rendered into a style attribute on
 *      every surface that draws that person. A key from a fixed set cannot be
 *      anything else.
 *   2. Every value in the set is contrast-checked against the ink drawn on it
 *      once, in one place, instead of hoping whatever somebody typed is legible.
 *   3. The palette can be retuned for dark mode without rewriting anybody's row.
 *
 * NULL means "no choice made", which renders the existing `--brand-tint` and is
 * what every current row keeps.
 */

function addColumn(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes('avatar_color')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN avatar_color TEXT`);
  }
}

function up(db) {
  addColumn(db, 'users');
  addColumn(db, 'organizations');
}

export default {
  version: 43,
  name: 'avatar_colour',
  up,
  fileUrl: import.meta.url,
};
