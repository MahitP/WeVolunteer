/**
 * The same repair migrations 054 and 061 performed, for one bullet in the
 * Privacy Policy's guardian section.
 *
 * ── What changed, and why it needed changing ──
 *
 * The guardian section listed, under a "Specifically:" lead-in about guardian
 * consent:
 *
 *   "We **do not send a confirmation link** to anybody, and nothing waits for
 *    an approval."
 *
 * Scoped by that lead-in it was accurate. Read alone — which is how a bullet is
 * read — it made two claims about the whole application that are false: this
 * platform does send links (email verification, password reset, administrator
 * and organization invitations) and does have approval workflows (event
 * applications, and now organization join requests). The bullet now names the
 * guardian in its own sentence:
 *
 *   "We **do not send a guardian a confirmation link**, and no part of your
 *    account waits for a guardian's approval."
 *
 * Same commitment, no broader claim. `legalContent.guardianScope.test.js` is
 * what stops the absolute form returning.
 *
 * ── Why this is a repair and not a weakening ──
 *
 * Migration 054 carries that argument in full and 061 declines to restate it;
 * this declines too. In short: the boot refusal protects ACCEPTANCE RECORDS,
 * and a `(slug, version)` nobody has accepted has no reader whose understanding
 * could be rewritten. This re-syncs exactly those and refuses to touch anything
 * else. A version with even one acceptance row keeps its hash and keeps
 * blocking the boot, which is the outcome the invariant demands — and there the
 * remedy is a deliberate version bump, not a migration.
 *
 * Measured on the development database before writing this: `privacy-policy@1.0`
 * published with the old hash, one acceptance row in the whole table
 * (`organizer-agreement@1.0`, whose text has not changed), and the Privacy
 * Policy accepted by nobody. `syncLegalDocuments` duly refused the boot, which
 * is what this exists to clear.
 *
 * ── Why the version stays at 1.0 ──
 *
 * "Do not bump a version to record a pre-launch wording fix" — the rule under
 * "Versioning — read before publishing" in `docs/legal/policies/README.md`,
 * which 061 quotes for the same reason. Nothing here has been published to a
 * real person, so this is a draft being corrected rather than a contract being
 * revised, and `effectiveAt` is unchanged for the same reason.
 *
 * ── Why a third migration rather than making 061 re-run ──
 *
 * A migration runs once per database, by design. 061 reconciled the drift that
 * existed on the day it ran; this one exists because a later edit created more.
 * That is not a flaw in the shape — it is what makes each one auditable: the
 * commit that edits a document carries the migration that reconciles it, and
 * the pair is the record of what moved and why.
 *
 * ── After launch ──
 *
 * This stops being available by construction rather than by policy. Once real
 * people have accepted these documents, every row the predicate looks for has an
 * acceptance and it returns nothing — so a post-launch edit still stops the boot
 * and still has to be a version bump. Nothing here touches that invariant.
 */

/**
 * Is the table there? Asked in SQL both engines speak.
 *
 * 061's reasoning, unchanged: `SELECT 1 FROM <table> LIMIT 0` is valid
 * everywhere, plans nothing, and raises on a missing relation — so it costs the
 * `sqliteDialect.test.js` ratchet nothing, where a sixteenth
 * `SELECT name FROM sqlite_master` would spend the PostgreSQL port's budget.
 *
 * Needed because `up()` is called directly by tests, not only through the
 * runner — a database that stops short of migration 007 has neither table.
 */
function missingLegalTables(db) {
  for (const table of ['legal_documents', 'legal_acceptances']) {
    try {
      db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
    } catch {
      return true;
    }
  }
  return false;
}

export function up(db) {
  /* Migration 007 creates both. A database that has not reached it yet has no
     rows to reconcile. */
  if (missingLegalTables(db)) return;

  /**
   * Versions with no acceptance at all.
   *
   * Keyed on `(slug, version)` and not on slug, for 054's reason: v1.0 of a
   * document may be accepted while a later version is not, and only the
   * unaccepted one may move.
   */
  const orphans = db.prepare(`
    SELECT d.slug, d.version
      FROM legal_documents d
     WHERE NOT EXISTS (
       SELECT 1 FROM legal_acceptances a
        WHERE a.document_slug = d.slug
          AND a.version = d.version
     )
  `).all();

  if (orphans.length === 0) return;

  /**
   * Cleared rather than rewritten to a computed value.
   *
   * 054's reasoning, which has not changed: recomputing a hash here would put a
   * second implementation of "what is this document's hash" into the schema
   * layer, where it could disagree with `hashPolicyFile` — and a migration that
   * silently disagrees about a legal hash is a worse failure than the one being
   * fixed. `syncLegalDocuments` runs immediately after the migration runner on
   * the same boot and republishes anything missing, using the one
   * implementation that owns the question.
   */
  const drop = db.prepare('DELETE FROM legal_documents WHERE slug = ? AND version = ?');
  for (const o of orphans) drop.run(o.slug, o.version);

  console.log(
    `[legal] Re-syncing ${orphans.length} published document version(s) that nobody has accepted, `
    + 'after scoping the guardian-consent bullet in the Privacy Policy. '
    + 'Accepted versions were left untouched.'
  );
}

/**
 * The same repair on PostgreSQL.
 *
 * Above `POSTGRES_BASELINE_VERSION`, so the migration contract requires this
 * half and `migrations.postgres.test.js` enforces that it exists.
 *
 * One statement rather than 061's select-then-delete: the SQLite half reads
 * first only so it can name how many it cleared, and `node:sqlite` is
 * synchronous so that costs nothing. Here the same shape would be two round
 * trips and a window between them. The PREDICATE is the thing that must match
 * between the engines, and it is character-for-character the same.
 *
 * `to_regclass` is the PostgreSQL spelling of the table guard, for the reason
 * 061 records: `migrations.postgres.test.js` provisions from a PARTIAL baseline
 * to check that post-baseline migrations apply in isolation, and there
 * `legal_documents` genuinely does not exist.
 */
async function postgresUp(db) {
  const [present] = await db.prepare(`
    SELECT to_regclass('legal_documents')   IS NOT NULL AS documents,
           to_regclass('legal_acceptances') IS NOT NULL AS acceptances
  `).all();
  if (!present?.documents || !present?.acceptances) return;

  const removed = await db.prepare(`
    DELETE FROM legal_documents d
     WHERE NOT EXISTS (
       SELECT 1 FROM legal_acceptances a
        WHERE a.document_slug = d.slug
          AND a.version = d.version
     )
    RETURNING d.slug
  `).all();

  if (removed.length === 0) return;

  console.log(
    `[legal] Re-syncing ${removed.length} published document version(s) that nobody has accepted, `
    + 'after scoping the guardian-consent bullet in the Privacy Policy. '
    + 'Accepted versions were left untouched.'
  );
}

export default {
  version: 64,
  name: 'resync_guardian_scope_hash',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
