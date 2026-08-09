/**
 * A high-water mark for TOTP time steps, so a code cannot be used twice.
 *
 * ── What this closes ──
 *
 * RFC 6238 §5.2 requires a verifier to refuse a second use of the same one-time
 * code. Nothing here did: within a code's validity window it could be presented
 * repeatedly, so an intercepted code could be replayed to mint a second session.
 *
 * That mattered little while `verifyTotp` accepted only the current 30-second
 * step, and it matters more now that a previous step is accepted to stop correct
 * codes being rejected over ordinary latency. The tolerance and this column ship
 * together, and the pair is a net improvement on either previous state — see
 * `TOTP_EPOCH_TOLERANCE` in `server/cryptoUtils.js` and `server/totpReplay.js`.
 *
 * ── Why one integer rather than a table of used codes ──
 *
 * TOTP counters only move forward. Refusing anything at or below the last accepted
 * step makes the current code single-use AND every earlier code permanently
 * unusable, with one column and nothing to expire. A `used_codes` table would need
 * a retention sweep, and this platform already carries two tables that lack one.
 *
 * ── Why a MIGRATION and not `addColumnIfMissing` ──
 *
 * It was written as an additive guard first, which was wrong, and the failure was
 * instructive: that pass runs BEFORE the registry, and migration `001_authz_roles`
 * rebuilds `users` with an explicit column list plus an unknown-column guard. A
 * new column present at that moment is one the rebuild would silently drop, so the
 * guard refuses to run and names the remedy. Every other TFA column arrived the
 * same way this one now does — by a migration that runs after the rebuild — which
 * is why none of them appears in `EXPECTED_USER_COLUMNS`.
 *
 * ── Additive only ──
 *
 * One nullable column. NULL means "nothing accepted yet" and must never be read as
 * step zero: `counter <= 0` is false for every real counter, so a NULL treated as
 * zero would make the replay check pass vacuously. `totpReplay.js` tests `!= null`
 * for exactly that reason.
 */
export default {
  version: 29,
  name: 'totp_replay_high_water',
  fileUrl: import.meta.url,

  up(db) {
    const columns = new Set(
      db.prepare('PRAGMA table_info(users)').all().map((c) => c.name),
    );

    if (!columns.has('tfa_last_counter')) {
      db.exec('ALTER TABLE users ADD COLUMN tfa_last_counter INTEGER');
    }
  },
};
