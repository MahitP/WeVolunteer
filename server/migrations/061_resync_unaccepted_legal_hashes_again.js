/**
 * The same repair migration 054 performed, for the documents edited since it ran.
 *
 * ── Why a second one, when 054 says it is "self-limiting" ──
 *
 * 054 is self-limiting in the sense that matters — it can never move a hash
 * anybody has accepted — but it is not self-REPEATING. A migration runs once per
 * database, so it reconciled the drift that existed on the day it ran and
 * nothing after it. Four published policies have been edited since:
 *
 *   16a7a1d  Terms of Service, Privacy Policy, Youth Safety Guidelines and the
 *            Cookie Notice, each corrected where the published text disagreed
 *            with the software. Its own message records the disposition: these
 *            are pre-launch corrections, so "versions stay at 1.0 and only the
 *            pinned hashes move", which is the rule written down under
 *            "Versioning — read before publishing" in
 *            docs/legal/policies/README.md.
 *   386c9e9  The Privacy Policy again, naming Upstash as a subprocessor, taken
 *            to 1.1 — a NEW (slug, version), so that one publishes cleanly and
 *            is not what this is about.
 *
 * So three documents now pin a hash that differs from the one an existing
 * database published at the same version, and `syncLegalDocuments` refuses the
 * boot. Measured on the pilot database before writing this: thirteen published
 * documents, one acceptance row in total — `organizer-agreement@1.0`, whose text
 * has not changed — and none of the three edited documents has ever been
 * accepted by anybody.
 *
 * ── Why this is a repair and not a weakening ──
 *
 * Every word of 054's reasoning applies unchanged, so it is not restated here:
 * the refusal protects ACCEPTANCE RECORDS, and a `(slug, version)` nobody has
 * accepted has no reader whose understanding could be rewritten. This re-syncs
 * exactly those and refuses to touch anything else. A version with even one
 * acceptance row keeps its hash and keeps blocking the boot — which is the
 * outcome the invariant demands, and there the remedy is a deliberate version
 * bump, not a migration.
 *
 * The organizer agreement is the live demonstration: it is the one accepted
 * document in the pilot database, and this migration leaves it exactly as it is.
 *
 * ── Why this is the right shape, rather than editing the documents ──
 *
 * The alternative is bumping the three to 1.1, and the repository's own rule
 * forbids it: "Every document is at version 1.0, and stays there until
 * launch… Do not bump a version to record a pre-launch wording fix." A bump
 * would also tell the first real reader they are looking at the second revision
 * of a contract whose first revision nobody can produce — the precise misleading
 * answer the v1.0 reset was performed to avoid.
 *
 * ── Why a migration rather than a one-off script ──
 *
 * 054's answer, unchanged: it has to run on every existing database exactly
 * once, before the first boot that would otherwise refuse — including databases
 * that are not this developer's. A script somebody has to remember to run is a
 * script that gets run on one machine.
 *
 * ── After launch ──
 *
 * This stops being available by construction rather than by policy. Once real
 * people have accepted these documents, every row this looks for has an
 * acceptance and the query returns nothing, so a post-launch edit still stops
 * the boot and still has to be a version bump. That is the invariant, and
 * nothing here touches it.
 */
/**
 * Is the table there? Asked in SQL that both engines speak.
 *
 * 054 asks this with `SELECT name FROM sqlite_master …`, and a sixteenth copy of
 * that is precisely the growth `sqliteDialect.test.js` exists to refuse — it
 * counts SQLite-only constructs across the tree and fails when the total rises,
 * because "a migration that pauses and quietly gets larger is one that never
 * finishes". Raising its number to add a guard would spend the PostgreSQL port's
 * budget rather than pay into it.
 *
 * `SELECT 1 FROM <table> LIMIT 0` needs no dialect at all: it is valid
 * everywhere, plans nothing, returns nothing, and raises on a missing relation —
 * which is the whole question. So the guard costs the ratchet zero and works on
 * both engines rather than only one.
 *
 * The first version of this migration had no SQLite guard, on the reasoning that
 * migrations apply in ascending order so 007 has always run. That is true of the
 * RUNNER and not of `up()`, which `legalResyncUnaccepted.test.js` calls directly
 * for exactly this case against 054 — and an adversarial probe during the
 * hardening pass duly got `no such table: legal_documents` out of it. A
 * migration should survive a database that stops short of it.
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
   * unaccepted one may move. The Privacy Policy is exactly that shape now —
   * 1.0 published, 1.1 pinned — and only the row nobody holds may be touched.
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
   * the same boot and republishes anything missing, using the one implementation
   * that owns the question.
   */
  const drop = db.prepare('DELETE FROM legal_documents WHERE slug = ? AND version = ?');
  for (const o of orphans) drop.run(o.slug, o.version);

  console.log(
    `[legal] Re-syncing ${orphans.length} published document version(s) that nobody has accepted, `
    + 'after the pre-launch corrections in 16a7a1d. Accepted versions were left untouched.'
  );
}

/**
 * The same repair on PostgreSQL.
 *
 * 054 has no PostgreSQL half because it sits below the generated baseline; this
 * one is above it, so the migration contract requires one and
 * `migrations.postgres.test.js` enforces that.
 *
 * ── Why one statement rather than the select-then-delete above ──
 *
 * The SQLite half reads the orphans first only so it can name how many it
 * cleared, and `node:sqlite` is synchronous so that costs nothing. Here the same
 * shape would be two round trips and a window between them; `DELETE … WHERE NOT
 * EXISTS` is the identical predicate evaluated once, atomically, and the driver
 * reports how many rows went. The predicate is the thing that must match between
 * the two engines, and it is character-for-character the same.
 *
 * ── The table guard is needed here too ──
 *
 * This first shipped without one, on the reasoning that a PostgreSQL database is
 * created from `postgresSchema.js`, which defines both tables in the baseline,
 * so none could be old enough to lack them. `migrations.postgres.test.js`
 * refuted it immediately: it provisions a database from a PARTIAL baseline to
 * check that post-baseline migrations apply in isolation, and there
 * `legal_documents` genuinely does not exist. A migration must survive a
 * database that stops short of it, which is the same reason the SQLite half
 * checks, and `to_regclass` is the PostgreSQL spelling of that question.
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
    + 'after the pre-launch corrections in 16a7a1d. Accepted versions were left untouched.'
  );
}

export default {
  version: 61,
  name: 'resync_unaccepted_legal_hashes_again',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
