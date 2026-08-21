import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { recordCliAudit, assertSystemActor, CLI_EVENTS } from './cliAudit.mjs';
import { openPrivilegedDb } from './resolveDb.mjs';

/**
 * Clear an account's two-factor enrolment, from a shell.
 *
 * ── Why this has to exist ──
 *
 * Two-factor authentication is mandatory for administrators: `requireCap`
 * refuses an administrator who has none. Combined with a lost phone, that is a
 * platform with nobody able to administer it — and on this deployment there are
 * two owner accounts, no self-service reset, and no support desk.
 *
 * Recovery codes are the first answer, and they are enough right up until
 * somebody loses those too, or never saved them. This is the second answer, and
 * it is deliberately the only one that does not require possessing a factor.
 *
 * ── Why it is a shell command and not an endpoint ──
 *
 * Because the check it cannot perform is "is this really you", and no amount of
 * session evidence substitutes for that. Requiring filesystem access to the
 * production database is the strongest authentication this application has: it
 * means whoever runs this already controls the data the account protects, so
 * clearing the factor grants them nothing they did not already have. An endpoint
 * with the same power would be an account-takeover primitive reachable from the
 * internet.
 *
 * ── What it deliberately does NOT do ──
 *
 * It does not set a password, promote anybody, or clear a suspension. It removes
 * the second factor and nothing else, so the account still needs its password —
 * this is one factor of two, restored, not a way in.
 */

const __filename = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) main();

function ask(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  const email = process.argv[2];
  const reason = process.argv[3];

  if (!email || !reason) {
    console.error('Usage: node bin/reset-2fa.mjs <email> <reason>');
    console.error('');
    console.error('Clears the account\'s two-factor enrolment so its owner can sign in with');
    console.error('their password and enrol again. The password itself is not changed.');
    process.exit(1);
  }

  try {
    const { db } = await openPrivilegedDb('bin/reset-2fa.mjs');
    await assertSystemActor(db);

    const user = await db.prepare(
      'SELECT id, role, account_status, tfa_enabled, tfa_email_enabled FROM users WHERE email = ?'
    ).get(email);

    if (!user) {
      console.error(`Error: no account with the address ${email}.`);
      process.exit(1);
    }

    if (!user.tfa_enabled && !user.tfa_email_enabled) {
      console.log(`${email} has no two-factor enrolment. Nothing to clear.`);
      process.exit(0);
    }

    console.log(`About to clear two-factor authentication for ${email}.`);
    console.log('');
    console.log('After this they can sign in with their password alone, and — if they hold a');
    console.log('role that requires a second factor — will be walled until they enrol again.');
    console.log('Their password is NOT changed, and no other access is granted.');
    console.log('');
    console.log(`Reason provided: "${reason}"`);
    console.log('');

    const answer = await ask('Type "y" to confirm, or "N" to cancel: ');
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }

    /**
     * One transaction, and `token_version` bumped with it.
     *
     * Removing a factor is exactly the moment any session opened with it should
     * stop working: if the reset is happening because a device was stolen, the
     * thief's session is the thing being taken away. Recovery codes go too —
     * they are the alternative to the factor being cleared, so leaving them live
     * would leave the weaker credential standing after the stronger one was
     * revoked.
     */
    await db.exec('BEGIN');
    try {
      await db.prepare(`
        UPDATE users
           SET tfa_enabled = 0, tfa_secret = NULL, tfa_email_enabled = 0,
               token_version = token_version + 1
         WHERE id = ?
      `).run(user.id);

      await db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);

      await recordCliAudit(db, {
        action: CLI_EVENTS.TFA_RESET_CLI,
        targetUserId: user.id,
        command: 'bin/reset-2fa.mjs',
        reason,
        metadata: { subject: email, role: user.role },
      });

      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    console.log('');
    console.log(`Cleared. ${email} can sign in with their password, and every existing`);
    console.log('session for that account has been ended.');
    process.exit(0);
  } catch (err) {
    console.error('A database error occurred:', err);
    process.exit(1);
  }
}
