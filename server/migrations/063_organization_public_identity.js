/**
 * An organization becomes something you can point at, invite to, and ask to
 * join in your own words.
 *
 * ── What 062 established, and what this adds ──
 *
 * 062 gave a club a membership policy and ONE invitation link, and that shape
 * was right for what it answered: can somebody get in, and how. Three things it
 * deliberately left out have turned out to be wanted, and each needs durable
 * state:
 *
 *   • **A public identity.** The club had a `slug`, but it was an internal
 *     addressing detail — re-derived on every rename, so any link to it broke —
 *     and the page behind it always required a session. A club that wants to put
 *     itself on a flyer needs a handle that is stable and a page that opens.
 *
 *   • **More than one invitation link.** One link cannot tell the flyer from the
 *     Instagram post, so a club that wanted to retire one retired all of them.
 *
 *   • **A sentence.** A student asking to join had no way to say why, and a
 *     manager deciding had nothing but a name to decide on.
 *
 * ── Why a new migration rather than editing 062 ──
 *
 * 062 is committed and its source is checksummed. Any database that has already
 * recorded it — a developer's `dev.db`, a scratch database — would refuse to
 * boot on the next start with a checksum mismatch, which ENGINEERING_GUIDE §8.5
 * treats as a serious event requiring an operator. Extending forward costs one
 * table rebuild and nobody's morning.
 *
 * ── The one rebuild, and why it needs no guard set ──
 *
 * `organization_share_links` keyed on `organization_id` as its PRIMARY KEY,
 * which is exactly the constraint that made one link per club true. Multiple
 * named links means a different primary key, and SQLite cannot alter one — so
 * this is the create-copy-drop-rename dance.
 *
 * §8.3's guard set is required for a rebuild of a table with CHILDREN, because
 * the hazard it addresses is a cascade deleting rows nobody counted. This table
 * has none: nothing in the schema references it, verified against
 * `sqlite_master`. The copy is still row-counted below, because a rebuild that
 * silently drops a club's live link would be indistinguishable from a
 * revocation, and every existing row is carried across as a link labelled
 * "General" so no distributed link stops working (requirement: existing share
 * links keep working unless explicitly revoked).
 */

/**
 * The visibility vocabulary.
 *
 * ── Why this is a SECOND axis and not a fourth join mode ──
 *
 * `join_policy` answers "who may become a member". Whether the club's page
 * opens to somebody with no account is a different question, and folding the
 * two into one enum produces the nonsense states: an `open` club that is not
 * discoverable, an `unlisted` club that anyone may join. Two orthogonal
 * settings, each with one job, is why the model stays explainable — which is
 * the constraint the brief puts above sophistication.
 *
 *   public    the canonical handle opens without a session, and the club
 *             appears in discovery.
 *   unlisted  the handle needs a session, and the club is left out of the
 *             public projection. Members and managers see no difference.
 *
 * NOT a third value for "invitation-only" — that is `join_policy = 'invite'`,
 * and a club can be publicly visible AND invitation-only, which is the common
 * case a school club actually wants: findable, with a door.
 */
const VISIBILITIES = ['public', 'unlisted'];

/** @param {import('node:sqlite').DatabaseSync} db */
function up(db) {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

  /* ── organizations: visibility ──────────────────────────────────────────── */

  /**
   * Existing clubs default to `unlisted`; NEW ones are created `public`.
   *
   * The asymmetry is deliberate and is the whole privacy argument of this
   * migration. Every organization that exists today was created when its page
   * required a session, and nobody running one agreed to a public page. Flipping
   * them all to `public` in a migration would publish — quietly, on a deploy —
   * the name, description, tags, member COUNT and upcoming opportunities of
   * every club on a platform whose members are children. Nothing in the
   * projection names a person, and it is still not ours to publish on their
   * behalf.
   *
   * So the backfill takes the safe direction and the CREATE path (see
   * `createOrganization`) takes the useful one, because somebody making a club
   * today is doing it in a product that offers a public page and can see the
   * setting while they do it. One click either way, explained in the settings
   * screen.
   */
  if (!columns('organizations').includes('visibility')) {
    db.exec(`ALTER TABLE organizations ADD COLUMN visibility TEXT NOT NULL DEFAULT 'unlisted'`);
  }
  db.exec(`UPDATE organizations SET visibility = 'unlisted' WHERE visibility IS NULL`);

  /* No CHECK, for the reason 062 gives about `join_policy`: SQLite cannot add
     one without rebuilding `organizations`, and a PostgreSQL-only constraint
     would leave a migrated database stricter than a fresh one. Validated in
     `organizationPolicy.js`, and every reader normalises to `unlisted` — the
     narrower value — so an unrecognised setting can only ever publish less. */

  /* ── join requests: the student's own sentence ──────────────────────────── */

  /**
   * Nullable, and it stays nullable.
   *
   * The message is OPTIONAL — a student who does not want to explain themselves
   * to a club should not have to, and requiring one would turn a join button
   * into an application form. `NULL` means "did not write one" and the empty
   * string is never stored; the route normalises one to the other so a manager's
   * screen has one absence to render rather than two.
   */
  if (!columns('organization_join_requests').includes('message')) {
    db.exec('ALTER TABLE organization_join_requests ADD COLUMN message TEXT');
  }

  /* ── share links: many, named, optionally expiring ──────────────────────── */

  const rebuilt = columns('organization_share_links').includes('id');
  if (!rebuilt) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM organization_share_links').get().n;

    db.exec(`
      CREATE TABLE organization_share_links_new (
        id              TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        token           TEXT NOT NULL UNIQUE,
        /**
         * What the club calls it — "School flyer", "Instagram", "Class of 2027".
         *
         * NOT NULL because a list of links distinguished only by their creation
         * dates is a list nobody can act on: the whole reason for having more
         * than one is knowing which is which. The route supplies "General" when
         * a club does not care, which is also what every link carried over from
         * 062 is called.
         */
        label           TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        /* SET NULL rather than CASCADE: a manager graduating must not silently
           take the club's links with them. */
        created_by      TEXT,
        /**
         * NULL means never expires, and that is the default the product offers.
         *
         * A link on a printed flyer has to keep working, and an expiry nobody
         * chose is the failure mode 062 rejected expiry outright to avoid. This
         * makes it a decision instead: a club can put a date on a link when the
         * link is genuinely temporary — an event booth, a single lesson — and the
         * form warns before it does.
         */
        expires_at      TEXT,
        /**
         * NULL means live. Revoking sets it rather than deleting the row, so a
         * manager can see that a link they handed out has been switched off
         * rather than wondering where it went — the same argument
         * organization_bans.lifted_at makes.
         */
        revoked_at      TEXT,
        /**
         * How many times this link admitted somebody, and roughly when.
         *
         * ── Why these two and nothing else ──
         *
         * A manager sharing three links needs to know which one is working; that
         * is the entire question, and a count answers it. What is deliberately
         * NOT recorded: who used it, their address, their device, or a row per
         * use. This is an aggregate on the link, incremented in the same
         * transaction as the membership — so there is no event log to leak, no
         * per-student trail through a club's recruitment, and nothing for a
         * third party to receive.
         *
         * last_used_at is a DATE, not a timestamp, for the same reason: "used
         * this week" is what a manager acts on, and the hour somebody joined a
         * club is a fact about that person's evening.
         */
        uses            INTEGER NOT NULL DEFAULT 0,
        last_used_at    TEXT,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    /**
     * Every link 062 minted is carried across as the club's "General" link.
     *
     * An explicit column list, never `SELECT *` — §8.3's third guard, and it
     * applies to a copy of any shape: column ORDER differs between databases
     * because it depends on which `addColumnIfMissing` ran when, and a
     * positional copy writes each value into whatever column shares its index.
     *
     * `rotations` is dropped on purpose. It counted replacements of the single
     * link, and with many links the question it answered ("has this been
     * replaced?") is now answered by the list itself: a rotated link is a
     * revoked row beside a live one.
     */
    db.exec(`
      INSERT INTO organization_share_links_new
        (id, organization_id, token, label, created_at, created_by, uses)
      SELECT 'oshl-' || organization_id, organization_id, token, 'General', created_at, created_by, 0
        FROM organization_share_links
    `);

    const after = db.prepare('SELECT COUNT(*) AS n FROM organization_share_links_new').get().n;
    if (Number(after) !== Number(before)) {
      throw new Error(
        `063: copied ${after} share links but found ${before}. A club's live invitation `
        + 'link going missing is indistinguishable from a revocation, so this refuses '
        + 'rather than committing a partial copy.'
      );
    }

    db.exec('DROP TABLE organization_share_links');
    db.exec('ALTER TABLE organization_share_links_new RENAME TO organization_share_links');
  }

  /* The resolver's only query: one live link by token. `UNIQUE(token)` already
     indexes the equality; this one serves the club's own list. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_share_links_org
      ON organization_share_links(organization_id, revoked_at)
  `);

  /* ── direct invitations ─────────────────────────────────────────────────── */

  /**
   * An invitation addressed to one person.
   *
   * ── Why there is no token column ──
   *
   * Every other invitation in this codebase is a bearer credential because it
   * has to travel outside the product — an emailed administrator invitation, a
   * link on a flyer. This one does not. It names an ACCOUNT, it is delivered as
   * a notification to that account, and it is accepted by that account while
   * signed in.
   *
   * So the authorization is `invited_user_id = req.principal.userId`, which is
   * strictly stronger than any token: there is nothing to intercept, nothing to
   * forward, nothing to guess, and nothing to expire early for safety's sake.
   * The whole class of token bugs — replay, enumeration, leakage into logs and
   * browser history — does not arise. `adminInvitations` needs a token because
   * the invited party may not have an account yet; here they must.
   *
   * ── Why not by email address ──
   *
   * Considered and refused. It would mean a club manager — a teacher, or a
   * sixteen-year-old with the rank — could send platform mail to an arbitrary
   * address, and the response would necessarily reveal whether that address has
   * an account, which is the enumeration `/api/auth/forgot-password` is
   * carefully written to avoid. On a platform holding children's data that is a
   * worse trade than asking an inviter to find somebody in the directory they
   * can already search.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_invitations (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      invited_user_id TEXT NOT NULL,
      invited_by      TEXT,
      /* The inviter's optional note, under the same length rule and the same
         escaping as a join request's message. */
      message         TEXT,
      status          TEXT NOT NULL
                        CHECK(status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
      created_at      TEXT NOT NULL,
      /* NULL means it does not lapse. Unlike a share link, an invitation names
         one person, so a stale one is clutter rather than a liability — and a
         club that wants to clear its list revokes. */
      expires_at      TEXT,
      resolved_at     TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  /**
   * One live invitation per person per club, enforced by the database.
   *
   * The same idiom as `idx_org_join_requests_live`, for the same reason:
   * "no duplicate pending invitations" is a relational fact, and a
   * read-then-write check produces two rows under two clicks — after which
   * accepting one leaves the other pending for ever. Partial, so a declined
   * invitation does not stop a club asking again next term.
   */
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invitations_live
      ON organization_invitations(organization_id, invited_user_id) WHERE status = 'pending'
  `);

  /* The club's outstanding list, and the invited person's own. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_invitations_org
      ON organization_invitations(organization_id, status, created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_invitations_user
      ON organization_invitations(invited_user_id, status)
  `);
}

/**
 * The same schema on PostgreSQL.
 *
 * The share-link change is four `ALTER`s rather than a rebuild, because
 * PostgreSQL can drop and add a primary key in place — the trade
 * `057_widen_event_categories` records: porting SQLite's workaround would be a
 * longer route to the same schema with more chances to get it wrong.
 *
 * `ADD COLUMN IF NOT EXISTS` throughout, for the reason 058 gives: the clause
 * exists, it is atomic, and it makes re-running the migration the database's
 * problem rather than a read-then-write race in application code.
 */
async function postgresUp(db) {
  await db.exec(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'unlisted';

    ALTER TABLE organization_join_requests
      ADD COLUMN IF NOT EXISTS message text;
  `);

  /**
   * The share-link table, altered in place.
   *
   * Order matters: the new columns and the `id` values have to exist before the
   * primary key can move off `organization_id`, and `id` has to be NOT NULL
   * before it can BE the primary key. Each statement is separately guarded so a
   * re-run is a sequence of no-ops rather than a failure.
   */
  await db.exec(`
    ALTER TABLE organization_share_links
      ADD COLUMN IF NOT EXISTS id           text,
      ADD COLUMN IF NOT EXISTS label        text,
      ADD COLUMN IF NOT EXISTS expires_at   text,
      ADD COLUMN IF NOT EXISTS revoked_at   text,
      ADD COLUMN IF NOT EXISTS uses         integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_used_at text;

    /* Carried across exactly as the SQLite copy does: every link 062 minted
       becomes the club's "General" link, keeping its token live. */
    UPDATE organization_share_links
       SET id = COALESCE(id, 'oshl-' || organization_id),
           label = COALESCE(label, 'General');

    ALTER TABLE organization_share_links
      ALTER COLUMN id SET NOT NULL,
      ALTER COLUMN label SET NOT NULL;
  `);

  /**
   * Moving the primary key.
   *
   * Guarded by a catalogue probe rather than `IF NOT EXISTS`, which PostgreSQL
   * does not offer for a constraint — and the constraint's name is generated, so
   * the probe asks `pg_index` what the primary key currently covers instead of
   * guessing what it is called.
   */
  await db.exec(`
    DO $$
    DECLARE pk_col text;
    BEGIN
      SELECT a.attname INTO pk_col
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'organization_share_links'::regclass AND i.indisprimary
       LIMIT 1;

      IF pk_col = 'organization_id' THEN
        EXECUTE 'ALTER TABLE organization_share_links DROP CONSTRAINT '
             || (SELECT conname FROM pg_constraint
                  WHERE conrelid = 'organization_share_links'::regclass AND contype = 'p');
        EXECUTE 'ALTER TABLE organization_share_links ADD PRIMARY KEY (id)';
      END IF;
    END
    $$;
  `);

  /* `rotations` goes with the single-link model it counted. Dropped rather than
     left behind, because a column nothing reads is a column somebody will
     eventually read and misinterpret. */
  await db.exec('ALTER TABLE organization_share_links DROP COLUMN IF EXISTS rotations');

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_share_links_org
      ON organization_share_links(organization_id, revoked_at);

    CREATE TABLE IF NOT EXISTS organization_invitations (
      id              text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invited_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by      text REFERENCES users(id) ON DELETE SET NULL,
      message         text,
      status          text NOT NULL
                        CHECK(status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
      created_at      text NOT NULL,
      expires_at      text,
      resolved_at     text
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invitations_live
      ON organization_invitations(organization_id, invited_user_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_org_invitations_org
      ON organization_invitations(organization_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_org_invitations_user
      ON organization_invitations(invited_user_id, status);
  `);
}

export default {
  version: 63,
  name: 'organization_public_identity',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
  /** Exported for the vocabulary module and its tests. */
  VISIBILITIES,
};
