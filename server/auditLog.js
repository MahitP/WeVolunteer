import crypto from 'crypto';

/**
 * The one writer of `admin_audit_logs`.
 *
 * ── Why this exists ──
 *
 * There were eight raw `INSERT INTO admin_audit_logs` statements across five
 * files and no helper at all. Eight copies of a statement is eight chances to
 * get one of them wrong, and the failure mode is the quietest one there is: a
 * missing audit row looks exactly like an action nobody took.
 *
 * The copies had already drifted in a way that mattered. Three different id
 * schemes were in use — `audit-${randomUUID()}`, `audit-${Date.now()}-${rand}`
 * and `log-${Date.now()}` — and the first exists because the second caused an
 * outage. `accountRoutes.js` records it: "two deletions in the same millisecond
 * collided on this PRIMARY KEY, which rolled the transaction back and failed the
 * whole deletion with a 500 for both people." Two call sites were fixed after
 * that incident; four were left carrying the same latent collision, because
 * nothing tied them together. This module is what ties them together.
 *
 * ── Boundaries ──
 *
 * Imports `node:crypto` and nothing else. `db` arrives as an argument on every
 * call, which is what lets `db.js` import this during its own initialisation
 * without a cycle, lets `bin/` scripts use it against a scratch database, and
 * lets a test drive it without booting anything. Same reasoning as
 * `server/reauth.js`.
 *
 * **This module records decisions. It does not make them.** It performs no
 * authorization, reads no session and derives no identity: `adminId` is always
 * passed in explicitly by a caller that has already decided who is acting. An
 * audit helper that could work out the actor for itself would be a second,
 * quieter source of truth about identity.
 */

/**
 * The only keys a caller may pass.
 *
 * Unknown keys THROW rather than being ignored, and that is the point. The
 * table has six columns and no others — in particular there is no `severity`
 * column and no concept of one anywhere in this repository. A caller writing
 * `recordAudit(db, { ..., severity: 'high' })` under the reasonable belief that
 * it would be stored gets silence today: the field evaporates, the row is
 * written without it, and the gap is discovered when somebody goes looking for
 * a severity that was never recorded. Refusing the call converts that into a
 * failure at the moment the mistake is made.
 */
const ALLOWED_FIELDS = Object.freeze(['adminId', 'action', 'targetUserId', 'details', 'createdAt']);

/** Required, and required to be a non-empty string. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `recordAudit: ${field} is required and must be a non-empty string (received ${JSON.stringify(value)})`
    );
  }
  return value;
}

/** Optional columns: absent and explicitly null are the same thing to SQLite. */
function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`recordAudit: ${field} must be a string or null (received ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Writes one audit row, or throws.
 *
 * ── Why it throws instead of returning a result ──
 *
 * `admin_id` is `NOT NULL` with a foreign key to `users`, so a bad actor id is
 * refused by the database anyway — but as a constraint error from inside
 * whatever transaction the caller happens to be in, phrased in terms of a column
 * rather than the mistake. Checking first produces an error that names the
 * caller's error, and it produces it before any partial work is done.
 *
 * More importantly: **nothing here catches.** Every call site but one runs
 * inside a transaction, and an audit row that fails to write must take the thing
 * it was recording down with it. An account deletion that succeeds while its
 * audit row silently vanishes is worse than one that fails outright, because the
 * first is invisible and the second is a bug report. A caller that genuinely
 * must survive a failed audit has to say so at its own call site, in the open —
 * `privacyRoutes.js`'s download path is the single place that does, and it has
 * its reason written there.
 *
 * ── Why the id is a UUID and never a timestamp ──
 *
 * See the module header: `Date.now()`-based ids collided in production and
 * failed two account deletions. Generated here so no call site can reintroduce
 * it, which is the whole reason the id is not a parameter.
 *
 * ── Why `createdAt` is not a parameter either ──
 *
 * The helper stamps the time. A caller-supplied timestamp would let an audit row
 * be backdated, and an audit trail whose times are supplied by the code being
 * audited is not much of one. ISO-8601 UTC from JS, never SQLite's
 * `datetime('now')` — mixing the two breaks lexicographic comparison, which is
 * how every `ORDER BY created_at` in this repository works (TD-10).
 *
 * @param {object} db      an open database handle
 * @param {object} entry   `{ adminId, action, targetUserId?, details? }`
 * @returns {{id: string, createdAt: string}} what was written
 */
export function recordAudit(db, entry) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('recordAudit: a database handle is required');
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('recordAudit: an entry object is required');
  }

  const unknown = Object.keys(entry).filter(k => !ALLOWED_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `recordAudit: unknown field(s) ${unknown.join(', ')}. `
      + `admin_audit_logs stores only ${ALLOWED_FIELDS.join(', ')} — there is no severity column. `
      + 'A field this table cannot hold would be silently dropped, so it is refused instead.'
    );
  }

  const adminId = requireText(entry.adminId, 'adminId');
  const action = requireText(entry.action, 'action');
  const targetUserId = optionalText(entry.targetUserId, 'targetUserId');
  const details = optionalText(entry.details, 'details');
  const providedCreatedAt = optionalText(entry.createdAt, 'createdAt');

  const id = `audit-${crypto.randomUUID()}`;
  const createdAt = providedCreatedAt || new Date().toISOString();

  db.prepare(`
    INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, adminId, action, targetUserId, details, createdAt);

  return { id, createdAt };
}
