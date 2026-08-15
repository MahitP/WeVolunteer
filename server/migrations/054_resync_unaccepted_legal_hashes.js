/**
 * Lets enforcement start on a database that predates it — without weakening it.
 *
 * ── The situation this exists for ──
 *
 * `LEGAL_HASHES_ENFORCED` was `false` for the whole pre-launch period, and in
 * that mode `syncLegalDocuments` UPDATED `legal_documents.content_hash` to match
 * whatever the file said on each boot. That was the intended behaviour while the
 * documents were being drafted.
 *
 * Turning enforcement on makes the same comparison fatal. So any database that
 * was running before the flag flipped now holds rows pinned to whatever the text
 * happened to be on its last boot — and if a policy has been edited since, the
 * server refuses to start with:
 *
 *   legal_documents: privacy-policy@1.0 is already published with a different
 *   content hash.
 *
 * That refusal is correct and must stay. It is the entire point of the flag: a
 * published version is immutable because its hash is what acceptance records
 * point at, and silently moving it rewrites what people are recorded as having
 * agreed to.
 *
 * ── Why this can be repaired safely, and exactly how far ──
 *
 * The refusal protects ACCEPTANCE RECORDS. Where there are none, there is
 * nothing to protect: a `(slug, version)` that nobody has ever accepted has no
 * reader whose understanding could be rewritten, and its stored hash is simply a
 * stale note about text that was never agreed to by anyone.
 *
 * So this re-syncs exactly those, and refuses to touch anything else. A version
 * with even one acceptance row keeps its hash and keeps blocking the boot, which
 * is the outcome the invariant demands — the remedy there is a version bump, and
 * it should be a deliberate one.
 *
 * Measured on the pilot database before writing this: eleven published
 * documents, one acceptance row in total (`organizer-agreement@1.0`, by an
 * organizer at onboarding), and six documents whose text was rewritten during
 * the release-candidate audit. None of the six had ever been accepted. The one
 * that had was not among them and is left exactly as it is.
 *
 * ── Why a migration rather than a one-off script ──
 *
 * It has to run on every existing database exactly once, before the first boot
 * that enforces — including databases that are not this developer's. A script
 * somebody has to remember to run is a script that gets run on one machine.
 *
 * It is also self-limiting: on a database where the hashes already agree it
 * updates nothing, and after launch — when acceptances exist — it protects them
 * by construction rather than by having already run.
 */
export function up(db) {
  const has = (name) => db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name);

  /* Migration 007 creates both. A database that has not reached it yet has no
     rows to reconcile. */
  if (!has('legal_documents') || !has('legal_acceptances')) return;

  /**
   * Versions with no acceptance at all.
   *
   * Keyed on `(slug, version)` and not on slug: v1.0 of a document may be
   * accepted while a later version is not, and only the unaccepted one may move.
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
   * This migration deliberately does not read the policy files. Recomputing a
   * hash here would put a second implementation of "what is this document's
   * hash" into the schema layer, where it could disagree with `hashPolicyFile`
   * — and a migration that silently disagrees about a legal hash is a worse
   * failure than the one being fixed.
   *
   * `syncLegalDocuments` runs immediately after the migration runner on the same
   * boot and republishes anything missing, using the one implementation that
   * already exists. So the row is removed and re-created correctly seconds
   * later, by the code that owns the question.
   */
  const drop = db.prepare('DELETE FROM legal_documents WHERE slug = ? AND version = ?');
  for (const o of orphans) drop.run(o.slug, o.version);

  console.log(
    `[legal] Re-syncing ${orphans.length} published document version(s) that nobody has accepted, `
    + 'so hash enforcement can be switched on. Accepted versions were left untouched.'
  );
}

export default {
  version: 54,
  name: 'resync_unaccepted_legal_hashes',
  up,
  fileUrl: import.meta.url,
};
