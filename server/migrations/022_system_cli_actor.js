/**
 * Migration 022: the `system-cli` audit actor.
 *
 * ── The problem this solves ──
 *
 * `admin_audit_logs.admin_id` is a foreign key to `users`, and migration 019
 * added a trigger refusing to delete any account that has written an audit row.
 * So the actor column must hold a real account — and a person running a shell
 * script is not one.
 *
 * Every privileged command-line action therefore recorded the SUBJECT as the
 * actor. Read on its own, the row for a bootstrap said "this person granted
 * themselves ownership", which is not what happened. The prose in `details`
 * said otherwise, but `admin_id` is the field a query groups by, and a report
 * that groups by actor attributed every CLI action to its own victim.
 *
 * ── Why a row rather than a nullable column ──
 *
 * Making `admin_id` nullable would let the foreign key go, and with it the
 * deletion protection 019 added — the guarantee that an account cannot be
 * removed while it still has a trail. A reserved row keeps every constraint
 * intact and costs one row that exists only to be pointed at.
 *
 * ── Why it can never be signed into ──
 *
 * `account_status = 'deleted'`, which `authenticateToken` refuses before it
 * looks at anything else, and a `password_hash` that is not a bcrypt hash at
 * all so no candidate can ever compare equal to it. Belt and braces on purpose:
 * this account has no owner to notice if it were ever used.
 *
 * It is deliberately NOT purged by retention. That sweep requires
 * `deleted_at IS NOT NULL` and this row leaves it null, so the account survives
 * while its trail does — and 019's trigger would refuse the delete regardless.
 *
 * ── Why the role is `student` ──
 *
 * The lowest-privilege role that exists. It grants nothing here, because the
 * account cannot authenticate, but a reserved row should not be the one place a
 * future reader finds `super_admin` sitting in a migration.
 */

export const SYSTEM_CLI_ID = 'system-cli';

/** RFC 2606 reserves `.invalid`, so this address can never be routed anywhere. */
const SYSTEM_CLI_EMAIL = 'system-cli@wevolunteer.invalid';

/**
 * Not a bcrypt hash, and not the OAUTH_ONLY sentinel either.
 *
 * `bcrypt.compare` against a string of this shape returns false for every
 * candidate rather than throwing, and the value names itself in any dump so a
 * reader who finds it knows immediately that it is not a credential.
 */
const NO_LOGIN = '!SYSTEM_ACCOUNT_NO_LOGIN!';

export default {
  version: 22,
  name: 'system_cli_actor',
  fileUrl: import.meta.url,

  up(db) {
    /* `OR IGNORE` on the primary key: idempotent, and it will not overwrite the
       row if a later migration ever gives it different columns. */
    db.prepare(`
      INSERT OR IGNORE INTO users (
        id, name, email, username, password_hash, grade, role, verified,
        avatar, bio, school, skills, email_verified, account_status,
        leaderboard_opt_in, email_opt_out, profile_visibility, created_at, token_version
      ) VALUES (?, ?, ?, ?, ?, 'N/A', 'student', 0, ?, ?, ?, ?, 0, 'deleted', 0, 1, 'private', ?, 0)
    `).run(
      SYSTEM_CLI_ID,
      'System (command line)',
      SYSTEM_CLI_EMAIL,
      'system_cli',
      NO_LOGIN,
      '⚙️',
      'Reserved. Records privileged actions performed from the command line, which have no signed-in user to attribute them to.',
      'WeVolunteer',
      JSON.stringify([]),
      new Date().toISOString()
    );
  },
};
