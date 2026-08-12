/**
 * Announcements an organization makes, and the replies to them.
 *
 * ── Modelled on `event_announcements`, not merged with it ──
 *
 * The event table is `(id, event_id, author_id, body, created_at, updated_at)`
 * and this is deliberately its sibling rather than a widened version of it with
 * a nullable `event_id`. A nullable foreign key on a table whose whole meaning
 * is "which thing is this attached to" turns every read into a branch, and the
 * two have genuinely different authorization: an event announcement is gated on
 * hosting the event, an organization announcement on managing the organization.
 *
 * ── `replies_enabled`, and what happens to replies when it is turned off ──
 *
 * Default 1: an announcement people cannot answer is a broadcast, and a
 * volunteer noticing "that clashes with the game" is the whole reason a
 * volunteering organization posts anything.
 *
 * When a manager turns replies off, EXISTING REPLIES ARE KEPT AND STAY VISIBLE.
 * That is the deliberate choice among the three available:
 *
 *   - Delete them. Never: somebody wrote that, other people have read it, and a
 *     toggle is not a moderation decision. Deleting other people's words as a
 *     side effect of a settings change is indefensible.
 *   - Hide them. Worse than deleting in one specific way — the authors cannot
 *     tell it happened, so they carry on believing they were heard.
 *   - Keep them, and stop new ones. The conversation that happened, happened;
 *     the thread is closed. This is what a locked thread means everywhere else,
 *     which means nobody has to be taught it.
 *
 * The flag is therefore enforced only on INSERT. Moderation and deletion remain
 * the separate, deliberate acts they already are.
 *
 * ── Cascades ──
 *
 * Replies cascade from their announcement, and announcements from their
 * organization: neither has any meaning once its parent is gone, and unlike an
 * attendance record neither is anybody's service history. Authors are
 * tombstoned rather than deleted, so the author cascade is a backstop for a
 * path the product does not take.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_announcements (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      author_id       TEXT NOT NULL,
      body            TEXT NOT NULL,
      replies_enabled INTEGER NOT NULL DEFAULT 1 CHECK(replies_enabled IN (0, 1)),
      created_at      TEXT NOT NULL,
      updated_at      TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  /* The list is always "this organization's announcements, newest first", which
     is the only way this table is ever read. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_announcements_org
      ON organization_announcements(organization_id, created_at DESC)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_announcement_replies (
      id              TEXT PRIMARY KEY,
      announcement_id TEXT NOT NULL,
      author_id       TEXT NOT NULL,
      body            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      FOREIGN KEY (announcement_id) REFERENCES organization_announcements(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  /* Replies are fetched per announcement, oldest first — a conversation reads
     forwards, unlike the announcement list above. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_announcement_replies
      ON organization_announcement_replies(announcement_id, created_at)
  `);
}

export default {
  version: 41,
  name: 'organization_announcements',
  up,
  fileUrl: import.meta.url,
};
