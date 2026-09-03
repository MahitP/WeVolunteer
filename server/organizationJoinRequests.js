/**
 * Asking to join a club, and being told yes or no.
 *
 * ── Why the rules live here and not in the handlers ──
 *
 * Almost every rule in this feature is a refusal, and refusals written in
 * handlers get copied when a second entry point appears. What makes a request
 * live, what makes a decision valid, and what happens to a pending request when
 * somebody gets in by another route are stated once, here; the routes decide who
 * is asking.
 *
 * `db` is a parameter, never imported — the same reason `adminInvitations.js`
 * and `relationships.js` take it: `db.js` opens its file at module scope, so a
 * module that reaches for it cannot be unit tested without a database.
 *
 * ── Every transition is a CONDITIONAL update ──
 *
 * Not "read the row, check the status, write the row". Every function below
 * writes `… WHERE id = ? AND status = 'pending'` and reports `changes === 0` as
 * a conflict. That is what makes two managers pressing Accept at the same moment
 * produce one membership and one honest 409, rather than two writes racing over
 * the same row. Relational consistency is the database's job; this module's job
 * is to ask it correctly.
 */

import crypto from 'node:crypto';
import { isUniqueViolation } from './db/dialectSql.js';

/** Every status the column may hold — mirrors the CHECK in migration 062. */
export const REQUEST_STATUSES = Object.freeze(['pending', 'accepted', 'rejected', 'withdrawn']);

/** The two things a manager may answer. */
export const REQUEST_DECISIONS = Object.freeze(['accept', 'reject']);

const newId = () => `orq-${crypto.randomUUID()}`;

/**
 * This person's live request for this organization, or `null`.
 *
 * Only ever the pending one. A rejected request from September is history, not a
 * state the page should render — showing "you were declined" for ever would make
 * a club's answer permanent in a way the schema deliberately does not.
 */
export async function pendingRequestFor(db, organizationId, userId) {
  if (!organizationId || !userId) return null;
  return (await db.prepare(`
    SELECT id, created_at AS "createdAt"
      FROM organization_join_requests
     WHERE organization_id = ? AND user_id = ? AND status = 'pending'
  `).get(organizationId, userId)) ?? null;
}

/**
 * Files a request, or reports the one that already exists.
 *
 * ── Idempotent by construction, not by checking first ──
 *
 * `idx_org_join_requests_live` is a partial unique index over
 * `(organization_id, user_id) WHERE status = 'pending'`, so a second concurrent
 * insert is a unique violation rather than a second row. Catching it and
 * returning the existing request makes a double press the same success as a
 * single one — which is what the join route already does with
 * `ON CONFLICT DO NOTHING`, and for the same reason: tapping a button twice is
 * not an error worth an error page.
 *
 * A read-then-write check would look identical in every test written on one
 * connection and would produce two live requests under real concurrency, after
 * which accepting one leaves the other pending for ever.
 *
 * @returns {{ id: string, createdAt: string, created: boolean }}
 */
export async function requestToJoin(db, organizationId, userId, { now = new Date() } = {}) {
  const existing = await pendingRequestFor(db, organizationId, userId);
  if (existing) return { ...existing, created: false };

  const id = newId();
  const createdAt = now.toISOString();
  try {
    await db.prepare(`
      INSERT INTO organization_join_requests
        (id, organization_id, user_id, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(id, organizationId, userId, createdAt);
  } catch (err) {
    /* `isUniqueViolation` rather than a message match: the string SQLite uses
       ("UNIQUE constraint failed") is not the one PostgreSQL uses, and
       `certificates.js` records what happens when only one is recognised — a
       retryable collision becomes a hard failure on the other engine. */
    if (!isUniqueViolation(err)) throw err;
    const raced = await pendingRequestFor(db, organizationId, userId);
    /* The row that exists now is authoritative. If it has somehow gone already
       — decided between the violation and this read — report no request rather
       than inventing one. */
    return raced ? { ...raced, created: false } : { id: null, createdAt: null, created: false };
  }

  return { id, createdAt, created: true };
}

/**
 * The requester takes it back.
 *
 * `withdrawn` rather than a DELETE, so the partial unique index lets them ask
 * again later while the fact that they once asked survives. Returns whether
 * anything changed, so a second press is a no-op rather than a failure.
 */
export async function withdrawRequest(db, organizationId, userId, { now = new Date() } = {}) {
  return (await db.prepare(`
    UPDATE organization_join_requests
       SET status = 'withdrawn', decided_at = ?
     WHERE organization_id = ? AND user_id = ? AND status = 'pending'
  `).run(now.toISOString(), organizationId, userId)).changes > 0;
}

/**
 * Retires a pending request because the person is now a member by another route.
 *
 * Called from inside the join transaction. `withdrawn` rather than `accepted`
 * because nobody decided it: a request that has been overtaken by events is not
 * a manager's approval, and recording it as one would put a decision in
 * somebody's mouth. `decided_by` stays NULL, which is what says so.
 */
export async function retireRequestOnJoin(db, organizationId, userId, { now = new Date() } = {}) {
  return await withdrawRequest(db, organizationId, userId, { now });
}

/**
 * The manager's queue: who is waiting, oldest first.
 *
 * Returns the raw member rows. The CALLER runs them through `profileSummary` —
 * the same strict allowlist the roster and directory search use — so a queue of
 * students cannot become the route by which a manager reads a field a profile
 * would have withheld. That serialization is deliberately not done here, because
 * this module takes `db` and knows nothing about principals.
 */
export async function pendingRequests(db, organizationId, { limit = 100 } = {}) {
  return await db.prepare(`
    SELECT r.id, r.created_at AS "createdAt",
           u.id AS "userId", u.username, u.name, u.avatar,
           u.profile_picture_url, u.role, u.location
      FROM organization_join_requests r
      JOIN users u ON u.id = r.user_id
     WHERE r.organization_id = ? AND r.status = 'pending'
       AND u.account_status = 'active'
     ORDER BY r.created_at ASC
     LIMIT ?
  `).all(organizationId, limit);
}

/** How many are waiting — for the badge, without loading the queue. */
export async function pendingRequestCount(db, organizationId) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM organization_join_requests
     WHERE organization_id = ? AND status = 'pending'
  `).get(organizationId);
  return Number(row?.n ?? 0);
}

/**
 * Accepts or rejects one request.
 *
 * ── The conditional update is the concurrency control ──
 *
 * Two managers opening the queue and both pressing Accept is the ordinary case,
 * not an exotic one: the queue is a shared list and there is nothing to stop
 * them. `WHERE id = ? AND organization_id = ? AND status = 'pending'` means
 * exactly one of them changes a row. The other gets `changes === 0` and is told
 * the request was already decided, which is true and is what they need to know.
 *
 * `organization_id` is in the WHERE clause as well as `id`. Request ids are
 * random UUIDs, so this is not a guessing defence — it is the thing that stops a
 * manager of one club deciding a request belonging to another by pasting an id
 * into a route scoped to theirs.
 *
 * ── This does NOT insert the membership row ──
 *
 * The route does, inside the same transaction, because admitting somebody also
 * has to recompute their helper capabilities (`syncOrganizerCapabilities`) and
 * write the audit row. Keeping the membership write at the route means there is
 * one place that knows what admitting somebody entails, rather than two that
 * have to be kept in step.
 *
 * @returns {'decided'|'already_decided'|'not_found'}
 */
export async function decideRequest(db, { organizationId, requestId, decision, deciderId, now = new Date() }) {
  if (!REQUEST_DECISIONS.includes(decision)) {
    throw new Error(`decideRequest: unknown decision ${decision}`);
  }

  const changed = (await db.prepare(`
    UPDATE organization_join_requests
       SET status = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND organization_id = ? AND status = 'pending'
  `).run(
    decision === 'accept' ? 'accepted' : 'rejected',
    now.toISOString(), deciderId, requestId, organizationId,
  )).changes > 0;

  if (changed) return 'decided';

  /* Distinguish "somebody beat you to it" from "no such request here". Both are
     refusals, but only the first has a sensible thing for the client to do —
     refresh the queue — and telling a manager "no such request" for one they can
     see on screen reads as the product being broken. Safe to distinguish: the
     caller has already proved they manage this organization. */
  const row = await db.prepare(
    'SELECT status FROM organization_join_requests WHERE id = ? AND organization_id = ?'
  ).get(requestId, organizationId);
  return row ? 'already_decided' : 'not_found';
}

/**
 * The user id behind a request, for the notification the route sends.
 *
 * Read separately rather than returned from `decideRequest`, because that
 * function's return value is about what HAPPENED and conflating "who" with
 * "whether" is how a caller ends up notifying somebody about a decision that did
 * not take.
 */
export async function requestSubject(db, organizationId, requestId) {
  return (await db.prepare(`
    SELECT user_id AS "userId", status
      FROM organization_join_requests
     WHERE id = ? AND organization_id = ?
  `).get(requestId, organizationId)) ?? null;
}
