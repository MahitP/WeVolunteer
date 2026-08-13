/**
 * Replies are an ORGANIZATION setting, not a per-post one.
 *
 * ── The change, and why the column it replaces is left alone ──
 *
 * `organization_announcements.replies_enabled` shipped in 041 as a per-post
 * flag. The product decision is that this belongs to the organization: one
 * checkbox in Manage Organization, governing every announcement it publishes,
 * with no individual override. A manager deciding "we do not take replies"
 * is describing how their club communicates, not annotating one notice.
 *
 * The old column is NOT dropped. Dropping it would mean a table rebuild for no
 * gain, and it is the only record of what a manager chose under the previous
 * design — throwing that away to tidy a schema is exactly the kind of quiet
 * data loss this repository is careful about. It simply stops being consulted:
 * `organizationRoutes.js` reads `organizations.allow_replies` and nothing else.
 *
 * ── Default 1 ──
 *
 * An announcement nobody can answer is a broadcast, and a volunteer noticing
 * "that clashes with the game" is most of why a club posts at all. Every
 * existing organization keeps working exactly as it did.
 *
 * ── What turning it off does NOT do ──
 *
 * Existing replies stay visible. Somebody wrote them, other people read them,
 * and a settings toggle is not a moderation decision — the alternative, hiding
 * them, is worse still, because the authors would carry on believing they had
 * been heard. The flag is enforced only on insert.
 */

function up(db) {
  const columns = db.prepare('PRAGMA table_info(organizations)').all().map(c => c.name);
  if (!columns.includes('allow_replies')) {
    db.exec('ALTER TABLE organizations ADD COLUMN allow_replies INTEGER NOT NULL DEFAULT 1');
  }
}

export default {
  version: 42,
  name: 'organization_allow_replies',
  up,
  fileUrl: import.meta.url,
};
