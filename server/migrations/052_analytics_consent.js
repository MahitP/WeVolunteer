/**
 * Whether this person has agreed to be measured.
 *
 * ── Why a column and not a cookie ──
 *
 * WeVolunteer already answers every other privacy question per account:
 * `profile_visibility`, `leaderboard_opt_in`, `hours_visibility`,
 * `certificates_visibility`, `friend_activity_visible`. A telemetry answer kept
 * in browser storage would be the only one that did not follow the person to a
 * different device, and the only one a student could not find in Settings
 * beside the others. It would also be lost by the act of clearing site data,
 * which is the thing a privacy-conscious person does.
 *
 * ── Three states, not two ──
 *
 *   NULL   never asked. Analytics OFF.
 *   0      declined.    Analytics OFF.
 *   1      granted.     Analytics ON.
 *
 * "Has not answered" and "said no" are different facts and only one of them may
 * ever be re-prompted. Collapsing them into a boolean loses exactly the
 * distinction that makes a consent record a consent record — a default `0`
 * would be indistinguishable from a person who declined, and a default `1`
 * would be consent nobody gave.
 *
 * ── Why the default is not `1` ──
 *
 * Every other column added to `users` in this project has defaulted towards the
 * behaviour that was already in place, and migration 049 says so explicitly
 * about `hours_visibility`. This one deliberately does the opposite, because
 * the behaviour already in place is the thing being corrected: Session Replay
 * was recording every session of a platform whose users are minors, and the
 * published Cookie and Tracking Notice told them it was not. Carrying that
 * forward as a default would be reading consent into a state nobody was ever
 * asked about.
 *
 * So: no DEFAULT clause at all. Existing rows get NULL, which is "not asked",
 * which is off. Nothing is recorded until somebody says yes.
 *
 * ── No CHECK constraint ──
 *
 * Same reason as migration 049: SQLite cannot add one with `ALTER TABLE`, and
 * `users` is the most foreign-keyed table in the schema. The values are
 * enforced where they are written (`userRoutes.js` accepts only a boolean) and,
 * more importantly, where they are READ: `selfUserResponse` treats anything
 * that is not exactly `1` as "no consent", so a corrupted value fails towards
 * collecting nothing.
 */
export function up(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  /* A database so early that `users` does not exist yet — the bootstrap in
     db.js creates it with this column already present. Same guard as 049. */
  if (columns.length === 0) return;

  const have = new Set(columns.map((c) => c.name));
  if (!have.has('analytics_consent')) {
    db.exec('ALTER TABLE users ADD COLUMN analytics_consent INTEGER');
  }

  /* Deliberately no backfill. NULL is the correct value for every existing
     row: none of these people has been asked. */
}

export default {
  version: 52,
  name: 'analytics_consent',
  up,
  fileUrl: import.meta.url,
};
