import os from 'node:os';
import { recordAudit } from '../server/auditLog.js';
import { SYSTEM_CLI_ID } from '../server/migrations/022_system_cli_actor.js';

/**
 * The audit entry every privileged command-line action writes.
 *
 * ── One mechanism, not one per script ──
 *
 * This replaces `ownershipAudit.mjs`, which only knew about the two ownership
 * scripts. `make-admin.mjs` — the command that creates administrators, the
 * second most consequential privilege change on the platform — wrote nothing at
 * all, and would have grown its own copy of this the first time somebody
 * noticed.
 *
 * Every `bin/` command that changes what an account may do goes through here, so
 * the answer to "what privileged things have been done from a shell" is one
 * query rather than a hunt through four files with three formats.
 *
 * ── The actor ──
 *
 * `system-cli`, seeded by migration 022. Before it existed the scripts recorded
 * the SUBJECT as the actor, so a bootstrap row read "this person granted
 * themselves ownership" — not what happened, and worse, `admin_id` is the field
 * a report groups by, so every CLI action was attributed to its own victim.
 *
 * The human operator cannot be the actor: they have no account, and
 * `admin_audit_logs.admin_id` is a foreign key. Their OS login and host are
 * recorded in the details instead, on a best-effort basis. That is not
 * authentication — anybody who can run these scripts can set them — but on a
 * platform where the shell is reachable by a handful of people, "which machine,
 * which login" is enough to start a conversation, and an empty field is worth
 * nothing at all.
 */

/** The events. Named here so a typo in one script cannot diverge from another. */
export const CLI_EVENTS = Object.freeze({
  OWNER_GRANTED: 'OWNER_GRANTED',
  OWNER_REVOKED: 'OWNER_REVOKED',
  ADMIN_PROMOTED_CLI: 'ADMIN_PROMOTED_CLI',
  /* Disabling an account from a shell. Distinct from the administrative
     suspension written by `POST /api/admin/users/:id/suspend`, and the trail
     has to say which one happened: the route leaves `token_version` alone so
     the person can still reach the appeal flow, while this one bumps it and
     ends every session immediately. That is the difference between moderating
     somebody and locking out an account nobody should be holding. */
  ACCOUNT_SUSPENDED_CLI: 'ACCOUNT_SUSPENDED_CLI',
  /* Clearing a locked-out account's second factor from a shell. Grave: it is the
     one operation that removes an authentication factor without proving
     possession of it. */
  TFA_RESET_CLI: 'TFA_RESET_CLI',
  /* Removing an authenticator secret that was generated and never confirmed.
     Distinct from TFA_RESET_CLI on purpose: it removes NO factor the account was
     using — `tfa_enabled` is 0, which the command refuses to proceed without —
     so a reader of the audit trail should not have to open the code to tell the
     two apart. See bin/clear-stale-tfa-secret.mjs. */
  TFA_STALE_SECRET_CLEARED: 'TFA_STALE_SECRET_CLEARED',
});

/**
 * `who` and `where`, best effort.
 *
 * `userInfo()` throws where there is no passwd entry — some containers — and the
 * entry is still worth writing without it.
 */
function operator() {
  try {
    return `${os.userInfo().username}@${os.hostname()}`;
  } catch {
    return 'unknown';
  }
}

/**
 * Writes the row.
 *
 * `command` is the script that ran, so a reader can find the code that produced
 * the row rather than inferring it from the action name. `metadata` is for
 * anything a specific command wants on the record — the previous role, a
 * target's address — and is rendered as `key=value` pairs in the same style as
 * the rest, because `details` is one TEXT column and the value of a consistent
 * shape in it is being greppable.
 */
export async function recordCliAudit(db, { action, targetUserId, command, reason, metadata = {} }) {
  if (!action) throw new Error('recordCliAudit: action is required');
  if (!targetUserId) throw new Error('recordCliAudit: targetUserId is required');
  if (!command) throw new Error('recordCliAudit: command is required');

  const parts = [
    'method=CLI',
    `command=${command}`,
    `operator=${operator()}`,
    ...Object.entries(metadata).map(([k, v]) => `${k}=${v}`),
  ];
  if (reason) parts.push(`reason=${reason}`);

  return await recordAudit(db, {
    adminId: SYSTEM_CLI_ID,
    action,
    targetUserId,
    details: parts.join('; '),
  });
}

/**
 * Refuses to run when the reserved actor is absent.
 *
 * A script that reaches for `system-cli` against a database whose migrations
 * have not run would fail on the foreign key AFTER doing its work, inside a
 * transaction it then rolls back — which reads to the operator as "the command
 * is broken" rather than "this database is out of date". Checking first means
 * the message names the actual problem.
 */
export async function assertSystemActor(db) {
  /* `await` on both engines: SQLite's `.get()` returns the row directly and
     awaiting a non-promise is a no-op, while PostgreSQL returns a promise. One
     spelling that is correct on both is what keeps these scripts from having an
     engine branch at every call site. */
  const row = await db.prepare('SELECT id FROM users WHERE id = ?').get(SYSTEM_CLI_ID);
  if (row) return;
  throw new Error(
    `The reserved '${SYSTEM_CLI_ID}' account is missing from this database.\n\n`
    + 'It is created by migration 022 and is what privileged command-line actions\n'
    + 'are recorded against. Start the server once against this database so the\n'
    + 'migrations run, then try again.'
  );
}

export { SYSTEM_CLI_ID };
