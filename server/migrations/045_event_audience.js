/**
 * Who an event is for.
 *
 * ── The gap this fills ──
 *
 * An event could already belong to an organization (`events.organization_id`,
 * migration 031), but that link was decorative where eligibility was concerned:
 * it named the club on the card and nothing more. Anybody who could see an event
 * could apply to it, including somebody the organization had banned.
 *
 * `audience` makes the link mean something. `everyone` is the world as it was —
 * an open call, which is most of what this platform posts. `organization` is a
 * shift for the club's own members, and the server refuses everybody else.
 *
 * ── Why a column and not a separate table ──
 *
 * It is one value per event with exactly two states, read on the same row as
 * `organization_id` on every eligibility check. A join table would mean a join
 * on the hottest path in the application flow to answer a question the event
 * already knows the answer to.
 *
 * ── Why the default is backfilled rather than left NULL ──
 *
 * Every event that existed before this column was open to everyone in practice,
 * so that is what it says. A NULL would be a third state meaning "unspecified",
 * and every reader would have to decide what it implied — which is how one
 * reader ends up treating it as open and another as restricted.
 *
 * ── Why there is no CHECK constraint ──
 *
 * SQLite cannot add one by ALTER, and the alternative is rebuilding the whole
 * `events` table — every column, every index, every foreign key referencing it —
 * to constrain a two-valued field. The value is validated where it is written
 * (`server/eventAudience.js`, used by both the create and update routes), and
 * `eventApplicationEligibility` treats anything that is not the literal
 * `'organization'` as open. Both directions fail safe: an unrecognised value
 * lets people apply rather than silently locking an event nobody can join.
 */
export function up(db) {
  const columns = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);

  if (!columns.includes('audience')) {
    db.exec(`ALTER TABLE events ADD COLUMN audience TEXT NOT NULL DEFAULT 'everyone'`);
  }

  /* Explicit, for any row that predates the default — `ADD COLUMN` with a
     default fills existing rows, but a re-run against a database where the
     column arrived another way should still leave no NULLs behind. */
  db.exec(`UPDATE events SET audience = 'everyone' WHERE audience IS NULL`);

  /**
   * The discovery query filters open events by audience, and the eligibility
   * check reads `(organization_id, audience)` together on every application.
   */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_audience
      ON events(audience, organization_id)
  `);
}

export default {
  version: 45,
  name: 'event_audience',
  up,
  fileUrl: import.meta.url,
};
