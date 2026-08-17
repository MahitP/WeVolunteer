/**
 * Promote an existing account to `admin`.
 *
 * ── Why this script refuses far more than it used to ──
 *
 * It used to guard exactly one case — `if (user.role === 'admin')` — and then run
 * an unconditional `UPDATE users SET role = 'admin'`. Against any other role that
 * overwrote whatever was there, printed "Successfully promoted", and exited 0.
 *
 * Run against a `super_admin`, that silently DEMOTED the platform owner to an
 * ordinary administrator. No confirmation, no warning, no audit row, and a
 * success message. The one command intended to grant privilege was also the
 * quietest way to destroy it.
 *
 * That was harmless only for as long as no `super_admin` existed. The ownership
 * bootstrap is precisely what arms it, which is why this fix lands before the
 * bootstrap runs rather than after.
 *
 * ── The rule ──
 *
 * Promotion is now an ALLOWLIST, not a filter. Only the two self-assignable roles
 * may be promoted; every other role — including ones that do not exist yet — is
 * refused by default with a non-zero exit. A new role added to the product is
 * therefore unpromotable until someone deliberately decides it should be, which is
 * the failure direction we want.
 *
 * `server/authz.js` holds the same list as SELF_ASSIGNABLE_ROLES, but this file
 * deliberately does not import it: this script runs against a database file with
 * no server booted, and the reason the two lists agree is that they answer the
 * same question, not that one is derived from the other. `make-admin.test.js`
 * asserts they have not drifted.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { recordCliAudit, assertSystemActor, CLI_EVENTS } from './cliAudit.mjs';
import { openPrivilegedDb } from './resolveDb.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/* Path resolution, `.env` loading and the refusal to create a database all
   live in resolveDb.mjs — see the incident recorded there. */

/**
 * The only roles this script will overwrite.
 *
 * Anything else is someone who already holds privilege, and moving them is a
 * decision that needs a human who knows what they are undoing.
 */
export const PROMOTABLE_ROLES = ['student', 'organizer'];

/**
 * Everything below runs only when this file is executed directly.
 *
 * Without the guard, importing it to read PROMOTABLE_ROLES would run the CLI —
 * against whatever happened to be in `process.argv[2]`, and with a `process.exit`
 * at the end of every path. A test that imports a script in order to check it
 * must not be able to trigger the thing it is checking.
 */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) main();

async function main() {
const email = process.argv[2];

if (!email) {
  console.error('Usage: node bin/make-admin.mjs <email>');
  process.exit(1);
}

try {
  const { db } = openPrivilegedDb('bin/make-admin.mjs');
  assertSystemActor(db);

  const user = db.prepare('SELECT id, role, account_status FROM users WHERE email = ?').get(email);

  if (!user) {
    console.error(`Error: User with email ${email} not found.`);
    console.error('Please have the user sign up first before promoting them.');
    process.exit(1);
  }

  /**
   * Deleted accounts are anonymised in place, not removed, so a lookup by email
   * still finds one — and this CLI would then promote an account nobody can sign
   * in to, recording it in the audit trail as a genuine promotion. The web
   * endpoint refuses the same case; this is the second door into it.
   */
  if (user.account_status === 'deleted') {
    console.error(`Refused: the account for ${email} has been deleted.`);
    console.error('');
    console.error('  Deleted accounts keep their row so audit history and foreign');
    console.error('  keys still resolve, but they cannot be signed in to and must');
    console.error('  not hold administrative roles.');
    process.exit(1);
  }

  /**
   * The owner refusal, stated first and stated loudly.
   *
   * Exits non-zero so a script that chains off this one stops rather than
   * continuing on the assumption that the promotion happened.
   */
  if (user.role === 'super_admin') {
    console.error(`Refused: ${email} is a super administrator.`);
    console.error('');
    console.error('This script would have overwritten that role with "admin", which is a');
    console.error('DEMOTION of the platform owner — and there is no command in this');
    console.error('repository that undoes it. Ownership is granted by direct database');
    console.error('access, deliberately, so that it cannot be changed by running a script.');
    console.error('');
    console.error('If this is genuinely what you intend, do it by hand and write down why.');
    process.exit(1);
  }

  if (user.role === 'admin') {
    console.log(`User ${email} is already an admin.`);
    process.exit(0);
  }

  /**
   * The catch-all. Reached by `partner` today and by any role added later.
   *
   * Refusing an unrecognised role is the whole point of an allowlist: the failure
   * mode of the old code was that an unanticipated role fell through to the
   * UPDATE, and "unanticipated" is exactly when a silent overwrite does the most
   * damage.
   */
  if (!PROMOTABLE_ROLES.includes(user.role)) {
    console.error(`Refused: ${email} has the role "${user.role}", which this script will not overwrite.`);
    console.error(`Only ${PROMOTABLE_ROLES.join(' and ')} accounts can be promoted to admin.`);
    process.exit(1);
  }

  /**
   * The promotion and its audit row, in one transaction.
   *
   * This script wrote NOTHING to the trail until now, which made administrator
   * promotion the only privilege change on the platform that left no trace —
   * while every in-product administrative action, down to reading a report, was
   * recorded. The gap was invisible precisely because the script worked.
   *
   * Atomic in both directions, for the same reason the suspension path is:
   * `recordAudit` never catches, so a failed audit rolls the promotion back.
   * There is no state where somebody became an administrator and the record of
   * it did not happen.
   *
   * `token_version` is bumped as well. A role change on an already-issued cookie
   * is stale the moment it is made, and `authenticateToken` re-reads the row on
   * every request — but the JWT's own `tokenVersion` claim is what invalidates
   * the old sessions, and leaving them alive means a freshly promoted
   * administrator holds a cookie minted before they had the capabilities.
   */
  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE users SET role = 'admin', token_version = token_version + 1 WHERE email = ?"
    ).run(email);

    await recordCliAudit(db, {
      action: CLI_EVENTS.ADMIN_PROMOTED_CLI,
      targetUserId: user.id,
      command: 'bin/make-admin.mjs',
      reason: 'Administrator promotion from the command line',
      metadata: { subject: email, previousRole: user.role },
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`Successfully promoted ${email} to admin (was ${user.role}).`);
  console.log('Recorded in the audit trail. Their existing sessions have been invalidated.');
} catch (error) {
  console.error('Database error:', error.message);
  process.exit(1);
}
}
