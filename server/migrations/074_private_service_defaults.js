/**
 * Existing service records become private, as the published documents said
 * they already were.
 *
 * ── What was wrong ──
 *
 * The Privacy Policy ("You have to turn sharing on; we will never turn it on for
 * you"), the Community Guidelines and the Youth Safety Guidelines ("Nobody sees
 * it unless the student changed that") all promise a profile is private until
 * the student turns sharing on. Migration 049 added `hours_visibility` and
 * `certificates_visibility` with `DEFAULT 'public'`, so every student's hours
 * and certificates were shown to every member — other students, organizers and
 * administrators — from the day their account was created.
 *
 * The owner chose to make the code true rather than the documents, for new AND
 * existing accounts (2026-10-04, docs/legal/15-PROFILE-VISIBILITY-DEFAULTS.md).
 * New accounts are handled at the INSERT; see DEFAULT_SERVICE_VISIBILITY in
 * server/serviceVisibility.js for why not in the schema. This migration is the
 * existing half.
 *
 * ── Why every account, including one that chose 'public' ──
 *
 * Nothing records whether somebody CHOSE public or simply received it: the
 * column has a DEFAULT, there is no timestamp on the preference and no audit
 * row when it changes. So the two cannot be told apart, and the only reading
 * consistent with what every one of them was told is private. It fails safe —
 * the student can turn either setting back on in one click — where the
 * opposite reading would leave the promise false for everybody who never
 * opened Settings, which is nearly everybody.
 *
 * ── The one exemption ──
 *
 * The founder, by the owner's decision. His record is one he shows to colleges
 * and asked to keep shown; flipping it would hide a page he relies on to make a
 * point he did not ask anybody to make. Matched on the address in
 * `ownerAllowlist.js`, the same identity the profile's founder layout reads,
 * and nothing else — not role, which the platform account shares.
 *
 * ── Idempotent ──
 *
 * Setting 'private' on a row that is already private changes nothing, so a
 * re-run by hand is harmless. Like every migration it runs once per database,
 * which is the point: a student who turns their hours back on afterwards is
 * making the choice this restores to them, and nothing here will undo it.
 */
import { FOUNDER_EMAIL } from '../ownerAllowlist.js';

/* `COALESCE` on the address because an anonymised account can carry none, and
   `NULL <> ?` is NULL rather than true — the row would be skipped and left
   public by an accident of three-valued logic. The same on the two settings, so
   the count reports rows that actually changed and a re-run reports none. */
const FLIP = `
  UPDATE users
     SET hours_visibility = 'private', certificates_visibility = 'private'
   WHERE COALESCE(LOWER(TRIM(email)), '') <> ?
     AND (COALESCE(hours_visibility, '') <> 'private'
          OR COALESCE(certificates_visibility, '') <> 'private')
`;

const report = (changed) => {
  if (!changed) return;
  console.log(
    `[privacy] ${changed} account(s) now keep their service history and certificates private, `
    + 'as the published documents promise. The founder\'s account was left as it was.'
  );
};

/* A probe rather than `PRAGMA table_info`, for the reason 073 gives. */
function hasColumns(db) {
  try {
    db.prepare('SELECT hours_visibility, certificates_visibility FROM users LIMIT 0').all();
    return true;
  } catch {
    return false;
  }
}

export function up(db) {
  if (!hasColumns(db)) return;
  report(db.prepare(FLIP).run(FOUNDER_EMAIL).changes ?? 0);
}

/* `information_schema` rather than a failing probe: on PostgreSQL a statement
   that errors aborts the migration's transaction, so a try/catch probe would
   poison everything after it. Every PostgreSQL database has both columns — the
   baseline schema carries them — but the check costs one query. */
async function postgresUp(db) {
  const [{ count }] = await db.prepare(`
    SELECT COUNT(*) AS count FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'users'
       AND column_name IN ('hours_visibility', 'certificates_visibility')
  `).all();
  if (Number(count) < 2) return;
  const result = await db.prepare(FLIP).run(FOUNDER_EMAIL);
  report(result?.changes ?? 0);
}

export default {
  version: 74,
  name: 'private_service_defaults',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
