/**
 * How somebody gets into an organization, and how they are handed the door.
 *
 * ── What was missing ──
 *
 * Membership had exactly one mode. `POST /api/organizations/:key/membership`
 * inserted a `member` row for anybody who was not banned, and there was no way
 * for a club to say "we vet who joins" or "you need our link". There was also no
 * way to hand somebody that link: slugs are derived from the name and every
 * organization route requires a session, so an organizer could not put a club on
 * a flyer, in a group chat, or in a mail to a parent.
 *
 * This adds the three durable facts that make both possible, and nothing else.
 *
 * ── Additive on both engines ──
 *
 * Two columns and two new tables. Nothing is rebuilt, nothing is dropped, no
 * existing row is rewritten beyond being given the default it already behaved
 * as. So none of the guard set in ENGINEERING_GUIDE §8.3 applies: a failed run
 * leaves a working database.
 */

/**
 * Why the two policy columns carry NO CHECK constraint.
 *
 * SQLite cannot add one by `ALTER`, and the alternative is rebuilding
 * `organizations` — every column, every index, and the foreign keys `events`,
 * `organization_members`, `organization_bans` and `organization_announcements`
 * point at it with — in order to constrain a three-valued field. That is the
 * exact trade `045_event_audience` refused, for the same reason.
 *
 * Adding the CHECK on PostgreSQL only would be worse than none: `postgresSchema.js`
 * is GENERATED from a fully-migrated SQLite database, so a fresh PostgreSQL
 * database would not have the constraint while a migrated one would. Two
 * databases claiming to be the same schema and disagreeing about what a column
 * may hold is precisely the drift the generated file exists to make impossible.
 *
 * The vocabulary is validated where it is written (`server/organizationPolicy.js`,
 * consulted by `validateOrganization`), and every reader normalises: anything
 * that is not exactly `'open'` or `'request'` is read as `invite`, and anything
 * that is not exactly `'members'` is read as `helpers`. Both directions fail
 * CLOSED — an unrecognised value makes joining harder and sharing narrower,
 * never the reverse.
 */
const POLICY_COLUMNS = [
  /* 'open' | 'invite' | 'request'. Defaulted to what every existing
     organization already does, rather than left NULL: a NULL would be a third
     state meaning "unspecified", and every reader would have to decide what it
     implied — which is how one reader treats it as open and another as closed. */
  { name: 'join_policy', ddl: `ALTER TABLE organizations ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'open'` },
  /* 'helpers' | 'members'. Who may hand out the invitation link — NOT who may
     create or rotate it, which is always a manager. `helpers` is managers and
     student organizers, i.e. exactly `canHelpRun`, because the rank vocabulary
     already treats those two as one tier for the club's routine work. */
  { name: 'invite_policy', ddl: `ALTER TABLE organizations ADD COLUMN invite_policy TEXT NOT NULL DEFAULT 'helpers'` },
];

/** @param {import('node:sqlite').DatabaseSync} db */
function up(db) {
  const columns = db.prepare('PRAGMA table_info(organizations)').all().map(c => c.name);
  for (const { name, ddl } of POLICY_COLUMNS) {
    if (!columns.includes(name)) db.exec(ddl);
  }

  /* Explicit, for any row that predates the default. `ADD COLUMN` with a default
     fills existing rows, but a re-run against a database where the column
     arrived by another path should still leave no NULLs behind — the same
     belt-and-braces `045_event_audience` writes. */
  db.exec(`UPDATE organizations SET join_policy = 'open' WHERE join_policy IS NULL`);
  db.exec(`UPDATE organizations SET invite_policy = 'helpers' WHERE invite_policy IS NULL`);

  /**
   * The invitation link.
   *
   * ── Why a table rather than two more columns on `organizations` ──
   *
   * Every organization query in the product selects `o.*`: `ORG_SELECT` in
   * organizationRoutes.js, the directory search, the "mine" listing. A secret
   * living on that row would be loaded into memory by all of them, and kept out
   * of responses only by `formatOrganization` remembering not to name it. One
   * `...row` spread added a year from now and the token is on the wire.
   *
   * In its own table it is selected by exactly one module. That is the argument
   * `059_event_search_index` makes for keeping derived bookkeeping off `events`,
   * applied to a credential — where it matters more.
   *
   * ── One live link per organization ──
   *
   * `organization_id` is the primary key, so rotation is an UPDATE (the previous
   * token ceases to exist, which IS the revocation) and switching the link off
   * is a DELETE. Nothing in the product needs to tell two links apart, and the
   * primary key is what makes rotation atomic rather than a delete-then-insert
   * with a window in the middle where the club has no link at all.
   *
   * ── Why the token is stored, and not its digest ──
   *
   * Every other bearer value in this schema is hashed — `password_reset_tokens`,
   * `admin_invitations`, `checkin_tokens` — and migration 048 renamed those
   * columns precisely so a later edit could not quietly write plaintext back.
   * This one is different, and the difference is a REQUIREMENT rather than a
   * convenience: a club's invitation link is a standing address. It goes on a
   * flyer, a QR code and a pinned message, and the club has to be able to read
   * it back for as long as it is in circulation. A digest makes that impossible
   * — the only way to see the link again would be to replace it, which breaks
   * every copy already handed out.
   *
   * `certificates.code` is the in-repo precedent, for a value of strictly higher
   * sensitivity: it discloses one named minor's service record and it is stored
   * verbatim, because a student has to be able to re-print it.
   *
   * What the value is actually worth is the other half of the argument. This
   * token authorizes two things and no more: reading `publicOrganization` — the
   * club's own advertisement, carrying no member, no location and no hours — and
   * making a Join press succeed on a club whose policy is `invite`. It grants no
   * session, no capability, and no membership by itself. Somebody who has read
   * this table already has the organizations table beside it.
   *
   * Encrypting it under `TFA_ENCRYPTION_KEY` (the shape migration 027 uses for
   * TOTP secrets) was considered and rejected: it would give at-rest protection
   * for a low-value token at the cost of a second, differently-named key becoming
   * load-bearing for a feature it is not named for, plus a failure mode where a
   * key change makes every club's link unreadable while still resolvable.
   *
   * `UNIQUE(token)` supplies the lookup index for free, exactly as
   * `certificates.code` does — resolution is one indexed equality, never a scan
   * with a comparison per row.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_share_links (
      organization_id TEXT PRIMARY KEY,
      token           TEXT NOT NULL UNIQUE,
      created_at      TEXT NOT NULL,
      /* Who minted the current link. SET NULL rather than CASCADE: a manager
         graduating must not silently take the club's invitation link with them. */
      created_by      TEXT,
      /* How many times it has been replaced. Shown to a manager as "this link
         has been regenerated N times", which is the one thing they cannot work
         out from the link itself. */
      rotations       INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  /**
   * Asking to join, for the clubs that approve rather than admit.
   *
   * ── Statuses, and why `withdrawn` covers two things ──
   *
   * `pending` awaits a manager. `accepted` and `rejected` are decisions, and
   * both keep `decided_by` and `decided_at` so the record says who and when.
   * `withdrawn` means "no longer live, and not a manager's decision" — the
   * student cancelled it, or they became a member by another route and there is
   * nothing left to decide. One value rather than two, because the queue only
   * ever reads `pending` and no surface in the product distinguishes the two
   * ways a request stopped being live.
   *
   * ── No message column ──
   *
   * A free-text note written by a minor, read by club managers and copied into
   * a notification email, is a disclosure this feature does not need in order to
   * work. A name and a rank are what a manager decides on.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_join_requests (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      status          TEXT NOT NULL
                        CHECK(status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
      created_at      TEXT NOT NULL,
      decided_at      TEXT,
      decided_by      TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  /**
   * At most one LIVE request per person per organization.
   *
   * This is the database's guarantee, not the handler's. "No duplicate active
   * requests" is a relational fact, and leaving it to a read-then-write check in
   * JavaScript means two simultaneous presses of the same button produce two
   * rows — after which accepting one leaves the other pending for ever.
   *
   * Partial, so a rejected request does not block a later one: a student turned
   * down in September may ask again in March, and the history of both survives.
   * The same idiom, for the same reason, as `idx_org_bans_active`.
   */
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_join_requests_live
      ON organization_join_requests(organization_id, user_id) WHERE status = 'pending'
  `);

  /* The manager's queue: "what is pending here, oldest first". */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_join_requests_queue
      ON organization_join_requests(organization_id, status, created_at)
  `);

  /* The student's own view: "have I asked anywhere, and what happened". Read on
     every organization page load, so it is indexed rather than scanned. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_join_requests_user
      ON organization_join_requests(user_id, status)
  `);
}

/**
 * The same schema on PostgreSQL.
 *
 * `ADD COLUMN IF NOT EXISTS` rather than a catalogue probe, for the reason
 * migration 058 gives: the clause exists, it is atomic, and it makes re-running
 * the migration the database's problem rather than a read-then-write race in
 * application code. Deliberately without the CHECK the SQLite half cannot have —
 * see the note above `POLICY_COLUMNS`.
 */
async function postgresUp(db) {
  await db.exec(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS join_policy   text NOT NULL DEFAULT 'open';
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS invite_policy text NOT NULL DEFAULT 'helpers';

    CREATE TABLE IF NOT EXISTS organization_share_links (
      organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      token           text NOT NULL UNIQUE,
      created_at      text NOT NULL,
      created_by      text REFERENCES users(id) ON DELETE SET NULL,
      rotations       integer NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS organization_join_requests (
      id              text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status          text NOT NULL
                        CHECK(status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
      created_at      text NOT NULL,
      decided_at      text,
      decided_by      text REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_join_requests_live
      ON organization_join_requests(organization_id, user_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_org_join_requests_queue
      ON organization_join_requests(organization_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_org_join_requests_user
      ON organization_join_requests(user_id, status);
  `);
}

export default {
  version: 62,
  name: 'organization_membership_policy',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
