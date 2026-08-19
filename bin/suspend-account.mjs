/**
 * Disables one account from a shell, ending every session it holds.
 *
 * ── The gap this closes ──
 *
 * Suspension existed in two places and neither was reachable by an operator.
 * `POST /api/admin/users/:id/suspend` requires an authenticated administrator
 * with `user.suspend`, and `bin/` could grant ownership, revoke it, promote an
 * admin and clear a second factor — but had no way to take an account out of
 * service. So the one situation where the shell is the only tool left, an
 * account that must stop working right now and whose holder may be the person
 * you are locking out, had no answer short of editing rows by hand. Editing
 * rows by hand is what `resolveDb.mjs` exists to stop.
 *
 * It is also what the production cleanup on 2026-08-19 needed: two `super_admin`
 * accounts written into production by a test suite that had been pointed at the
 * live database. `revoke-ownership` demoted them to `admin`, which is as far as
 * the existing tooling went, and an administrator is still an administrator.
 *
 * ── Why not just call the route ──
 *
 * Because it is deliberately a different act. The route does NOT bump
 * `token_version`: a moderated user keeps their session so the appeal flow can
 * load, and it mints an appeal token to go with it. Neither is right here. An
 * account being disabled from a shell is one nobody should be holding — a
 * contaminant, a compromise, a departure — so every outstanding cookie has to
 * stop working on the next request, and there is nobody to appeal on behalf of
 * a row a test created. `authenticateToken` re-reads the user and compares
 * `token_version` on every request, so the bump is what makes this immediate
 * rather than effective in up to seven days.
 *
 * The audit trail records `ACCOUNT_SUSPENDED_CLI` rather than the route's
 * event, so a reader years later can tell a moderation decision from an
 * operational lockout without opening the code.
 *
 * ── What it refuses ──
 *
 * A super administrator, mirroring the route: the failure mode is a platform
 * with nobody able to undo it. Grant ownership elsewhere, revoke theirs, then
 * suspend. A deleted account, because the tombstone is the stronger state
 * already. An account that is already suspended, so a second run is a clear
 * no-op rather than a silent re-stamp of the reason and the date.
 *
 * Reversal is `UPDATE users SET account_status = 'active', suspension_lifted_at
 * = <now>` through the admin UI's lift path, or the same by hand; nothing here
 * destroys a row or a column.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { recordCliAudit, assertSystemActor, CLI_EVENTS } from './cliAudit.mjs';
import { openPrivilegedDb } from './resolveDb.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) main();

function ask(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function main() {
  const email = process.argv[2];
  const reason = process.argv[3];

  if (!email || !reason) {
    console.error('Usage: node bin/suspend-account.mjs <email> <reason>');
    console.error('');
    console.error('Disables the account and ends every session it holds.');
    console.error('The reason is written to the audit trail and is not optional —');
    console.error('an unexplained lockout is unreadable a year later.');
    process.exit(1);
  }

  try {
    const { db } = await openPrivilegedDb('bin/suspend-account.mjs');
    await assertSystemActor(db);

    const user = await db.prepare(
      'SELECT id, role, account_status FROM users WHERE email = ?'
    ).get(email);

    if (!user) {
      console.error(`Error: User with email ${email} not found.`);
      process.exit(1);
    }

    if (user.account_status === 'deleted') {
      console.log(`${email} is already deleted. A tombstone cannot sign in; nothing to do.`);
      process.exit(0);
    }

    if (user.account_status === 'suspended') {
      console.log(`${email} is already suspended. Nothing to do.`);
      console.log('Re-running would overwrite the original reason and date, so it does not.');
      process.exit(0);
    }

    /**
     * Asked as a role comparison rather than through `can()` on purpose: this
     * file is a standalone ESM script under bin/, outside the server module
     * graph that owns the capability spine, and importing it here would pull the
     * application's config and database wiring into a tool whose whole point is
     * to work when that wiring is what is broken. The refusal is deliberately
     * the blunt one — refuse every super_admin — which is strictly stronger
     * than the route's capability question and cannot drift into being weaker.
     */
    if (user.role === 'super_admin') {
      console.error(`Refused: ${email} is a super administrator.`);
      console.error('Suspending one from a shell would leave a platform nobody can restore.');
      console.error('Revoke ownership first:');
      console.error(`  node bin/revoke-ownership.mjs ${email} "<reason>"`);
      process.exit(1);
    }

    console.log(`WARNING: You are about to suspend ${email} (role: ${user.role}).`);
    console.log('The account will be unable to sign in, and every session it currently');
    console.log('holds will stop working on the next request.');
    console.log(`Reason provided: "${reason}"`);
    console.log('');

    const ans = await ask('Type "y" to confirm, or "N" to cancel: ');
    if (ans.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }

    const now = new Date().toISOString();

    /* One transaction with the audit row, for the reason the route gives: a
       suspension recorded but not enforced, or enforced but not recorded, are
       both worse than one that fails cleanly and can be retried. */
    await db.exec('BEGIN');
    try {
      await db.prepare(`
        UPDATE users
        SET account_status = 'suspended',
            suspended_at = ?,
            suspended_until = NULL,
            suspension_lifted_at = NULL,
            suspension_reason = ?,
            suspended_by = 'system-cli',
            token_version = token_version + 1
        WHERE id = ?
      `).run(now, reason, user.id);

      await recordCliAudit(db, {
        action: CLI_EVENTS.ACCOUNT_SUSPENDED_CLI,
        targetUserId: user.id,
        command: 'bin/suspend-account.mjs',
        reason,
        metadata: { subject: email, previousRole: user.role },
      });

      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    console.log(`Suspended ${email}. All existing sessions have been invalidated.`);
    process.exit(0);
  } catch (err) {
    console.error('A database error occurred:', err);
    process.exit(1);
  }
}
