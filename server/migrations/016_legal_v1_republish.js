/**
 * One-time reconciliation of `legal_documents` for the v1.0 launch renumbering.
 *
 * ── The crash this repairs ──
 *
 * `syncLegalDocuments` (consent.js) publishes the catalogue into `legal_documents`
 * on every boot, and a published `(slug, version)` row is immutable by design: if
 * the registry's hash for an existing version differs from the stored one it
 * throws, because a published version whose content changed means the acceptance
 * rows pointing at it describe text nobody agreed to.
 *
 * Renumbering the set to v1.0 for the initial public release collided with that.
 * Five documents had already been published at v1.0 during drafting, and the other
 * five were renumbered onto 1.0 with different content. So `initDatabase()` threw
 * on any database that had booted before:
 *
 *     legal_documents: organizer-agreement@1.0 is already published with a
 *     different content hash.
 *
 * `initDatabase()` is called from server.js with no catch, so the process died at
 * startup — which is why OAuth, the Legal Center and every route appeared to break
 * at once. They had not; the server was not running. A fresh clone worked, which is
 * exactly why the test suite could not see it: `testServer.js` builds a throwaway
 * database per run, so it never has a prior publication to collide with.
 *
 * ── Why this deletes rows, and why that does not weaken the invariant ──
 *
 * The guard protects ACCEPTANCE RECORDS. Its own argument is that a published
 * version's hash "is what the acceptance records point at". A published row that no
 * acceptance points at protects nothing — it is a draft artifact of a platform that
 * had not launched.
 *
 * So this removes exactly those: a row whose (slug, version, hash) triple the
 * registry no longer publishes, **and** which no `legal_acceptances` row
 * references. That second condition is the whole safety property. If any acceptance
 * points at the row it is kept and this throws, rather than quietly rewriting
 * somebody's consent history — which means it is safe to run against a database
 * that HAS launched, where it refuses instead of doing damage.
 *
 * The immutability rule in `syncLegalDocuments` is untouched. After this runs, sync
 * republishes the current registry cleanly and the next version bump is governed by
 * exactly the same rule as before. This migration runs once, by design: it is a
 * launch fixup, not an ongoing licence to edit published documents in place.
 *
 * ── Ordering ──
 *
 * `runMigrations` runs before `syncLegalDocuments` in `initDatabase()`, so the
 * reconciliation happens before the check that was failing. That ordering is
 * load-bearing.
 */
import { LEGAL_DOCUMENTS } from '../legalDocuments.js';

function up(db) {
  // `legal_documents` is created by migration 007. If that has not run there is
  // nothing published and nothing to reconcile.
  const hasTable = db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'legal_documents'"
  ).get().c === 1;
  if (!hasTable) return;

  const current = new Map(LEGAL_DOCUMENTS.map(d => [`${d.slug}@${d.version}`, d.contentHash]));
  const published = db.prepare('SELECT slug, version, content_hash FROM legal_documents').all();

  /**
   * Stale means the registry no longer publishes that exact
   * (slug, version, hash) triple. That covers both shapes of the problem: a
   * version the registry has dropped entirely, and a version it still names but
   * with different content.
   */
  const stale = published.filter(r => current.get(`${r.slug}@${r.version}`) !== r.content_hash);
  if (stale.length === 0) return;

  const acceptances = db.prepare(
    'SELECT COUNT(*) AS c FROM legal_acceptances WHERE document_slug = ? AND version = ?'
  );
  const accepted = stale.filter(r => acceptances.get(r.slug, r.version).c > 0);

  /**
   * Refuse rather than rewrite. On a launched database this is the branch that
   * runs, and stopping the boot is correct: the alternative is deleting the
   * publication record that somebody's recorded consent points at.
   */
  if (accepted.length > 0) {
    const names = accepted.map(r => `${r.slug}@${r.version}`).join(', ');
    throw new Error(
      `Refusing to reconcile legal_documents: ${accepted.length} stale row(s) are referenced by `
      + `recorded acceptances (${names}). Those publications are what the acceptance records point `
      + 'at, so they cannot be removed. Restore the matching content and version in '
      + 'server/legalDocuments.js, or migrate the acceptances deliberately — never delete these rows.'
    );
  }

  const remove = db.prepare('DELETE FROM legal_documents WHERE slug = ? AND version = ?');
  for (const row of stale) remove.run(row.slug, row.version);

  console.log(
    `[Migration 016] Reconciled legal_documents for the v1.0 release: removed ${stale.length} `
    + 'unaccepted draft publication(s). syncLegalDocuments republishes the current registry.'
  );
}

export default {
  version: 16,
  name: 'legal_v1_republish',
  up,
  fileUrl: import.meta.url,
};
