/**
 * `user_blocks` — the control a student holds themselves.
 *
 * ── Why this matters more than it looks ──
 *
 * Every safety control the platform had was *reactive*: report something, and a
 * human eventually acts. That is necessary and it is not sufficient, because it
 * depends on a student trusting the response and being willing to wait for it.
 * Blocking is the one protection that works at 2am, with no one else involved,
 * for a student who cannot articulate what is wrong yet.
 *
 * The Youth Safety Guidelines previously carried a flag saying "You cannot
 * currently block someone… we know this is not good enough." This removes it.
 *
 * ── Deliberately asymmetric ──
 *
 * A student may block an organizer. An organizer may NOT block a student.
 *
 * That is not an oversight. Blocking in the organizer→student direction would
 * be a tool for silencing a complaint: the adult who has behaved badly cuts off
 * the channel the student would use to say so, and does it before anybody
 * reviews anything. An organizer being harassed has the report queue, admins,
 * and suspension — all of which involve a second person. Enforced in the route
 * by capability, never by role string.
 *
 * ── What a block does NOT do ──
 *
 * It does not withdraw the student from the event, does not hide them from the
 * roster, and does not stop the organizer marking attendance or crediting
 * hours. Cutting off a student's service record as a side effect of them
 * feeling unsafe would punish exactly the person the feature protects, and it
 * would make blocking something a student weighs against their graduation
 * requirement — which is precisely the calculation a safety control must never
 * force. Messaging stops; the volunteering relationship does not.
 *
 * ── Additive; §8.3's rebuild guards do not apply ──
 *
 * One new table and its indexes. Nothing existing is touched.
 * `ownTransaction` is unset so the registry's BEGIN/COMMIT wraps it.
 *
 * ── ON DELETE CASCADE, unlike legal_acceptances ──
 *
 * A block is a live preference between two accounts, not evidence about a past
 * act. When an account goes, its blocks are meaningless. The moderation signal
 * that a block was placed survives independently in `admin_audit_logs`, which
 * is where the evidentiary value actually lives.
 *
 * ── Rollback ──
 *
 *     DROP TABLE user_blocks;
 *     DELETE FROM schema_migrations WHERE version = 9;
 */
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      id         TEXT PRIMARY KEY,
      blocker_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // One block per direction per pair. Re-blocking is idempotent rather than
  // producing duplicate rows that would each have to be cleared separately.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_blocks_pair
      ON user_blocks(blocker_id, blocked_id)
  `);

  // The hot path is "is either direction of this pair blocked", asked on every
  // conversation resolve and every message send.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
      ON user_blocks(blocked_id, blocker_id)
  `);
}

export default { version: 9, name: 'user_blocks', up, fileUrl: import.meta.url };
