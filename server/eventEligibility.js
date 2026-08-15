import { db } from './db.js';

/**
 * May this person apply to this event at all?
 *
 * ── Why this is one module and not a check in the route ──
 *
 * "Can they apply" has two organization-shaped answers — are they banned, and is
 * the event restricted to members — and both have to be decided in the same
 * place for the same reason: an event belongs to an organization, and the
 * organization decides who may take part in it. Splitting them across two
 * conditionals in a handler is how one of them ends up guarded on a route
 * somebody added later and the other does not.
 *
 * ── Why it takes an event ROW and not an id from the caller ──
 *
 * Every fact used here is read from the event as stored: its organization, its
 * audience. Nothing the client sends decides who they must be a member of.
 * A request may name a slot; it may not name the organization it wants to be
 * checked against.
 */

/** The audiences an event may have. Stored on `events.audience`. */
export const EVENT_AUDIENCES = Object.freeze(['everyone', 'organization']);

/**
 * The default for an event that has never said otherwise.
 *
 * Every event that existed before the column did is open to everyone, which is
 * what it was in practice — so the migration backfills this rather than leaving
 * NULL to be interpreted differently by each reader.
 */
export const DEFAULT_AUDIENCE = 'everyone';

/**
 * The reasons an application may be refused, as codes the client can branch on.
 *
 * A code rather than a message, because the same refusal is phrased differently
 * on a card, in a modal and in a toast, and a client that matches on prose
 * breaks when the prose improves.
 */
export const INELIGIBLE = Object.freeze({
  BANNED: 'organization_banned',
  NOT_MEMBER: 'organization_members_only',
  OWN_EVENT: 'own_event',
});

/**
 * Is this person banned from the organization running this event?
 *
 * Only an ACTIVE ban counts. A lifted ban is history, and migration 044's
 * uniqueness is partial for exactly that reason — lifted rows accumulate.
 */
export function activeBanFor(organizationId, userId) {
  if (!organizationId || !userId) return null;
  return db.prepare(`
    SELECT reason FROM organization_bans
     WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
  `).get(organizationId, userId) || null;
}

/** Is this person a member of the organization — of any rank? */
export function isMemberOf(organizationId, userId) {
  if (!organizationId || !userId) return false;
  return Boolean(db.prepare(
    'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(organizationId, userId));
}

/**
 * The whole decision, for one person and one event.
 *
 * Returns `{ ok: true }` or `{ ok: false, code, status, error }` — the refusal
 * carries its own HTTP status so every caller answers the same way, rather than
 * each route choosing between 403 and 409 on the day it was written.
 *
 * @param {object} event a row from `events` — needs `organization_id`,
 *   `audience` and `organizer_id`
 * @param {string} userId the applicant
 */
export function eventApplicationEligibility(event, userId) {
  if (!event || !userId) return { ok: true };

  const organizationId = event.organization_id || null;
  const audience = event.audience || DEFAULT_AUDIENCE;

  /**
   * You cannot apply to your own event.
   *
   * An organizer taking one of the places they are responsible for filling is a
   * conflict at the moment it matters most — deciding who else gets in — and it
   * is the one case where the person picking and the person picked are the
   * same. Checked before membership, because it is true whatever the audience
   * is and whether or not an organization is involved.
   */
  if (event.organizer_id && event.organizer_id === userId) {
    return {
      ok: false,
      code: INELIGIBLE.OWN_EVENT,
      status: 403,
      error: 'You cannot apply to an event you are running.',
    };
  }

  /* No organization, nothing organizational to enforce. A public event posted
     by an individual organizer is unaffected by any of this. */
  if (!organizationId) return { ok: true };

  const ban = activeBanFor(organizationId, userId);
  if (ban) {
    return {
      ok: false,
      code: INELIGIBLE.BANNED,
      status: 403,
      /* The reason is theirs — they were sent it when the ban was issued, and
         withholding it here would mean the one place they meet the consequence
         is the one place it is not explained. */
      error: 'You cannot apply to this organization’s events while this ban is active.',
      reason: ban.reason,
    };
  }

  if (audience === 'organization' && !isMemberOf(organizationId, userId)) {
    return {
      ok: false,
      code: INELIGIBLE.NOT_MEMBER,
      status: 403,
      error: 'This event is for members of the organization running it.',
    };
  }

  return { ok: true };
}
