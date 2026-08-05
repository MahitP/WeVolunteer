import crypto from 'node:crypto';

/**
 * User blocking.
 *
 * Kept out of the route files for the same reason `authz.js` and `consent.js`
 * are: the rule about what a block means has one home, and it is testable
 * without booting a listener.
 *
 * ── The asymmetry is the design ──
 *
 * Students block; organizers do not. An organizer who could block would be able
 * to sever the channel a student would use to complain about them, before
 * anybody reviewed anything. The route enforces this by capability
 * (`event.apply`), never by comparing a role string.
 *
 * ── A block is not a withdrawal ──
 *
 * Blocking stops messages. It does not remove the student from the event, hide
 * them from the roster, or stop the organizer marking attendance and crediting
 * hours. Making a safety control cost a student their service record would force
 * them to weigh feeling unsafe against their graduation requirement, which is
 * the one calculation this feature exists to remove.
 */

/** True when either party has blocked the other. */
export function isBlockedBetween(db, a, b) {
  return Boolean(db.prepare(`
    SELECT 1 FROM user_blocks
    WHERE (blocker_id = ? AND blocked_id = ?)
       OR (blocker_id = ? AND blocked_id = ?)
    LIMIT 1
  `).get(a, b, b, a));
}

/** The ids this user has blocked. */
export function blockedBy(db, blockerId) {
  return db.prepare('SELECT blocked_id FROM user_blocks WHERE blocker_id = ?')
    .all(blockerId).map(r => r.blocked_id);
}

/**
 * Records a block. Idempotent — re-blocking is a no-op rather than an error,
 * because a student tapping Block twice is not a mistake worth an error page.
 *
 * Returns true when a row was actually created, so the caller can decide
 * whether to raise the moderation signal (a repeat tap should not).
 */
export function block(db, { blockerId, blockedId, now = null }) {
  const existing = db.prepare(
    'SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'
  ).get(blockerId, blockedId);
  if (existing) return false;

  db.prepare(`
    INSERT INTO user_blocks (id, blocker_id, blocked_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    `blk-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    blockerId,
    blockedId,
    now ?? new Date().toISOString()
  );
  return true;
}

/** Removes a block. Returns true when one was actually removed. */
export function unblock(db, { blockerId, blockedId }) {
  const { changes } = db.prepare(
    'DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'
  ).run(blockerId, blockedId);
  return changes > 0;
}
