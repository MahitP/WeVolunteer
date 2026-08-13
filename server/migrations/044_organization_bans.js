/**
 * Being banned from an organization, as distinct from being removed from one.
 *
 * ── Two different acts, deliberately two different records ──
 *
 * Removing somebody ends a membership. They can join again; the club simply has
 * one fewer member today. That is a `DELETE` from `organization_members` and
 * needs no history — the absence IS the state.
 *
 * A ban is a standing decision that this person may not come back. It has to
 * outlive the membership row it replaced, it has to be attributable, and it has
 * to carry the reason, because a person told they are banned and not told why
 * has nothing to appeal against. So it is a row of its own that survives every
 * later join attempt.
 *
 * ── Why the reason is NOT NULL here and optional on a removal ──
 *
 * Enforced at the schema, not only in the handler. A ban with no reason is a
 * decision nobody can review — including the manager who made it, six months
 * later, and the administrator hearing the appeal. Removal is routine roster
 * management and demanding a justification for it would train managers to type
 * "n/a", which is worse than an honest blank.
 *
 * ── `lifted_at`, and why a ban is not deleted to undo it ──
 *
 * Lifting sets `lifted_at` rather than removing the row. The fact that somebody
 * was banned and then unbanned is the very thing an appeal produces, and
 * deleting it would erase the outcome along with the decision. A partial unique
 * index keeps at most one ACTIVE ban per person per organization while allowing
 * the full history of lifted ones.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_bans (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      banned_by       TEXT,
      reason          TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      lifted_at       TEXT,
      lifted_by       TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (banned_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (lifted_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  /**
   * At most one LIVE ban per person per organization.
   *
   * Partial, so a lifted ban stays on the record and does not block a later one.
   * Without it, "ban, lift, ban again" leaves two rows both looking current and
   * the join check has to guess which it means.
   */
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_bans_active
      ON organization_bans(organization_id, user_id) WHERE lifted_at IS NULL
  `);

  /* The join path asks "is this person banned here" on every attempt. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_bans_lookup
      ON organization_bans(user_id, organization_id)
  `);
}

export default {
  version: 44,
  name: 'organization_bans',
  up,
  fileUrl: import.meta.url,
};
