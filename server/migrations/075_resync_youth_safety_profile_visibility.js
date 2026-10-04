/**
 * Re-publishes the Youth Safety Guidelines after their parents' section was
 * corrected — and only if nobody has accepted them.
 *
 * ── What was wrong ──
 *
 * "Their profile is private by default. Nobody sees it unless the student
 * changed that." A profile is findable by name, so the second sentence was
 * false at every setting; and until migration 074, a student's hours and
 * certificates were visible to every member by default as well. It is the
 * sentence written for a guardian, and under Posture B every published promise
 * is one the operator answers for personally
 * (docs/legal/15-PROFILE-VISIBILITY-DEFAULTS.md).
 *
 * The replacement says who can see a student (other members, adult organizers
 * included), what they see (name, username, picture, clubs, when they joined)
 * and what stays hidden until the student shows it. `legalContent.
 * profileVisibility.test.js` holds those words against what the serializer
 * actually emits.
 *
 * ── Why a repair and not a version ──
 *
 * The same reasoning as 069, 070 and 071, and the same two conditions. The
 * document is a `notice`: it has never collected an acceptance, so there is no
 * reader whose agreement is being rewritten, and the pre-launch rule keeps it
 * at 1.0. The owner approved repairing it in place on 2026-10-04.
 *
 * The Privacy Policy and the Community Guidelines make the same promise and are
 * deliberately NOT here. Each holds an acceptance, so neither can be repaired
 * underneath it; migration 074 is what made their wording true instead.
 *
 * Both conditions are kept independently. The slug list bounds what may be
 * considered; the acceptance check is what makes touching it safe.
 */

const CORRECTED = [
  ['youth-safety-guidelines', '1.0'],
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

const report = (cleared) => {
  if (cleared === 0) return;
  console.log(
    `[legal] Re-syncing ${cleared} published document version(s) that nobody has accepted, `
    + 'after the Youth Safety Guidelines stopped telling guardians nobody sees a profile. '
    + 'Accepted versions were left untouched.'
  );
};

export function up(db) {
  if (missingLegalTables(db)) return;

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
  report(cleared);
}

async function postgresUp(db) {
  const [present] = await db.prepare(`
    SELECT to_regclass('legal_documents')   IS NOT NULL AS documents,
           to_regclass('legal_acceptances') IS NOT NULL AS acceptances
  `).all();
  if (!present?.documents || !present?.acceptances) return;

  const removed = await db.prepare(`
    DELETE FROM legal_documents d
     WHERE (d.slug, d.version) IN (
             ('youth-safety-guidelines', '1.0')
           )
       AND NOT EXISTS (
         SELECT 1 FROM legal_acceptances a
          WHERE a.document_slug = d.slug
            AND a.version = d.version
       )
    RETURNING d.slug
  `).all();
  report(removed.length);
}

export default {
  version: 75,
  name: 'resync_youth_safety_profile_visibility',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
