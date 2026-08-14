/**
 * Reports about the PLATFORM, kept apart from reports about PEOPLE.
 *
 * ── Why this is not the existing `reports` table ──
 *
 * `reports` (migration 012) is the moderation queue: somebody reporting another
 * member's conduct or content. It carries a target user, a moderation decision,
 * evidence preservation, appeal linkage, and a priority rule that escalates a
 * student reporting an adult to urgent.
 *
 * "The calendar export is broken" is not that. Filing it in the same table
 * would put bug reports into the queue that exists to protect children, and the
 * cost is not tidiness — it is that the queue gets longer and the urgent thing
 * sits further down it. Reusing the taxonomy would be worse still: its
 * categories describe how somebody behaved, and none of them means "this page
 * throws".
 *
 * So: a separate table, a separate route, a separate notification, and no
 * connection to moderation at all.
 *
 * ── What is stored, and what is not ──
 *
 * The description as written, the category, and a small block of technical
 * context the client collects (route, viewport, user agent, app version). No
 * passwords, no tokens, no recovery codes, no message contents, no profile data
 * beyond the reporter's own id.
 *
 * `reporter_id` is nullable and ON DELETE SET NULL: a student who deletes their
 * account should not have the deletion blocked by a bug report they filed, and
 * the report itself is still worth keeping without them attached to it.
 *
 * ── The reference ──
 *
 * `reference` is what the confirmation screen shows and what somebody quotes
 * back in an email. UNIQUE, because two reports sharing one is a support
 * conversation about the wrong report.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_reports (
      id           TEXT PRIMARY KEY,
      reference    TEXT NOT NULL UNIQUE,
      category     TEXT NOT NULL,
      description  TEXT NOT NULL,
      /* Nullable on purpose — see the header. */
      reporter_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
      /* A JSON blob of non-identifying technical context. Bounded at the route. */
      context      TEXT,
      status       TEXT NOT NULL DEFAULT 'open'
                     CHECK(status IN ('open', 'triaged', 'closed')),
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);

  /* The two ways staff read this: newest first, and "what is still open". */
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_reports_recent ON issue_reports(created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_reports_status ON issue_reports(status, created_at DESC)');
  /* Rate limiting counts a reporter's recent rows. */
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_reports_reporter ON issue_reports(reporter_id, created_at)');
}

export default {
  version: 51,
  name: 'issue_reports',
  up,
  fileUrl: import.meta.url,
};
