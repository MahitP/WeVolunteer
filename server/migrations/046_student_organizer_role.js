/**
 * Student Organizer — a rank inside one organization, not a change of account.
 *
 * ── What it is for ──
 *
 * A club is usually run by students. Until now the only way to let one help was
 * to make them a `manager`, which is the whole organization: archiving it,
 * banning people, deciding appeals, promoting other managers. That is far more
 * than "can you post the notice and set up Saturday's shift", and it is handed
 * to a sixteen-year-old because there was no smaller thing to give.
 *
 * So `member_role` gains a third value between `member` and `manager`.
 *
 * ── Why this is safe against inheriting manager powers ──
 *
 * `canManage` — the single gate on every sensitive organization route — asks
 * `member_role === 'manager'`. A new value is therefore refused by every one of
 * them by construction, without a line changing: archive, member removal, bans,
 * role changes and the appeal inbox all continue to mean "manager" exactly as
 * they did. The new rank only reaches routes that explicitly ask for it.
 *
 * ── Why the table is rebuilt ──
 *
 * `member_role` carries `CHECK(member_role IN ('member','manager'))` from
 * migration 031, and SQLite cannot alter a CHECK constraint in place. The
 * alternatives were a second table (a join on every membership read, to store
 * one word that already has a column) or dropping the constraint (which is what
 * keeps a typo out of the column). Rebuilding is the honest cost of the
 * constraint being worth having.
 *
 * The copy is `INSERT INTO … SELECT` over named columns rather than `SELECT *`,
 * so a column added between this migration being written and being run does not
 * silently shift the mapping.
 */
export function up(db) {
  const columns = db.prepare('PRAGMA table_info(organization_members)').all();
  if (columns.length === 0) return; // The table arrives with migration 031.

  /* Already rebuilt: the CHECK mentions the new value. Re-running must be a
     no-op, and rebuilding a second time would drop the indexes again for
     nothing. */
  const ddl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'organization_members'"
  ).get()?.sql || '';
  if (ddl.includes('student_organizer')) return;

  db.exec(`
    CREATE TABLE organization_members_new (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      /*
        member            - belongs to the club.
        student_organizer - helps run it: posts and events, nothing more.
        manager           - the organization itself, including who else runs it.

        No backticks in here: this comment lives inside a template literal, and
        a backtick would end the string mid-SQL. It cost one parse failure.
      */
      member_role     TEXT NOT NULL DEFAULT 'member'
                        CHECK(member_role IN ('member', 'student_organizer', 'manager')),
      joined_at       TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    )
  `);

  db.exec(`
    INSERT INTO organization_members_new (organization_id, user_id, member_role, joined_at)
      SELECT organization_id, user_id, member_role, joined_at FROM organization_members
  `);

  db.exec('DROP TABLE organization_members');
  db.exec('ALTER TABLE organization_members_new RENAME TO organization_members');

  /* Recreated, because they belonged to the dropped table. `idx_org_members_user`
     is the one migration 031 added; the primary key covers the other direction. */
  db.exec('CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id)');
}

export default {
  version: 46,
  name: 'student_organizer_role',
  up,
  fileUrl: import.meta.url,
};
