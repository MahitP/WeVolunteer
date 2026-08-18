import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { recordCliAudit, assertSystemActor, CLI_EVENTS } from './cliAudit.mjs';
import { openPrivilegedDb } from './resolveDb.mjs';

/**
 * Creates the platform's owner accounts, directly in the database.
 *
 * ── Why this is not a seed, a migration, or a fixture ──
 *
 * Because those are all files, and a file with an owner's credentials in it is
 * the thing this script exists to avoid. `seedSuperAdmin()` used to do exactly
 * that and its password is now permanently in this repository's git history.
 *
 * Addresses are supplied as ARGUMENTS and never written down here. Nothing
 * about who owns this platform is committed.
 *
 * ── The password nobody knows ──
 *
 * The owner's instruction was "create them with bcrypt password hashes" and
 * "do not expose the passwords anywhere". Those only reconcile one way: the
 * account gets a real bcrypt hash of a 32-byte random value that is generated
 * in memory, hashed, and dropped. It is never printed, never returned, never
 * stored, and no preimage for it exists anywhere in the world.
 *
 * The account is therefore unusable until its owner sets a password through
 * "Forgot password", which proves control of the mailbox — a better claim than
 * a password handed over in a terminal, which is then in a scrollback buffer, a
 * shell history and whatever recorded the session.
 *
 * This is deliberately NOT the OAUTH_ONLY sentinel. That value means "this
 * account signs in with a provider", and sign-in would tell the owner to use a
 * button that is not connected to anything. A real hash produces the ordinary
 * "incorrect password" and the ordinary reset path.
 *
 * ── Idempotent ──
 *
 * Run it twice and the second run reports what already exists and changes
 * nothing. An account that exists is promoted rather than recreated, so an
 * owner who has already set a password does not lose it.
 *
 * Usage:
 *   node bin/bootstrap-owners.mjs <email> [<email> ...]
 *   WEV_DB_PATH=../pilot.db node bin/bootstrap-owners.mjs <email>
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/* Path resolution, `.env` loading and the refusal to create a database all
   live in resolveDb.mjs — see the incident recorded there. */

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) main();

function ask(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

/**
 * A hash of 32 random bytes, discarded immediately.
 *
 * Kept in its own function so there is exactly one place where a password-shaped
 * value exists, and nothing in it can be returned to a caller by accident.
 */
function unknowablePasswordHash() {
  const secret = crypto.randomBytes(32).toString('hex');
  return bcrypt.hashSync(secret, bcrypt.genSaltSync(10));
}

/** A username that cannot collide with a person's, derived from the address. */
async function usernameFor(db, email) {
  const base = `owner_${email.split('@')[0]}`.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
  let candidate = base;
  let n = 1;
  while (await db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(candidate)) {
    candidate = `${base}${n++}`;
  }
  return candidate;
}

async function main() {
  const emails = process.argv.slice(2).filter(Boolean);

  if (emails.length === 0) {
    console.error('Usage: node bin/bootstrap-owners.mjs <email> [<email> ...]');
    console.error('');
    console.error('Creates or promotes platform owner accounts. Addresses are never');
    console.error('written to any file. Each account is given a bcrypt hash of a random');
    console.error('value that is discarded, so the owner must use "Forgot password" to');
    console.error('set their own credential.');
    process.exit(1);
  }

  /* `openPrivilegedDb` prints the resolved path itself — this script used to do it
     separately, which is where the duplicate came from. */
  const { db } = await openPrivilegedDb('bin/bootstrap-owners.mjs');
  await assertSystemActor(db);

  console.log('');
  console.log('About to grant PLATFORM OWNERSHIP — full, unrestricted control over');
  console.log('every account and every record — to:');
  for (const e of emails) console.log(`  • ${e}`);
  console.log('');

  const ans = await ask('Type "y" to confirm, or anything else to cancel: ');
  if (ans.trim().toLowerCase() !== 'y') {
    console.log('Cancelled. Nothing was changed.');
    process.exit(0);
  }

  const now = new Date().toISOString();

  for (const email of emails) {
    const existing = await db.prepare('SELECT id, role, account_status FROM users WHERE email = ? COLLATE NOCASE').get(email);

    await db.exec('BEGIN');
    try {
      let userId;
      let what;

      if (existing) {
        if (existing.role === 'super_admin') {
          await db.exec('ROLLBACK');
          console.log(`• ${email} — already an owner, unchanged.`);
          continue;
        }
        userId = existing.id;
        what = `promoted from ${existing.role}`;
        /* An existing account keeps its password. Somebody already signs in with
           it, and replacing their credential during a promotion would lock them
           out of the account being promoted. */
        await db.prepare(`
          UPDATE users
             SET role = 'super_admin',
                 verified = 1,
                 email_verified = 1,
                 account_status = 'active',
                 suspended_at = NULL, suspended_until = NULL, suspension_reason = NULL,
                 deleted_at = NULL,
                 token_version = token_version + 1
           WHERE id = ?
        `).run(userId);
      } else {
        userId = `user-${crypto.randomUUID()}`;
        what = 'created';
        await db.prepare(`
          INSERT INTO users (
            id, name, email, username, password_hash, grade, role, verified,
            avatar, bio, school, skills, email_verified, account_status,
            leaderboard_opt_in, email_opt_out, profile_visibility, created_at, token_version
          ) VALUES (?, ?, ?, ?, ?, ?, 'super_admin', 1, ?, ?, ?, ?, 1, 'active', 0, 0, 'private', ?, 0)
        `).run(
          userId, 'Platform Owner', email, await usernameFor(db, email),
          unknowablePasswordHash(), 'N/A',
          '👑', 'Platform owner.', 'WeVolunteer', JSON.stringify([]),
          now
        );
      }

      await recordCliAudit(db, {
        action: CLI_EVENTS.OWNER_GRANTED,
        targetUserId: userId,
        command: 'bin/bootstrap-owners.mjs',
        reason: `Bootstrap owner account (${what})`,
        metadata: { subject: email },
      });

      await db.exec('COMMIT');
      console.log(`• ${email} — ${what}.`);
    } catch (err) {
      await db.exec('ROLLBACK');
      console.error(`• ${email} — FAILED, nothing changed for this account:`, err.message);
      process.exitCode = 1;
    }
  }

  console.log('');
  console.log('Next steps — these accounts cannot be signed into yet, by anyone:');
  console.log('');
  console.log('  1. Go to the sign-in page and choose "Forgot password".');
  console.log('  2. Use the link sent to the address to set a password.');
  console.log('     Newly created accounts hold a hash of a random value that was');
  console.log('     discarded; no password for them exists anywhere.');
  console.log('  3. ROTATE the password of any account that was PROMOTED rather than');
  console.log('     created — it kept whatever credential it already had, which may');
  console.log('     be older and weaker than an owner account warrants.');
  console.log('');
  console.log('Rotate owner passwords on a schedule. An owner account is the only');
  console.log('one on this platform that cannot be locked out by anybody else.');
}
