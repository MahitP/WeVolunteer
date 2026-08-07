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
    console.error('Usage: node bin/revoke-ownership.mjs <email> <reason>');
    process.exit(1);
  }

  try {
    const { db } = openPrivilegedDb('bin/revoke-ownership.mjs');
    assertSystemActor(db);

    const user = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);

    if (!user) {
      console.error(`Error: User with email ${email} not found.`);
      process.exit(1);
    }

    if (user.role !== 'super_admin') {
      console.log(`User ${email} is not a super administrator.`);
      process.exit(0);
    }

    const { count } = db.prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'`).get();
    
    if (count <= 1) {
      console.error(`Refused: ${email} is the last remaining super_admin.`);
      console.error('The platform must have at least one owner at all times. Grant ownership to another account first.');
      process.exit(1);
    }

    console.log(`WARNING: You are about to revoke super_admin privileges from ${email}.`);
    console.log(`Their account will be demoted to an ordinary administrator.`);
    console.log(`Reason provided: "${reason}"`);
    console.log('');
    
    const ans = await ask('Type "y" to confirm, or "N" to cancel: ');
    if (ans.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }

    // Atomic demotion
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE users 
        SET role = 'admin', 
            token_version = token_version + 1 
        WHERE id = ?
      `).run(user.id);

      recordCliAudit(db, {
        action: CLI_EVENTS.OWNER_REVOKED,
        targetUserId: user.id,
        command: 'bin/revoke-ownership.mjs',
        reason,
        metadata: { subject: email },
      });

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    console.log(`Successfully revoked ownership from ${email}. They have been demoted to admin and all existing sessions have been invalidated.`);
    process.exit(0);
  } catch (err) {
    console.error('A database error occurred:', err);
    process.exit(1);
  }
}
