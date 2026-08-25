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
 * ── Why it is async ──
 *
 * On PostgreSQL a statement's `.run()` returns a promise, so the INSERT has to
 * be awaited or the row is merely *scheduled* — and a transaction that commits
 * before its audit write lands is the failure this module exists to prevent,
 * arriving silently. Awaiting a SQLite `.run()` is a no-op, so both engines are
 * served by one shape.
 *
 * Every call site awaits, and `authz.completeness.test.js` fails the build if
 * one does not. The single synchronous caller is described on `recordAuditSync`
 * below.
 *
 * @param {object} db      an open database handle
 * @param {object} entry   `{ adminId, action, targetUserId?, details? }`
 * @returns {Promise<{id: string, createdAt: string}>} what was written
 */
/**
 * Telemetry, resolved once at module load.
 *
 * Dynamic, like `errorReporter.js`'s: `telemetry.js` imports `redactMessage`
 * from that module, and a static import chain here would tie the audit writer
 * to the telemetry module's own load order for no benefit. Fire-and-forget; a
 * failure to load leaves the pulse off and changes nothing else.
 */
let telemetryModule = null;
import('./telemetry.js')
  .then((m) => { telemetryModule = m; })
  .catch(() => { telemetryModule = null; });

function logSecurityEvent(action) {
  if (typeof action !== 'string' || !action) return;
  telemetryModule?.logSecurityEvent?.(action);
}

export async function recordAudit(db, entry) {
  const values = auditValues(db, entry);
  await db.prepare(INSERT_SQL).run(...values);

  /**
   * A pulse to telemetry: the ACTION NAME, and nothing else.
   *
   * ── What is deliberately not sent ──
   *
   * `details` is prose written at ~30 call sites and names people by
   * construction — "Suspended Chris Vale", "Exported the accepted roster for
   * …". So is `targetUserId`. Neither leaves the application. What goes out is
   * `ACCOUNT_SUSPENDED`, a constant from our own source.
   *
   * ── Why here and not at the call sites ──
   *
   * This is the one function every privileged action already passes through,
   * and adding the call at thirty sites would mean thirty chances to pass the
   * wrong thing. The audit table remains the record; this is only so somebody
   * watching Better Stack can see that privileged actions are happening at all
   * without opening a `super_admin` screen.
   *
   * AFTER the row is written and outside its own failure path: telemetry must
   * never be the reason an audit write appears to fail. `logSecurityEvent`
   * cannot throw, and the guard is belt-and-braces on the most consequential
   * table in the schema.
   */
  try {
    logSecurityEvent(entry?.action);
  } catch { /* an audit row is not lost to a telemetry problem */ }

  return { id: values[0], createdAt: values[5] };
}

/**
 * The same write, synchronously, for the one caller that cannot await.
 *
 * ── The one caller ──
 *
 * `dedupeCaseInsensitiveUsernames` in `db.js`, which reconciles usernames that
 * collide only by case before `CREATE UNIQUE INDEX … COLLATE NOCASE` can be
 * built over them. It runs inside `initDatabase()`, which is synchronous and
 * called synchronously from `server.js`, `testServer.js`, four `bin/` scripts
 * and some forty test files — so it cannot await, and making it able to is a
 * boot-path change with nothing to do with this table.
 *
 * ── Why a sync twin rather than a dropped promise ──
 *
 * Calling the async version and not awaiting it would write the row on SQLite
 * (`.run()` executes before the promise is returned) while converting every
 * failure — a bad actor id, a constraint violation — from a throw into an
 * unhandled rejection delivered *after* the enclosing `COMMIT`. The dedupe
 * would then commit renames whose audit rows had failed, which is precisely the
 * silent state the module header calls the quietest failure there is.
 *
 * ── Why it is not duplicated logic ──
 *
 * Validation, the id scheme, the timestamp and the SQL are all shared with
 * `recordAudit` through `auditValues` and `INSERT_SQL`. This function is the
 * two lines that differ, and the two cannot drift.
 *
 * SQLite-only by construction: a PostgreSQL handle returns a promise from
 * `.run()` and this would drop it, so the boot path this serves retires with
 * SQLite. `auditLog.test.js` holds the call site to that one file, by name.
 *
 * @returns {{id: string, createdAt: string}} what was written
 */
export function recordAuditSync(db, entry) {
  const values = auditValues(db, entry);
  db.prepare(INSERT_SQL).run(...values);
  return { id: values[0], createdAt: values[5] };
}

const INSERT_SQL = `
  INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`;

/**
 * Everything both writers do before the INSERT: the handle check, the field
 * allowlist, the required/optional text rules, the UUID and the timestamp.
 *
 * Returns positional values in column order rather than an object, so the two
 * writers cannot bind them differently.
 */
function auditValues(db, entry) {
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

  return [
    `audit-${crypto.randomUUID()}`,
    adminId,
    action,
    targetUserId,
    details,
    providedCreatedAt || new Date().toISOString(),
  ];
}
