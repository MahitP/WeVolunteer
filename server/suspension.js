/**
 * Whether an account is suspended RIGHT NOW.
 *
 * ── Why this is a module and not two `account_status === 'suspended'` checks ──
 *
 * Suspension is enforced at exactly two places — `authenticateToken` in
 * `utils.js`, on every authenticated request, and the sign-in handler in
 * `authRoutes.js` — and before timed suspension both simply compared
 * `account_status`. Adding an end date to that shape means adding the same date
 * arithmetic to both, and the failure mode of getting it wrong in one is not
 * symmetric: miss it in sign-in and a student whose week is up cannot get back
 * in; miss it in `authenticateToken` and a suspended person keeps a working
 * session. One is an annoyance, the other is the thing suspension exists to
 * prevent.
 *
 * So there is one predicate, both call it, and `suspension.test.js` pins that
 * neither file compares the status string itself any more.
 *
 * ── Why the data is authoritative and the sweep is only a tidier ──
 *
 * `isSuspended` derives the answer from the row on every read. A suspension whose
 * deadline has passed stops applying at that instant, with no background work
 * involved — so a process that was down over the weekend cannot leave somebody
 * locked out past their own end date. That is the difference between a real
 * expiry and a scheduled job pretending to be one.
 *
 * `sweepExpiredSuspensions` then normalises those rows so that administrative
 * views, which read `account_status` directly in a dozen places, do not describe
 * a person as suspended when they are not. If it never ran, access would still be
 * correct and only the labelling would lag.
 *
 * This module imports nothing but takes `db` as an argument, for the reason
 * `authz.js` gives: a module that reaches for `db.js` itself cannot be unit
 * tested without booting a database, and `db.js` opens its file at module scope.
 */

/**
 * Is this suspension still in force?
 *
 * `row` is any object carrying `account_status` and `suspended_until` — a users
 * row, or the narrower projection `authenticateToken` selects.
 *
 * A malformed `suspended_until` FAILS CLOSED, i.e. counts as indefinite. The
 * alternative is that unparseable data silently releases somebody a moderator
 * suspended, and between "stays locked out until a human looks" and "quietly
 * un-suspended by a typo", only the first is recoverable.
 */
export function isSuspended(row, now = new Date()) {
  if (!row || row.account_status !== 'suspended') return false;
  if (!row.suspended_until) return true;                 // indefinite

  const until = Date.parse(row.suspended_until);
  if (Number.isNaN(until)) return true;                  // unreadable → still suspended

  return until > now.getTime();
}

/** The inverse, for readability at call sites that ask the positive question. */
export function suspensionHasExpired(row, now = new Date()) {
  return Boolean(row)
    && row.account_status === 'suspended'
    && Boolean(row.suspended_until)
    && !isSuspended(row, now);
}

/**
 * Normalises one row whose deadline has passed, and reports whether it did.
 *
 * Called from the enforcement points so the account the person is actively using
 * is corrected immediately rather than waiting for the sweep. Idempotent: a
 * second call finds `account_status` already 'active' and does nothing.
 *
 * `suspension_reason`, `suspended_at` and `suspended_by` are deliberately kept.
 * "This account was suspended in March, for this reason, by this administrator"
 * stays true after the suspension ends; an appeal is reviewable years later, and
 * a moderator handling a repeat incident needs to know there was a first one. The
 * audit row that would otherwise carry it is swept at 365 days.
 *
 * `token_version` is NOT bumped. It was already bumped when the suspension was
 * imposed, which ended every session the account held, so there is nothing left
 * to invalidate — and bumping again would be one more forced sign-out for
 * somebody who has just been let back in.
 */
export async function liftIfExpired(db, row, now = new Date()) {
  if (!suspensionHasExpired(row, now)) return false;

  await db.prepare(`
    UPDATE users
       SET account_status = 'active',
           suspension_lifted_at = ?
     WHERE id = ? AND account_status = 'suspended'
  `).run(now.toISOString(), row.id);

  return true;
}

/**
 * Lifts every suspension whose deadline has passed.
 *
 * Returns the ids it lifted rather than a count, so the caller can log who and
 * a test can assert which. Deliberately NOT wrapped in a transaction spanning
 * the whole set: each row is independent, and one unparseable date must not
 * prevent forty correct rows from being released.
 *
 * The `suspended_until <= ?` comparison is a string comparison, which is correct
 * for ISO-8601 UTC and is why both write paths store that form — the incident
 * behind that rule is in `adminRoutes.js`, where `datetime('now','+30 days')`
 * wrote a zone-less string that `new Date()` then read as local time.
 */
export async function sweepExpiredSuspensions(db, { now = new Date() } = {}) {
  const stamp = now.toISOString();

  const due = await db.prepare(`
    SELECT id, account_status, suspended_until FROM users
     WHERE account_status = 'suspended'
       AND suspended_until IS NOT NULL
       AND suspended_until <= ?
  `).all(stamp);

  const lifted = [];
  for (const row of due) {
    // Through `liftIfExpired` rather than one bulk UPDATE, so the "has it really
    // expired" decision is made by the same predicate that guards access. A bulk
    // statement would be a second, subtly different definition of expired.
    if (await liftIfExpired(db, row, now)) lifted.push(row.id);
  }
  return lifted;
}

/**
 * What a suspended person is told about their own suspension.
 *
 * ── Why this exists at all ──
 *
 * Until now the answer was "nothing, from an authenticated place". A suspended
 * account was refused a session outright, and the note beside that refusal in
 * `authRoutes.js` said so plainly: "there is deliberately no authenticated place
 * to repeat it, because a suspended account never gets a session — which is the
 * whole point of the suspension."
 *
 * That was a defensible reading of the point, and it had one bad consequence.
 * Everything the person was told arrived in a single email at the moment they
 * were suspended. Lose it, never receive it, or read it a week later on a
 * different device, and the product's answer to "why can I not get in" was a
 * sentence on a login form telling them to write to an address. For a platform
 * whose users are mostly minors, being locked out with no durable, re-readable
 * statement of what happened is the part that fails them.
 *
 * So a suspended session now exists, reaches almost nothing (see
 * `suspendedMayReach`), and carries this.
 *
 * ── What may be in it, and what may not ──
 *
 * These are facts about the reader's OWN account, returned only to a session
 * that has already proved it is them. That is what makes the end date sayable
 * here when it is not sayable on the login form: the objection recorded there is
 * that the date "must not be readable by anyone who types their address into a
 * form", and a caller holding a valid session for this account is not that.
 *
 * The suspending administrator is deliberately NOT named. The reason is written
 * for the person, and who wrote it is between them and the appeal process — a
 * name here turns a moderation decision into a personal one, on a platform where
 * the moderator may be a student's own teacher.
 */
export function suspensionNotice(row, now = new Date()) {
  if (!isSuspended(row, now)) return null;

  return {
    /** The words the administrator wrote. Shown verbatim — see MIN_SUSPENSION_REASON. */
    reason: row.suspension_reason ?? null,
    /** When it started. */
    since: row.suspended_at ?? null,
    /**
     * When it ends, or null for indefinite.
     *
     * Null and "indefinite" are reported separately rather than being inferred
     * from each other at every call site, because a client that reads a missing
     * date as "ends soon" is the failure this field exists to prevent.
     */
    until: row.suspended_until ?? null,
    indefinite: !row.suspended_until,
  };
}
