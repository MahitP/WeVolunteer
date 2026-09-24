/**
 * The same repair 054, 061 and 064 performed, for the two documents corrected
 * by the 2026-09-21 full-system audit.
 *
 * ── What drifted, and why ──
 *
 * The audit corrected two published policies where the text disagreed with the
 * software, and re-pinned their hashes in the same commits:
 *
 *   d776b72  The Certificate Verification Policy and the Volunteer Record
 *            Policy. Both told a reader to ask the organizer if a record was
 *            wrong and named no point after which that stops working, while
 *            `finalizeAttendance` has refused every correction on a closed-out
 *            event since 32e6880.
 *   a905997  The Volunteer Record Policy again, publishing the rule that a
 *            cancelled event's hours stop counting — true and enforced at ~30
 *            call sites since b8cfb09, and stated nowhere a reader could find.
 *
 * Both are pre-launch corrections, so versions stay at 1.0 and only the pinned
 * hashes move — the rule written down under "Versioning — read before
 * publishing" in `docs/legal/policies/README.md`. An existing database
 * published those two at 1.0 with the OLD hashes, so `syncLegalDocuments`
 * reaches its mismatch branch and, with `LEGAL_HASHES_ENFORCED` on, refuses the
 * boot. That is the invariant working: it is what stops a published version
 * being rewritten underneath an acceptance record.
 *
 * ── Why this is a repair and not a weakening ──
 *
 * 054's reasoning, unchanged: the refusal protects ACCEPTANCE RECORDS, and a
 * `(slug, version)` nobody has accepted has no reader whose understanding could
 * be rewritten. Measured against the live database before writing this:
 * thirteen published documents, three acceptance rows in total —
 * `terms-of-service@1.0`, `privacy-policy@1.0` and `community-guidelines@1.0` —
 * and NEITHER corrected document has ever been accepted by anybody. A version
 * with even one acceptance row keeps its hash and keeps blocking the boot,
 * which is the outcome the invariant demands; there the remedy is a deliberate
 * version bump, not a migration.
 *
 * ── Why it names the two slugs, where 061 and 064 did not ──
 *
 * Those two cleared every unaccepted row, which is safe — an unaccepted row
 * that has not drifted is republished byte-identically on the same boot. This
 * one is narrower on purpose: the audit established exactly two drifted
 * documents out of thirteen, and a migration that names them cannot become a
 * general "rewrite any legal document" mechanism if a later hash moves for a
 * reason nobody reviewed. Narrower than precedent is the safe direction, and
 * the acceptance guard is kept as well as the slug list rather than instead of
 * it, so the two conditions are independent.
 *
 * The scope was checked rather than assumed: every one of the other eleven
 * documents' stored hashes matches the registry, so clearing these two is
 * sufficient to let the boot proceed.
 *
 * ── Why the rows are cleared rather than rewritten ──
 *
 * 054's reasoning again: recomputing a hash here would put a second
 * implementation of "what is this document's hash" into the schema layer, where
 * it could disagree with `hashPolicyFile` — and a migration that silently
 * disagrees about a legal hash is a worse failure than the one being fixed.
 * `syncLegalDocuments` runs immediately after the migration runner on the same
 * boot and republishes anything missing, using the one implementation that owns
 * the question.
 */

/** The two documents the audit corrected. Nothing else may be touched. */
const CORRECTED = [
  ['certificate-verification-policy', '1.0'],
  ['volunteer-record-policy', '1.0'],
];

/* Migration 007 creates both. A database that has not reached it yet has no
   rows to reconcile. */
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
  if (missingLegalTables(db)) return;

  /**
   * Both conditions, independently.
   *
   * The slug list bounds what this migration is allowed to consider; the
   * acceptance check is what makes touching it safe. Either alone would be
   * weaker than the pair — a slug list without the guard could move a hash
   * somebody holds, and the guard without the list is the general mechanism
   * this deliberately is not.
   */
  const drop = db.prepare(`
    DELETE FROM legal_documents
     WHERE slug = ? AND version = ?
       AND NOT EXISTS (
         SELECT 1 FROM legal_acceptances a
          WHERE a.document_slug = legal_documents.slug
            AND a.version = legal_documents.version
       )
  `);

  let cleared = 0;
  for (const [slug, version] of CORRECTED) cleared += drop.run(slug, version).changes ?? 0;

  if (cleared === 0) return;

  console.log(
    `[legal] Re-syncing ${cleared} published document version(s) that nobody has accepted, `
    + 'after the policy corrections in d776b72 and a905997. '
    + 'Accepted versions were left untouched.'
  );
}

/**
 * The same repair on PostgreSQL.
 *
 * Above `POSTGRES_BASELINE_VERSION`, so the migration contract requires this
 * half and `migrations.postgres.test.js` enforces that it exists.
 *
 * One statement rather than the loop above: the SQLite half loops only because
 * `node:sqlite` is synchronous and counting per slug costs nothing there. The
 * PREDICATE is the thing that must match between the engines, and it is the
 * same pair of conditions.
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
     WHERE (d.slug, d.version) IN (
             ('certificate-verification-policy', '1.0'),
             ('volunteer-record-policy', '1.0')
           )
       AND NOT EXISTS (
         SELECT 1 FROM legal_acceptances a
          WHERE a.document_slug = d.slug
            AND a.version = d.version
       )
    RETURNING d.slug
  `).all();

  if (removed.length === 0) return;

  console.log(
    `[legal] Re-syncing ${removed.length} published document version(s) that nobody has accepted, `
    + 'after the policy corrections in d776b72 and a905997. '
    + 'Accepted versions were left untouched.'
  );
}

export default {
  version: 68,
  name: 'resync_audit_corrected_legal_hashes',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
