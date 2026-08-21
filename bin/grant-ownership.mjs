import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { recordCliAudit, assertSystemActor, CLI_EVENTS } from './cliAudit.mjs';
import { openPrivilegedDb } from './resolveDb.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/* Path resolution, `.env` loading and the refusal to create a database all
   live in resolveDb.mjs — see the incident recorded there. */

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) main();

function ask(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function main() {
  const email = process.argv[2];
  const reason = process.argv[3];

  if (!email || !reason) {
    console.error('Usage: node bin/grant-ownership.mjs <email> <reason>');
    process.exit(1);
  }

  try {
    const { db } = await openPrivilegedDb('bin/grant-ownership.mjs');
    await assertSystemActor(db);

    const user = await db.prepare('SELECT id, role, verified, account_status FROM users WHERE email = ?').get(email);

    if (!user) {
      console.error(`Error: User with email ${email} not found.`);
      process.exit(1);
    }

    if (!user.verified) {
      console.error(`Refused: User account for ${email} is not verified.`);
      process.exit(1);
    }

    if (user.account_status !== 'active') {
      console.error(`Refused: User account for ${email} is not active (current status: ${user.account_status}).`);
      process.exit(1);
    }

    if (user.role === 'super_admin') {
      console.log(`User ${email} is already a super administrator.`);
      process.exit(0);
    }

    /**
     * This said "full, irrevocable control", which is false — `bin/revoke-ownership.mjs`
     * exists and demotes an owner in one command. Overstating a consequence is not
     * a harmless scare: an operator who has been told the action cannot be undone
     * either avoids a grant they should make, or discovers the warning was wrong
     * and reads the next one less carefully. What is actually true is worse in the
     * ways that matter and better in the way that counts — the authority is total
     * while it is held, and no owner can be restrained by another.
     */
    console.log(`WARNING: You are about to grant super_admin privileges to ${email}.`);
    console.log(`An owner holds every capability, can read any data on the platform,`);
    console.log(`and cannot be suspended or demoted by an administrator.`);
    console.log(`This is reversible with bin/revoke-ownership.mjs — but only by`);
    console.log(`somebody with shell access to this database.`);
    console.log(`Reason provided: "${reason}"`);
    console.log('');
    
    const ans = await ask('Type "y" to confirm, or "N" to cancel: ');
    if (ans.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }

    // Atomic promotion
    await db.exec('BEGIN');
    try {
      await db.prepare(`
        UPDATE users 
        SET role = 'super_admin', 
            token_version = token_version + 1 
        WHERE id = ?
      `).run(user.id);

      await recordCliAudit(db, {
        action: CLI_EVENTS.OWNER_GRANTED,
        targetUserId: user.id,
        command: 'bin/grant-ownership.mjs',
        reason,
        metadata: { subject: email, previousRole: user.role },
      });

      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    console.log(`Successfully granted ownership to ${email}. All existing sessions have been invalidated.`);
    process.exit(0);
  } catch (err) {
    console.error('A database error occurred:', err);
    process.exit(1);
  }
}
