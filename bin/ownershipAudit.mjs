import os from 'node:os';

/**
 * The audit entry a command-line ownership change writes.
 *
 * ── Why the two scripts share this ──
 *
 * Granting and revoking ownership are the same event told twice, and they were
 * writing their `details` independently: one wrote the bare reason, the other
 * wrote the bare reason. Neither recorded that the change came from a shell
 * rather than from the product, which is the single most useful fact about it —
 * there IS no product path, so "how did this happen" has exactly one answer and
 * the record did not give it.
 *
 * ── The actor problem, stated rather than hidden ──
 *
 * `admin_audit_logs.admin_id` is a foreign key to `users`, and migration 019
 * added a trigger refusing to delete any account that has written an audit row.
 * So the column must hold a real account — and a shell operator is not one.
 *
 * Both scripts therefore record the SUBJECT as the actor, which read on its own
 * says "this person granted themselves ownership". That is not what happened,
 * and the details line now says so explicitly rather than leaving the row to be
 * misread years later by somebody asking who did this.
 *
 * A reserved `system-cli` account would fix it properly, at the cost of a
 * seeded row that exists solely to be pointed at. That is a schema decision for
 * the owner, and it is recorded in `docs/questions-for-owner.md`.
 */

/**
 * `method=CLI` first, because it is the fact that changes how the rest is read.
 *
 * The operator's OS username and host are recorded on a best-effort basis. They
 * are not authentication — anybody who can run this script can set them — but
 * on a platform where the shell is reachable by a handful of people, "which
 * machine, which login" is usually enough to start a conversation, and an empty
 * field would have been worth nothing at all.
 */
export function ownershipAuditDetails({ verb, email, reason }) {
  let operator = 'unknown';
  try {
    operator = `${os.userInfo().username}@${os.hostname()}`;
  } catch {
    /* `userInfo` throws where there is no passwd entry — some containers. The
       entry is still worth writing without it. */
  }

  return [
    `method=CLI`,
    `operator=${operator}`,
    `subject=${email}`,
    `note=recorded against the subject's own id because a shell operator has no account; the actor is the operator named above`,
    `reason=${reason}`,
  ].join('; ');
}

/** The two event names, so a typo in one script cannot diverge from the other. */
export const OWNERSHIP_EVENTS = Object.freeze({
  GRANTED: 'OWNER_GRANTED',
  REVOKED: 'OWNER_REVOKED',
});
