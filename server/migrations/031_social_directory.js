/**
 * v1.3 — the member directory: public profiles, relationships, organizations,
 * external service records, and events that credit no hours.
 *
 * ── Why one migration and not six ──
 *
 * These tables are not independent. A public profile is only meaningful once
 * `profile_visibility` actually gates something; the friend-signup notification
 * cannot be written without both `user_relationships` and
 * `users.friend_activity_visible`; and an organization is useless until
 * `events.organization_id` exists to point at it. Splitting them would create
 * intermediate schema states in which half the feature is reachable and the
 * privacy half is not — which is precisely the window in which a leak ships.
 *
 * Every statement below is guarded, so `up` is re-runnable. Nothing here drops,
 * rebuilds, or rewrites an existing table: this migration is purely additive,
 * and deliberately so. The one destructive rebuild this repository sanctions is
 * 001, under the six guards in ENGINEERING_GUIDE §8.3, and none of the work
 * here needs that.
 */

/** ALTER TABLE ADD COLUMN, but only when the column is genuinely absent. */
function addColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export default {
  version: 31,
  name: 'social_directory',
  fileUrl: import.meta.url,

  up(db) {
    /* ── Profile fields ───────────────────────────────────────────────────
     *
     * `location` and `hobbies` are new public-baseline profile content. They
     * are stored exactly like the fields they sit beside: `location` as free
     * text (never geocoded, never a coordinate — see the note on the input's
     * placeholder in ProfileEditModal), `hobbies` as a JSON array, matching
     * `skills`.
     *
     * `location` is deliberately NOT the `latitude`/`longitude` pair that
     * `events` carries. An event's coordinates are a meeting point an organizer
     * chose to publish; a student's would be a minor's whereabouts, and the
     * product has no feature that needs one.
     */
    addColumn(db, 'users', 'location', 'TEXT');
    addColumn(db, 'users', 'hobbies', 'TEXT');

    /**
     * Whether accepted friends are told when this account signs up for
     * something. Defaults to 1 — *on* — because the friend relationship is
     * mutual and consented on both sides (see `user_relationships` below), so
     * the audience is one the account personally approved, and a discovery
     * feature that is off for everyone by default discovers nothing.
     *
     * The value gates the write, not the read: `friendsToNotify` in
     * relationships.js returns [] when this is 0, so no row is ever created.
     * There is nothing to leak later by changing a query.
     */
    addColumn(db, 'users', 'friend_activity_visible', 'INTEGER NOT NULL DEFAULT 1');

    /* ── Relationships ────────────────────────────────────────────────────
     *
     * One table, three kinds, one direction each. `user_blocks` is NOT folded
     * in here: blocking already exists, is already enforced in messaging.js,
     * and already has its own tests. Two tables that both claim to answer "is
     * this person blocked" is the failure mode worth avoiding, so blocks keep
     * their home and this table never stores kind='block'.
     *
     * `status` is only meaningful for kind='friend'. A friendship is a REQUEST
     * until the addressee accepts it, and that is a safety decision, not a
     * social one: an accepted friendship is what unlocks visibility of the
     * other person's signups, so a unilateral "follow" would let any account
     * subscribe to a minor's schedule without them ever agreeing. Mute and
     * restrict are unilateral by nature and are written straight to 'accepted'.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_relationships (
        id          TEXT PRIMARY KEY,
        actor_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK(kind IN ('friend', 'mute', 'restrict')),
        status      TEXT NOT NULL DEFAULT 'accepted'
                      CHECK(status IN ('pending', 'accepted')),
        created_at  TEXT NOT NULL,
        responded_at TEXT,
        /* One relationship of each kind per ordered pair. Re-sending a friend
           request is a no-op rather than a second row. */
        UNIQUE(actor_id, subject_id, kind),
        /* Self-relationships are meaningless in all three kinds and would make
           every "is X a friend of Y" query answer yes for X = Y. */
        CHECK(actor_id <> subject_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_relationships_subject ON user_relationships(subject_id, kind, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_relationships_actor ON user_relationships(actor_id, kind, status)');

    /* ── Organizations ────────────────────────────────────────────────────
     *
     * `slug` is the URL identity and is unique case-insensitively, for the same
     * reason `users.username` is: two organizations whose names differ only in
     * case are indistinguishable to a person reading a link.
     *
     * There is no `member_count` column. It would be a second source of truth
     * for something one indexed COUNT already answers, and the failure mode of
     * a denormalised counter — drifting silently after a cascade delete — is
     * exactly the class of bug the derived-hours invariant exists to prevent
     * elsewhere in this schema.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        /* Tags reuse the event tag vocabulary, stored the same way: a JSON
           array of strings. */
        tags        TEXT,
        /* The account that created it. ON DELETE SET NULL rather than CASCADE:
           deleting an organizer must not silently delete an organization other
           students have joined and events point at. */
        created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_by_name_snapshot TEXT,
        status      TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active', 'archived')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug COLLATE NOCASE)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_organizations_creator ON organizations(created_by)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS organization_members (
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        /* 'manager' may edit the organization and post its events; 'member'
           may not. The creator is seeded as a manager. This is scoped
           membership, not a platform role, and is never compared against
           users.role. */
        member_role     TEXT NOT NULL DEFAULT 'member'
                          CHECK(member_role IN ('member', 'manager')),
        joined_at       TEXT NOT NULL,
        PRIMARY KEY (organization_id, user_id)
      )
    `);
    /* Answers "which organizations is this person in", the query every profile
       and every membership check runs. The PK already answers the other
       direction. */
    db.exec('CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id)');

    /**
     * An event may name the organization it was run for.
     *
     * ON DELETE SET NULL, not CASCADE: an organization being archived or
     * deleted must never delete the events under it, because those events carry
     * attendance rows, and attendance is the sole source of credited hours.
     */
    addColumn(db, 'events', 'organization_id', 'TEXT REFERENCES organizations(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_organization ON events(organization_id)');

    /* ── Events that credit no hours ──────────────────────────────────────
     *
     * A donation drive, a supply sort, a one-off participation activity: real
     * service that time does not measure. The flag is a boolean, NOT an
     * hours value of zero, because the two mean different things and the
     * difference is visible everywhere hours are shown. `credits_hours = 0`
     * says "this event does not measure service in hours"; a stored 0 would say
     * "this volunteer earned nothing", which is both false and demoralising.
     *
     * Attendance is still recorded on these events. `hours_awarded` is written
     * as 0 so that SUM() arithmetic and the ledger's parity check keep working
     * untouched — the flag on the event is what carries the meaning, and every
     * display path reads it before formatting a number.
     */
    addColumn(db, 'events', 'credits_hours', 'INTEGER NOT NULL DEFAULT 1');

    /* ── External service records ─────────────────────────────────────────
     *
     * Volunteering done somewhere WeVolunteer does not run. This is a record
     * attached to one student, and it is emphatically not an event: it has no
     * slots, no applications, no roster, and no row in `events`. Keeping it in
     * its own table is what makes that structurally true rather than a rule
     * somebody has to remember — there is no code path by which an external
     * record can be listed, applied to, or attended.
     *
     * Nothing here is ever summed into credited hours, and nothing here reaches
     * Auto Select — see the header of weighting.js for why that one is a
     * security property and not a formatting preference.
     *
     * ── The `status` / review columns below are OBSOLETE. See migration 032. ──
     *
     * They were added on the inference that a `service.verify.external`
     * capability existed, so somebody must have intended an administrative
     * review flow. That inference was wrong: external hours are a personal log,
     * and a verification pipeline turns a notebook into an application form.
     * 032 rebuilds this table without `status`, `reviewed_by`, `reviewed_at` or
     * `review_note`, and the capability is gone from authz.js.
     *
     * The columns stay in THIS file because a migration is a historical record
     * of what ran, and rewriting it would change its checksum and break every
     * database that already applied it. Read 032 for the shape the table
     * actually has today.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS external_hours (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        organization_name TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        /* A calendar date (YYYY-MM-DD), not a timestamp. External service is
           reported after the fact and the hour of day is not knowable. */
        occurred_on   TEXT NOT NULL,
        hours         REAL NOT NULL,
        status        TEXT NOT NULL DEFAULT 'self_reported'
                        CHECK(status IN ('self_reported', 'verified', 'rejected')),
        reviewed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at   TEXT,
        review_note   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_external_hours_user ON external_hours(user_id, occurred_on DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_external_hours_review ON external_hours(status, created_at)');

    /* ── Indexes the new statistics depend on ─────────────────────────────
     *
     * `eventsSignedUp` counts distinct events per user off `applications`, and
     * `applications` had an index on event and on slot but none on user — so
     * every profile view was a full scan of the table. It is on the hot path of
     * a page any member can open about any other member, which is the worst
     * possible place for one.
     */
    db.exec('CREATE INDEX IF NOT EXISTS idx_applications_user_status ON applications(user_id, status)');
  },
};
