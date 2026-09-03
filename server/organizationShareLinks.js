/**
 * The invitation link — an organization's shareable address.
 *
 * ── What this is, and what it deliberately is not ──
 *
 * It is an ADDRESS. Holding it lets somebody open a public projection of the
 * organization without an account, and — where the club has set `join_policy` to
 * `invite` — lets their Join press succeed. It is NOT an authentication
 * credential: it grants no session, no capability, and it never makes anybody a
 * member by itself. Membership is always an explicit act by a signed-in account.
 *
 * That distinction is the whole reason this is safe to put on a flyer. What it
 * opens is `publicOrganization` — the club's own advertisement, carrying no
 * member, no event location and no hours.
 *
 * ── Why the token is stored verbatim ──
 *
 * Migration 062 carries the argument in full. In short: a club's link is a
 * standing address that has to be readable back for as long as it is in
 * circulation, and a digest makes "show me our link again" impossible without
 * replacing it and breaking every copy already handed out. `certificates.code`
 * is the in-repo precedent, for a value of strictly higher sensitivity.
 *
 * ── Why the token is resolved at the moment of the ACT ──
 *
 * `resolveShareToken` is called inside the join handler, from the request body —
 * never cached against a session and never turned into a grant that outlives the
 * request. That is what makes rotation and revocation instant: there is no
 * window in which a page loaded under an old link still carries permission. It
 * is also why the join route asks `tokenOpens(db, thisOrganization, token)`
 * rather than merely "did this token resolve to something": a token for the
 * Chess Club must not open the Robotics Club.
 *
 * ── `db` is a parameter ──
 *
 * Never imported, for the reason `adminInvitations.js` gives: `db.js` opens its
 * file at module scope, so a module that reaches for it cannot be unit tested
 * without a database.
 */

import crypto from 'node:crypto';

/**
 * 32 bytes as hex — the same size and the same source as every other bearer
 * value in this codebase (`server/tokenDigest.js`). 256 bits of uniform entropy,
 * so guessing is not a consideration at any rate limit, and the value carries no
 * structure: it is not derived from the organization id, so holding one link
 * tells you nothing about any other.
 */
const newToken = () => crypto.randomBytes(32).toString('hex');

/** What a stored token has to look like before it is worth a database round trip. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * The path a link points at.
 *
 * The origin is the client's business — whoever is copying the link is already
 * on the right host, which is the same argument `publicOrigin()` makes for the
 * origin printed on a certificate. It also keeps this module free of
 * deployment configuration.
 *
 * No organization id and no slug in the URL: the link says nothing about which
 * club it belongs to until the server resolves it, so it is not a route to
 * enumeration and a leaked link does not even name its subject.
 */
export const shareLinkPath = (token) => `/organizations/invite/${token}`;

/**
 * The organization's current link, or `null`.
 *
 * Returns the token, because reading the link back is the point — see the module
 * header. The AUTHORIZATION for that read is the caller's problem and is decided
 * by `invite_policy` at the route, which is the only place that knows who is
 * asking.
 */
export async function shareLinkFor(db, organizationId) {
  return (await db.prepare(`
    SELECT organization_id AS "organizationId", token, created_at AS "createdAt",
           created_by AS "createdBy", rotations
      FROM organization_share_links WHERE organization_id = ?
  `).get(organizationId)) ?? null;
}

/**
 * Mints the organization's first link, or replaces the one it has.
 *
 * ── One statement, so rotation has no gap ──
 *
 * `INSERT … ON CONFLICT DO UPDATE` rather than delete-then-insert. The
 * alternative leaves a window in which the club has no link at all, and a
 * concurrent `resolveShareToken` landing in that window would answer "no such
 * link" for a club that has one — a rotation that briefly looks like a
 * revocation.
 *
 * The previous token is overwritten, which IS the revocation of the old link:
 * there is never a state in which two links resolve to the same organization.
 *
 * ── What rotation does NOT do ──
 *
 * It does not touch `organization_members`. Everybody already in the club stays
 * in it — the link was the door, not the membership. The confirmation dialog in
 * the client says exactly that, because the manager's likely fear when pressing
 * Regenerate is that they are about to empty their own club.
 *
 * @returns {{ token: string, path: string, rotated: boolean }}
 */
export async function issueShareLink(db, organizationId, { createdBy = null, now = new Date() } = {}) {
  const existing = await shareLinkFor(db, organizationId);
  const token = newToken();

  await db.prepare(`
    INSERT INTO organization_share_links
      (organization_id, token, created_at, created_by, rotations)
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(organization_id) DO UPDATE SET
      token      = excluded.token,
      created_at = excluded.created_at,
      created_by = excluded.created_by,
      /* Plus one against the STORED value, not against excluded.rotations:
         excluded carries what this statement tried to insert, which is always
         zero, so using it would reset the count on every rotation. (No
         backticks in this comment - it lives inside a template literal.) */
      rotations  = organization_share_links.rotations + 1
  `).run(organizationId, token, now.toISOString(), createdBy);

  return { token, path: shareLinkPath(token), rotated: Boolean(existing) };
}

/** Switches the link off. Returns whether there was one to switch off. */
export async function revokeShareLink(db, organizationId) {
  return (await db.prepare(
    'DELETE FROM organization_share_links WHERE organization_id = ?'
  ).run(organizationId)).changes > 0;
}

/**
 * The organization a token opens, or `null`.
 *
 * One indexed equality on `token` — `UNIQUE(token)` supplies the index — so this
 * is never a scan with a comparison per row. That matters for more than speed: a
 * scan comparing secrets in application code is where a timing side channel
 * would live, and there is none here because nothing is compared in JavaScript
 * at all.
 *
 * Returns the organization ROW rather than an id, so the caller needs no second
 * lookup and so "which organization does this token belong to" is answered by
 * the same statement that resolved it. A caller that resolved a token and then
 * loaded an organization from a separate parameter would be one refactor away
 * from accepting one club's token on another club's route.
 *
 * A token for an ARCHIVED organization resolves to nothing. Archiving is the
 * only withdrawal a manager is offered, and a link that kept working through it
 * would make archiving a promise the product does not keep.
 */
export async function resolveShareToken(db, token) {
  /* Shape-checked before the round trip, so a caller cannot make this hash and
     query a megabyte of request body. Nothing outside the shape can match a
     stored value anyway. */
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;

  return (await db.prepare(`
    SELECT o.*
      FROM organization_share_links l
      JOIN organizations o ON o.id = l.organization_id
     WHERE l.token = ? AND o.status = 'active'
  `).get(token)) ?? null;
}

/**
 * Does this token open THIS organization?
 *
 * The question the join route asks, given a name so that it cannot be answered
 * by accident. `resolveShareToken(...)` returning something truthy is not the
 * check — the check is that what came back is the organization in front of us.
 */
export async function tokenOpens(db, organizationId, token) {
  if (!token) return false;
  const org = await resolveShareToken(db, token);
  return Boolean(org && org.id === organizationId);
}
