/**
 * The same repair 054, 061, 064 and 068 performed, for the Cookie and Tracking
 * Notice after its map section was corrected.
 *
 * ── What drifted, and why ──
 *
 * The notice told the reader that map images were loaded by their browser
 * directly from CARTO, that CARTO could therefore see their IP address and
 * roughly which event location they were looking at, and closed by saying we
 * were looking at whether to serve the images ourselves.
 *
 * That work was done and shipped. `server/routes/tileRoutes.js` proxies every
 * tile through this application, precisely so the provider never sees a
 * student's device, and with `MAP_TILES_CARTO_KEY` unset — which is how
 * production runs — the upstream is OpenStreetMap. So the published notice
 * disclosed a third-party exposure that no longer exists.
 *
 * Wrong in the safe direction, and still wrong: a privacy notice that overstates
 * what leaves the reader's device is not harmless, because it is the document
 * somebody reads to decide whether to let their child use this. It now describes
 * the arrangement that actually runs.
 *
 * ── Why this is safe, and what would make it unsafe ──
 *
 * 054's reasoning, unchanged: the refusal protects ACCEPTANCE RECORDS, and a
 * `(slug, version)` nobody has accepted has no reader whose understanding could
 * be rewritten. Measured against the live database before writing this:
 * thirteen published documents, three acceptance rows in total —
 * `terms-of-service@1.0`, `privacy-policy@1.0` and `community-guidelines@1.0`,
 * all held by one account — and `cookie-and-tracking-notice` has never been
 * accepted by anybody. A version with even one acceptance row keeps its hash
 * and keeps blocking the boot, which is the outcome the invariant demands.
 *
 * **The privacy policy carries the same CARTO passage and was deliberately NOT
 * touched**, precisely because it has an acceptance row. Correcting it is a
 * decision about a consent record rather than a migration, and it is the
 * owner's to make. This migration must not become the mechanism for it: the
 * slug list below is the boundary.
 *
 * ── Why the row is cleared rather than rewritten ──
 *
 * 054's reasoning again: recomputing a hash here would put a second
 * implementation of "what is this document's hash" into the schema layer, where
 * it could disagree with `hashPolicyFile`. `syncLegalDocuments` runs immediately
 * after the migration runner on the same boot and republishes anything missing,
 * using the one implementation that owns the question.
 */

/** The one document corrected. Nothing else may be touched. */
const CORRECTED = [
  ['cookie-and-tracking-notice', '1.0'],
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

  /* Both conditions, independently — the slug list bounds what may be
     considered, the acceptance check is what makes touching it safe. */
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
    + 'after the Cookie and Tracking Notice map-section correction. '
    + 'Accepted versions were left untouched.'
  );
}

/**
 * The same repair on PostgreSQL. Above `POSTGRES_BASELINE_VERSION`, so the
 * migration contract requires this half and `migrations.postgres.test.js`
 * enforces that it exists.
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
             ('cookie-and-tracking-notice', '1.0')
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
    + 'after the Cookie and Tracking Notice map-section correction. '
    + 'Accepted versions were left untouched.'
  );
}

export default {
  version: 69,
  name: 'resync_cookie_notice_map_section',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
