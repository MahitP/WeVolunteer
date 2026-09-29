/**
 * The same repair 054, 061, 064, 068, 069 and 070 performed, for the Cookie and
 * Tracking Notice after Cloudflare was disclosed.
 *
 * ── What drifted, and why ──
 *
 * Two things, and the second was there before this change.
 *
 * The owner chose on 2026-09-29 to keep Cloudflare Web Analytics rather than
 * switch it off, so the CSP now admits the beacon. That sends client-side page
 * and timing data to Cloudflare, and the notice named no such recipient.
 *
 * The larger problem it exposed: **Cloudflare was already undisclosed.** It
 * proxies every request and terminates TLS, so it has always seen every
 * student's IP, page and user agent — the most unavoidable third party in the
 * stack, named in neither this notice nor the Privacy Policy. Allowing the
 * beacon did not create that gap. It made it impossible to keep ignoring.
 *
 * The notice's opening line also claimed nothing is shared unless you switch it
 * on, with no exception. That was already untrue of the proxy and is corrected
 * here rather than left standing next to a new section that contradicts it.
 *
 * ── Why this is safe, and what would make it unsafe ──
 *
 * 054's reasoning, unchanged: the refusal protects ACCEPTANCE RECORDS, and a
 * `(slug, version)` nobody has accepted has no reader whose understanding could
 * be rewritten. Measured against the live database before writing this: four
 * acceptance rows in total — `terms-of-service@1.0`, `privacy-policy@1.0`,
 * `community-guidelines@1.0` and `admin-responsibilities-policy@1.0` — and
 * `cookie-and-tracking-notice` has never been accepted by anybody. A version
 * with even one acceptance row keeps its hash and keeps blocking the boot,
 * which is the outcome the invariant demands.
 *
 * **The privacy policy is ALSO missing Cloudflare and was deliberately NOT
 * touched.** It carries an acceptance row, and that row belongs to a student —
 * a minor who read a page and agreed to it on 2026-09-14. Rewriting the words
 * underneath somebody's consent is a decision about a consent record, not a
 * migration, and it is the owner's to make with the reset that launch provides.
 * This migration must not become the mechanism for it: the slug list below is
 * the boundary, exactly as 069 said when it declined the same thing for the
 * CARTO passage.
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
    + 'after Cloudflare was disclosed in the Cookie and Tracking Notice. '
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
    + 'after Cloudflare was disclosed in the Cookie and Tracking Notice. '
    + 'Accepted versions were left untouched.'
  );
}

export default {
  version: 71,
  name: 'resync_cookie_notice_cloudflare',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
