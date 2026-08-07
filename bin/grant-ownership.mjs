import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { recordAudit } from '../server/auditLog.js';
import { ownershipAuditDetails, OWNERSHIP_EVENTS } from './ownershipAudit.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.WEV_DB_PATH || path.join(__dirname, '..', 'server', 'wevolunteer.db');

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
    const db = new DatabaseSync(dbPath);

    const user = db.prepare('SELECT id, role, verified, account_status FROM users WHERE email = ?').get(email);

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

    console.log(`WARNING: You are about to grant super_admin privileges to ${email}.`);
    console.log(`This grants full, irrevocable control over the platform and access to all data.`);
    console.log(`Reason provided: "${reason}"`);
    console.log('');
    
    const ans = await ask('Type "y" to confirm, or "N" to cancel: ');
    if (ans.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }

    // Atomic promotion
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE users 
        SET role = 'super_admin', 
            token_version = token_version + 1 
        WHERE id = ?
      `).run(user.id);

      recordAudit(db, {
        adminId: user.id,
        action: OWNERSHIP_EVENTS.GRANTED,
        targetUserId: user.id,
        details: ownershipAuditDetails({ verb: 'granted', email, reason }),
      });

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    console.log(`Successfully granted ownership to ${email}. All existing sessions have been invalidated.`);
    process.exit(0);
  } catch (err) {
    console.error('A database error occurred:', err);
    process.exit(1);
  }
}
