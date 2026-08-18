import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { recordCliAudit, assertSystemActor, CLI_EVENTS } from './cliAudit.mjs';
import { openPrivilegedDb } from './resolveDb.mjs';

/**
 * Remove an authenticator secret that was generated and never confirmed.
 *
 * ── The state this exists for ──
 *
 * `POST /api/2fa/generate` writes `users.tfa_secret` and deliberately leaves
 * `tfa_enabled` at 0, so that abandoning the setup screen cannot lock anybody
 * out. Nothing has ever cleaned the column up afterwards. So every account that
 * once opened authenticator setup and walked away carries an encrypted secret it
 * never scanned, indefinitely.
 *
 * Until `enabledSecondFactors` landed (see server/utils.js) that secret was a
 * WORKING second factor: `POST /api/auth/login-2fa` verified TOTP against
 * `tfa_secret` without consulting `tfa_enabled`, so a code derived from it signed
 * the account in. That is closed — the sign-in path now refuses any method the
 * account does not actually hold, and this tool is not what makes the platform
 * safe.
 *
 * What is left is a data-hygiene problem, and it is a real one: the row holds a
 * live credential for a factor its owner does not know exists, cannot see
 * (`/api/2fa/status` reports `totp: false`) and cannot remove
 * (`/api/2fa/disable` refuses with "2FA is not enabled"). Anyone who can read
 * the database and the `TFA_ENCRYPTION_KEY` can derive codes from it. It should
 * not be there.
 *
 * ── Why this is not `reset-2fa.mjs` ──
 *
 * That script is the lockout remedy, and it is correctly blunt: it clears
 * `tfa_enabled`, `tfa_secret` AND `tfa_email_enabled`, deletes every recovery
 * code, and bumps `token_version` to end existing sessions. Every one of those is
 * right when somebody has lost their phone.
 *
 * Every one of them is wrong here. The accounts carrying a stale secret are not
 * locked out — they are signing in perfectly well with email codes — and running
 * the lockout remedy at them would switch off the factor they are actually
 * using, destroy ten recovery codes they may have printed, sign them out
 * everywhere, and (because both affected accounts are `super_admin`, a role the
 * 2FA policy applies to) wall them out of every administrative page until they
 * enrolled again. That is a bigger outage than the problem.
 *
 * So this touches exactly one column on one row.
 *
 * ── The refusal that makes it safe ──
 *
 * It will not run against an account with `tfa_enabled = 1`. There, the secret is
 * not stale — it is the live factor, and clearing it would leave the account
 * demanding codes for a secret the server no longer holds: a total lockout,
 * recovery codes only. That is precisely the failure `/api/2fa/generate`'s
 * `already_enrolled` refusal was added to prevent, and this must not reintroduce
 * it from the shell.
 *
 * Audited like every other privileged command here, so "what has been done to
 * this account from a shell" stays one query.
 */

const __filename = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) main();

function ask(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
}

/**
 * The decision, separated from the I/O so it can be tested without a terminal.
 *
 * @returns {{ok: true, user: object} | {ok: false, code: string, message: string}}
 */
export async function assessAccount(db, email) {
  const user = await db.prepare(`
    SELECT id, email, role, account_status, tfa_enabled, tfa_email_enabled, tfa_secret
      FROM users
     WHERE email = ?
  `).get(email);

  if (!user) {
    return { ok: false, code: 'no_such_account', message: `No account with the address ${email}.` };
  }

  if (user.tfa_secret === null) {
    return {
      ok: false,
      code: 'nothing_to_clear',
      message: `${email} has no stored authenticator secret. Nothing to clear.`,
    };
  }

  /**
   * The load-bearing refusal. See the header: an enabled factor's secret is not
   * stale, and removing it locks the account out of its own second factor.
   */
  if (user.tfa_enabled) {
    return {
      ok: false,
      code: 'factor_is_live',
      message:
        `${email} has an ENABLED authenticator (tfa_enabled = 1). Its secret is in\n`
        + 'use, not stale, and clearing it would leave the account demanding codes\n'
        + 'for a secret the server no longer holds — a lockout with recovery codes\n'
        + 'as the only way back.\n\n'
        + 'If the intent is to remove a working second factor, that is\n'
        + '`bin/reset-2fa.mjs`, which clears the enrolment as a whole and says so.',
    };
  }

  return { ok: true, user };
}

/** The write. One column, one row, inside a transaction with its audit entry. */
export async function clearStaleSecret(db, { user, reason, command = 'bin/clear-stale-tfa-secret.mjs' }) {
  await db.exec('BEGIN');
  try {
    /**
     * `tfa_enabled = 0` in the WHERE clause as well as checked above.
     *
     * The check and the write are separated by an interactive confirmation, and
     * a concurrent enrolment in that window would turn this into the lockout the
     * refusal exists to prevent. Re-stating the condition where the database can
     * enforce it costs nothing and closes the race.
     *
     * Nothing else is touched: `tfa_email_enabled`, `recovery_codes`,
     * `password_hash` and `token_version` are all left exactly as they were, so
     * existing sessions stay valid and the factor the account actually uses keeps
     * working.
     */
    const result = await db.prepare(`
      UPDATE users
         SET tfa_secret = NULL
       WHERE id = ? AND tfa_enabled = 0 AND tfa_secret IS NOT NULL
    `).run(user.id);

    if (result.changes !== 1) {
      throw new Error(
        'The account changed while this command was waiting for confirmation. '
        + 'Nothing was cleared; run it again to re-read the current state.'
      );
    }

    await recordCliAudit(db, {
      action: CLI_EVENTS.TFA_STALE_SECRET_CLEARED,
      targetUserId: user.id,
      command,
      reason,
      metadata: { subject: user.email, role: user.role },
    });

    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

async function main() {
  const email = process.argv[2];
  const reason = process.argv[3];
  const assumeYes = process.argv.includes('--yes');

  if (!email || !reason) {
    console.error('Usage: node bin/clear-stale-tfa-secret.mjs <email> <reason> [--yes]');
    console.error('');
    console.error('Removes an authenticator secret that was generated but never confirmed');
    console.error('(tfa_enabled = 0). Changes nothing else: email 2FA, recovery codes, the');
    console.error('password and existing sessions are all left alone.');
    console.error('');
    console.error('Refuses when the authenticator is actually ENABLED — that is a working');
    console.error('factor, and bin/reset-2fa.mjs is the command for removing one.');
    process.exit(1);
  }

  try {
    const { db } = await openPrivilegedDb('bin/clear-stale-tfa-secret.mjs');
    await assertSystemActor(db);

    const assessment = await assessAccount(db, email);
    if (!assessment.ok) {
      /* `nothing_to_clear` is a successful no-op: the desired end state already
         holds, and a non-zero exit would make this unusable from a script that
         runs it over several accounts. */
      if (assessment.code === 'nothing_to_clear') {
        console.log(assessment.message);
        process.exit(0);
      }
      console.error(`Refused: ${assessment.message}`);
      process.exit(1);
    }

    const { user } = assessment;

    console.log(`About to clear the unconfirmed authenticator secret for ${email}.`);
    console.log('');
    console.log(`  tfa_enabled ............ ${user.tfa_enabled} (unchanged)`);
    console.log(`  tfa_email_enabled ...... ${user.tfa_email_enabled} (unchanged)`);
    console.log('  tfa_secret ............. present  ->  NULL');
    console.log('  recovery codes ......... unchanged');
    console.log('  password, sessions ..... unchanged');
    console.log('');
    console.log(`Reason provided: "${reason}"`);
    console.log('');

    if (!assumeYes) {
      const answer = await ask('Type "y" to confirm, or "N" to cancel: ');
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('Cancelled.');
        process.exit(0);
      }
    }

    await clearStaleSecret(db, { user, reason });

    const after = await db.prepare(
      'SELECT tfa_enabled, tfa_email_enabled, tfa_secret FROM users WHERE id = ?'
    ).get(user.id);
    const codes = (await db.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
    ).get(user.id)).n;

    console.log('');
    console.log('Cleared. Current state:');
    console.log(`  tfa_enabled ............ ${after.tfa_enabled}`);
    console.log(`  tfa_email_enabled ...... ${after.tfa_email_enabled}`);
    console.log(`  tfa_secret ............. ${after.tfa_secret === null ? 'NULL' : 'STILL PRESENT — investigate'}`);
    console.log(`  recovery codes ......... ${codes}`);

    /**
     * Closed explicitly, before exiting.
     *
     * `process.exit()` does not run SQLite's close path, so a WAL-mode database
     * is left with the commit sitting in `-wal` and the main file untouched. The
     * data is durable and every reader sees it — but the next process to close
     * the database is then the one that rewrites the main file, which turns a
     * routine checkpoint into an unexplained change of the file's checksum at an
     * unrelated moment. That has already caused one investigation on this
     * deployment. Closing here folds the change in while the operator is still
     * watching.
     */
    db.close();
    process.exit(0);
  } catch (err) {
    console.error('A database error occurred:', err);
    process.exit(1);
  }
}
