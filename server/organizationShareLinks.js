/**
 * Invitation links — an organization's shareable addresses.
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
 *
 * ── Why a club has several links rather than one ──
 *
 * A club hands its address out in places that have nothing to do with each
 * other: a printed flyer on a corridor wall, an Instagram bio, a QR code at an
 * event booth, a message to one teacher. With a single link, the only way to
 * retire the flyer that has been on the wall since September is to regenerate —
 * which also breaks the Instagram bio and the teacher's message. Every link
 * therefore has a LABEL and its own life, and revoking one leaves the rest
 * alone.
 *
 * `SOFT_MAX_LIVE_LINKS` bounds the set, because a club with forty live links has
 * lost the property that makes revoking one of them meaningful. It is a product
 * sanity limit and not a security boundary — see the constant.
 *
 * ── What is counted, and what deliberately is not ──
 *
 * A link records `uses` and `last_used_at`, incremented when somebody JOINS
 * through it — not when somebody opens it. Two reasons, and the privacy one
 * comes first:
 *
 *   - A view counter on an unauthenticated endpoint is a write on every
 *     anonymous request, which is both a contention point and an invitation to
 *     inflate. A join is an authenticated, deliberate, non-repeatable act.
 *   - "How many people joined from the flyer" is the question a manager
 *     actually has. "How many times was the page loaded" is a vanity metric,
 *     and the brief asks for management rather than vanity.
 *
 * Nothing per-visitor is stored. There is no row per use, no address, no
 * referrer, no session — a count and a date, which cannot be turned back into
 * who came from where.
 *
 * ── Expiry is optional and never imposed ──
 *
 * `expires_at IS NULL` means the link does not lapse, and that is the default,
 * because the flyer on the wall in September must still work in May. A manager
 * who wants a link for one event booth can set a date; the interface warns
 * before doing it, and an expired link refuses exactly the way a revoked one
 * does rather than quietly admitting somebody a month later.
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
 * How many live links one club may hold — a PRODUCT SANITY LIMIT.
 *
 * ── This is not a security boundary, and the name says so ──
 *
 * Nothing in authorization reads it. The gates that decide who may create,
 * rename, revoke or regenerate a link are `requireCap('organization.manage.own')`
 * and `canManage`, and they are unaffected by how many links exist. Exceeding
 * this number crosses no privilege boundary: the actor is a manager of that
 * club, who could hand the club's one link to any number of people anyway.
 *
 * What it is for: the reason to have several links is to be able to retire one
 * of them knowingly, and a list of forty is a list nobody reads before pressing
 * Revoke. Ten covers every real case the brief names — general, flyer,
 * Instagram, event booth — four times over. Revoked links do not count against
 * it; they are history.
 *
 * ── Why advisory is the correct design, not merely the existing one ──
 *
 * The route counts before it inserts, so a concurrent burst can overshoot. That
 * was measured rather than reasoned about: an eight-way burst against a club
 * holding nine produced seventeen live links, and the very next attempt refused
 * every one. So the overshoot is **bounded by in-flight request count and
 * self-corrects**, never unbounded — because each attempt re-reads.
 *
 * "At most ten rows where `revoked_at IS NULL`" is not expressible as a unique
 * index on either engine, so hard enforcement means a lock held across a write,
 * or a counter column with its own drift problem. Both are real costs paid to
 * prevent a club briefly holding seventeen links it can see and revoke — which
 * is not a problem anybody experiences, and not one an attacker gains anything
 * from creating.
 *
 * The bounds that ARE security-relevant sit elsewhere and are enforced properly:
 * the capability and ownership checks above, and `apiLimiter` on the route.
 * Sustained creation past the ceiling also requires sustained REVOCATION, since
 * the check re-reads — so the ceiling bounds the live set even while permitting
 * churn.
 *
 * `organizations.softLimits.test.js` pins all of that, including that no
 * database constraint claims to enforce it.
 */
export const SOFT_MAX_LIVE_LINKS = 10;

/** How long a label may be. Long enough for "Autumn open-day flyer". */
export const LABEL_MAX = 40;

/** The label a link gets when nobody chose one — and the one migration 063 backfills. */
export const DEFAULT_LABEL = 'General';

/**
 * Validates a label. `{ ok, error, field }`, like every other validator here.
 *
 * Trim and a length bound, which is the same treatment `validateOrganization`
 * gives a name and a description — a label is shown to other managers, never to
 * the public, and it reaches the page as text that React escapes.
 */
export function validateLabel(value, { fallback = DEFAULT_LABEL } = {}) {
  const clean = String(value ?? '').trim();
  if (!clean) return { ok: true, value: fallback };
  if (clean.length > LABEL_MAX) {
    return { ok: false, field: 'label', error: `A label can be at most ${LABEL_MAX} characters.` };
  }
  return { ok: true, value: clean };
}

/**
 * The three states a link can be in, decided in ONE place.
 *
 * Every caller that needs to know whether a link works asks this, so "is it
 * live" cannot be answered one way by the list endpoint and another way by the
 * join handler. The order matters: a link that was revoked AND has since passed
 * its expiry reads as revoked, because that is what the manager did to it.
 */
export function linkState(link, now = new Date()) {
  if (!link) return 'missing';
  if (link.revokedAt ?? link.revoked_at) return 'revoked';
  const expiresAt = link.expiresAt ?? link.expires_at;
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'live';
}

/** True when this link would admit somebody right now. */
export const linkIsLive = (link, now = new Date()) => linkState(link, now) === 'live';

/* The projection every read returns. One list, so a new column cannot reach a
   response by being added to the table — the reason profileSerializer.js is an
   allowlist. The token is included because reading the link back IS the
   feature; who may read it is decided at the route by invite_policy. */
const LINK_COLUMNS = `
  id, organization_id AS "organizationId", token, label,
  created_at AS "createdAt", created_by AS "createdBy",
  expires_at AS "expiresAt", revoked_at AS "revokedAt",
  uses, last_used_at AS "lastUsedAt"
`;

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
 * Every link a club holds, newest first, with the live ones ahead of the rest.
 *
 * Revoked and expired links are INCLUDED. A manager needs to see that the
 * autumn flyer link is the one that stopped working, and hiding it would make
 * the join count and the last-used date — the only record that the flyer worked
 * at all — disappear along with it.
 */
export async function shareLinksFor(db, organizationId) {
  const rows = await db.prepare(`
    SELECT ${LINK_COLUMNS}
      FROM organization_share_links
     WHERE organization_id = ?
     ORDER BY created_at DESC, id DESC
  `).all(organizationId);
  return rows ?? [];
}

/** One link of this club's, or `null`. Scoped by organization on purpose. */
export async function shareLinkById(db, organizationId, linkId) {
  if (typeof linkId !== 'string' || !linkId) return null;
  /* Both columns in the WHERE, always. A handler that looked a link up by id
     alone and trusted the route parameter for the organization would let a
     manager of one club revoke another club's link. */
  return (await db.prepare(`
    SELECT ${LINK_COLUMNS}
      FROM organization_share_links
     WHERE id = ? AND organization_id = ?
  `).get(linkId, organizationId)) ?? null;
}

/**
 * The club's main link: the oldest one still live.
 *
 * OLDEST, not newest, because the oldest live link is the one most likely to be
 * the one in circulation — printed, pinned, forwarded — and this is what the
 * page offers a member who presses Share without wanting to think about which
 * of four links to hand over. `null` when the club has none.
 */
export async function primaryShareLink(db, organizationId, { now = new Date() } = {}) {
  const links = await shareLinksFor(db, organizationId);
  const live = links.filter(link => linkIsLive(link, now));
  return live.length ? live[live.length - 1] : null;
}

/** How many live links a club holds, for the ceiling check. */
export async function liveLinkCount(db, organizationId, { now = new Date() } = {}) {
  const links = await shareLinksFor(db, organizationId);
  return links.filter(link => linkIsLive(link, now)).length;
}

/**
 * Mints a link.
 *
 * ── Why there is no upsert any more ──
 *
 * The single-link version was one `INSERT … ON CONFLICT DO UPDATE`, so that
 * rotation had no window in which the club had no link. With several links that
 * window does not exist: creating one does not touch the others, and rotation
 * is expressed as `rotateShareLink` — revoke this one, mint its replacement,
 * both inside the caller's transaction.
 *
 * @returns {{ id, token, path, label, expiresAt }}
 */
export async function createShareLink(db, organizationId, {
  label = DEFAULT_LABEL, expiresAt = null, createdBy = null, now = new Date(),
} = {}) {
  const token = newToken();
  const id = `oshl-${crypto.randomBytes(9).toString('hex')}`;

  await db.prepare(`
    INSERT INTO organization_share_links
      (id, organization_id, token, label, created_at, created_by, expires_at, uses)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, organizationId, token, label, now.toISOString(), createdBy, expiresAt);

  return { id, token, path: shareLinkPath(token), label, expiresAt };
}

/**
 * Switches one link off, keeping its history.
 *
 * A soft revoke rather than a DELETE. The row records what the link was called
 * and how many people joined through it, and that record is the reason a manager
 * can tell "the flyer worked and I retired it" from "the flyer never worked".
 *
 * `WHERE revoked_at IS NULL` makes this idempotent AND makes the return value
 * mean something: two managers pressing Revoke at the same moment produce one
 * `true` and one `false`, and the timestamp is the first one's.
 */
export async function revokeShareLink(db, organizationId, linkId, { now = new Date() } = {}) {
  const result = await db.prepare(`
    UPDATE organization_share_links
       SET revoked_at = ?
     WHERE id = ? AND organization_id = ? AND revoked_at IS NULL
  `).run(now.toISOString(), linkId, organizationId);
  return result.changes > 0;
}

/**
 * Replaces one link with a fresh one carrying the same label.
 *
 * This is what Regenerate means: the copies in circulation stop working, the
 * label and the reason for the link survive, and — as the confirmation dialog
 * says — nobody loses their membership, because the link was the door and not
 * the roster.
 *
 * Both statements belong to the CALLER's transaction. Half of this applied is a
 * club whose link is revoked with no replacement, which reads as a revocation
 * nobody performed.
 */
export async function rotateShareLink(db, organizationId, linkId, { createdBy = null, now = new Date() } = {}) {
  const existing = await shareLinkById(db, organizationId, linkId);
  if (!existing) return null;
  await revokeShareLink(db, organizationId, linkId, { now });
  return createShareLink(db, organizationId, {
    label: existing.label,
    /* The replacement inherits the expiry deliberately: a link created for one
       event booth should not become permanent by being regenerated. A manager
       who wants it permanent clears the date, which is an explicit act. */
    expiresAt: existing.expiresAt,
    createdBy,
    now,
  });
}

/** Renames a link. Labels are management state; renaming changes no permission. */
export async function renameShareLink(db, organizationId, linkId, label) {
  const result = await db.prepare(`
    UPDATE organization_share_links SET label = ? WHERE id = ? AND organization_id = ?
  `).run(label, linkId, organizationId);
  return result.changes > 0;
}

/**
 * Sets or clears a link's expiry.
 *
 * `null` clears it, which is how a temporary link becomes permanent. Deliberately
 * allowed: the alternative is a manager who set a date by mistake having to
 * regenerate and re-print.
 */
export async function setShareLinkExpiry(db, organizationId, linkId, expiresAt) {
  const result = await db.prepare(`
    UPDATE organization_share_links SET expires_at = ? WHERE id = ? AND organization_id = ?
  `).run(expiresAt, linkId, organizationId);
  return result.changes > 0;
}

/**
 * Records that somebody joined through this link.
 *
 * `uses = uses + 1` against the stored value, in one statement, so two people
 * joining at the same instant cannot read-modify-write each other's count away.
 * Called inside the join transaction: a counted use that did not produce a
 * membership would be a lie, and a membership with an uncounted use loses the
 * only number this feature reports.
 */
export async function recordShareLinkUse(db, organizationId, linkId, { now = new Date() } = {}) {
  await db.prepare(`
    UPDATE organization_share_links
       SET uses = uses + 1, last_used_at = ?
     WHERE id = ? AND organization_id = ?
  `).run(dayOf(now), linkId, organizationId);
}

/**
 * The DATE, deliberately, and not the timestamp.
 *
 * Migration 063 declares `last_used_at` as a date and argues why: "used this
 * week" is what a manager acts on, and the hour somebody joined a club is a
 * fact about that person's evening. With one use on a link — which is the
 * common case for a club inviting a handful of people — a full timestamp is a
 * per-student record of when a named child joined, reachable by anyone who can
 * read the club's links.
 *
 * Truncating is what keeps the column the aggregate the schema says it is.
 */
const dayOf = (at) => at.toISOString().slice(0, 10);

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
export async function resolveShareToken(db, token, { now = new Date() } = {}) {
  /* Shape-checked before the round trip, so a caller cannot make this hash and
     query a megabyte of request body. Nothing outside the shape can match a
     stored value anyway. */
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;

  const row = await db.prepare(`
    SELECT o.*, l.id AS "shareLinkId", l.revoked_at AS "shareLinkRevokedAt",
           l.expires_at AS "shareLinkExpiresAt"
      FROM organization_share_links l
      JOIN organizations o ON o.id = l.organization_id
     WHERE l.token = ? AND o.status = 'active'
  `).get(token);
  if (!row) return null;

  /* Revocation and expiry are checked HERE rather than in the WHERE clause, so
     that one function is the sole authority on what "live" means and the list
     endpoint cannot disagree with the join handler about it. A revoked or lapsed
     link is indistinguishable from one that never existed: same null, so the
     endpoint above it answers the same 404 either way. */
  const state = linkState(
    { revokedAt: row.shareLinkRevokedAt, expiresAt: row.shareLinkExpiresAt },
    now,
  );
  return state === 'live' ? row : null;
}

/**
 * Does this token open THIS organization?
 *
 * The question the join route asks, given a name so that it cannot be answered
 * by accident. `resolveShareToken(...)` returning something truthy is not the
 * check — the check is that what came back is the organization in front of us.
 */
export async function tokenOpens(db, organizationId, token, { now = new Date() } = {}) {
  if (!token) return false;
  const org = await resolveShareToken(db, token, { now });
  return Boolean(org && org.id === organizationId);
}

/**
 * The id of the link that opens THIS organization, or `null`.
 *
 * The same question as `tokenOpens`, answered with the identity of the link so
 * the join handler can count the use against it. Two functions rather than one
 * returning a truthy id, because `if (await tokenOpens(...))` reads as a
 * permission check and `const id = await openingLinkId(...)` reads as a lookup,
 * and a permission check that returns an id invites `if (id)` on a caller that
 * meant to ask about a different club.
 */
export async function openingLinkId(db, organizationId, token, { now = new Date() } = {}) {
  if (!token) return null;
  const org = await resolveShareToken(db, token, { now });
  return org && org.id === organizationId ? org.shareLinkId : null;
}
