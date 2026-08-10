/**
 * v1.4 — legal text becomes editable without a deploy.
 *
 * ── The problem this solves ──
 *
 * Until now the published text of every policy lived only in
 * `docs/legal/policies/*.md`, pinned by a hash constant in
 * `server/legalDocuments.js`. Correcting a sentence in the Terms meant editing a
 * file, re-running `bin/legal-hashes.mjs`, pasting a constant, and shipping a
 * release. That is the right amount of ceremony for a schema change and the
 * wrong amount for a legal correction, which is exactly the kind of change that
 * has to be possible on a bad afternoon.
 *
 * This table is the override layer. A row here supersedes the file for one slug;
 * with no rows, every read falls back to disk and the system behaves exactly as
 * it did before. That fallback is why this migration needs no backfill — the
 * existing text is already the answer, and copying it into the database at
 * install time would create a second copy to keep in step for no benefit.
 *
 * ── Append-only, and why that is the whole design ──
 *
 * There is no UPDATE path and no DELETE path. Publishing a correction inserts a
 * new row at a higher version and the previous row stays exactly as written.
 *
 * That is not a convenience feature. `legal_acceptances` records the
 * `(slug, version, content_hash)` a person agreed to, and an acceptance record
 * is worth something only if the text it points at can still be produced. If a
 * save overwrote the previous body, every acceptance older than the last edit
 * would name a document nobody could show a court, a parent, or the person who
 * signed it. So the history is not kept in case it is useful later; it is the
 * thing that makes the consent records mean anything at all.
 *
 * It also matches a rule the schema already enforces one layer up:
 * `legal_documents` has primary key `(slug, version)` and `syncLegalDocuments`
 * refuses to republish a version whose hash has moved. A revision table that
 * allowed overwrites would feed that guard contradictory input and fail at boot.
 *
 * ── Why `body` is stored stripped ──
 *
 * The files on disk carry an internal `## Specification` drafting brief above a
 * `## Draft` marker, and `publishedBody()` slices everything after that marker.
 * What is stored here is the published half only — what a reader actually sees.
 * Storing the whole file instead would put the drafting notes in front of
 * whoever edits, and would make `content_hash` cover bytes no reader was shown,
 * which is the one property the hash exists to guarantee.
 *
 * ── Purely additive ──
 *
 * One new table and its index. Nothing is dropped, rebuilt, or rewritten, so
 * `up` is re-runnable and this migration needs none of the six guards that
 * ENGINEERING_GUIDE §8.3 requires of a destructive rebuild.
 */

export default {
  version: 34,
  name: 'legal_document_revisions',
  fileUrl: import.meta.url,

  up(db) {
    /**
     * `slug` carries no foreign key because the document set is a code
     * constant (`LEGAL_DOCUMENTS`), not a table. The write path validates the
     * slug against that registry and refuses an unknown one, so the constraint
     * lives where the registry does rather than being half-expressed here.
     *
     * `created_by` is `ON DELETE SET NULL`, unlike `legal_acceptances.user_id`
     * which is RESTRICT. The difference is deliberate: an acceptance is
     * meaningless without the person, so their row may not be removed while it
     * exists. A revision is meaningful without its author — the text was
     * published and people relied on it — so a deleted account must not be able
     * to take the published Terms down with it. Attribution degrades to
     * "unknown"; the document survives.
     *
     * `effective_at` is a date the owner sets, distinct from `created_at` which
     * the server stamps. A correction can be published on Tuesday and take
     * effect the following Monday, and readers are entitled to see which is
     * which.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS legal_document_revisions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        slug          TEXT    NOT NULL,
        version       TEXT    NOT NULL,
        body          TEXT    NOT NULL,
        content_hash  TEXT    NOT NULL,
        effective_at  TEXT    NOT NULL,
        created_at    TEXT    NOT NULL,
        created_by    TEXT    REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE (slug, version)
      )
    `);

    /**
     * Resolution reads the newest revision for one slug on every document
     * fetch, so this index serves the hot path.
     *
     * Ordered by `id DESC` rather than by `version`, because SQLite would
     * compare version strings lexicographically and rank '1.9.0' above
     * '1.10.0'. Insertion order is the correct ordering here precisely because
     * the write path refuses any version that is not strictly greater than
     * every version already present — so the highest id is the highest version
     * by construction, and the ordering the database can do cheaply happens to
     * be the ordering that is true.
     */
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_legal_revisions_current
        ON legal_document_revisions (slug, id DESC)
    `);
  },
};
