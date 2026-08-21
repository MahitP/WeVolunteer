import crypto from 'crypto';

/**
 * Short-lived check-in codes: minting, redeeming, and sweeping.
 *
 * Takes `db` as a parameter and imports nothing but `node:crypto`, the same
 * boundary `adminInvitations.js` keeps, so the whole thing is testable against
 * an in-memory database and can never reach for a request object.
 *
 * ── The shape of a code ──
 *
 *   wire:    wev1:<43 chars base64url>   (32 random bytes)
 *   at rest: sha256(token), hex, UNIQUE
 *
 * The plaintext is returned exactly once, from `issueCheckinToken`, and stored
 * nowhere. A stolen database gives an attacker hashes of codes that expired
 * five minutes after they were minted.
 *
 * Nothing is encoded IN the code. Not the user, not the event, not the
 * application — those are columns, read from the row the hash finds. A code is
 * a bearer reference to a row, not a container of claims, so there is no
 * payload to tamper with and nothing to leak to somebody who photographs it.
 *
 * The `wev1:` prefix is NOT a security boundary. It exists so the scanner can
 * reject a wifi QR, a product barcode or a URL on the device, with a useful
 * message, without spending a round trip or a rate-limit unit. The server
 * re-checks it anyway, and the version tag makes a future format change
 * detectable rather than ambiguous.
 */

/**
 * Five minutes.
 *
 * Long enough to walk from a queue to the table with the organizer at it.
 * Short enough that a photograph forwarded to a friend is worthless by the time
 * they read the message.
 */
export const CODE_TTL_MS = 5 * 60 * 1000;

const PREFIX = 'wev1:';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Every refusal a scan can produce that the organizer could not already have
 * worked out from their own roster, collapsed into one answer.
 *
 * Modelled on `INVITE_REJECTED`. The reason it is narrower here is explained at
 * `resolveCheckinToken`.
 */
export const CODE_REJECTED = Object.freeze({
  ok: false,
  code: 'code_invalid',
  status: 422,
  error: 'That code did not work. Ask the volunteer to refresh it, or check them in by name.',
});

/** The real reason, for the server log only. Never returned to a caller. */
export function describeScanFailure(reason) {
  return `check-in code refused: ${reason}`;
}

/** Test seam, and the reason the hash is not recomputed in three places. */
export function __hashToken(token) {
  return sha256(token);
}

/**
 * Mints a code for one accepted signup, retiring any previous one.
 *
 * Both statements run in the caller's transaction. The unique partial index on
 * `(application_id) WHERE status = 'pending'` is what makes the retirement
 * atomic — without it, two refreshes racing would leave two live codes, and a
 * photograph of the older one would still work.
 *
 * @returns {{token: string, id: string, expiresAt: string, issuedAt: string}}
 */
export async function issueCheckinToken(db, { application, now = new Date() }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(new Date(now).getTime() + CODE_TTL_MS).toISOString();
  const id = `chk-${crypto.randomUUID()}`;

  await db.prepare(`
    UPDATE checkin_tokens SET status = 'replaced', resolved_at = ?
    WHERE application_id = ? AND status = 'pending'
  `).run(issuedAt, application.id);

  await db.prepare(`
    INSERT INTO checkin_tokens
      (id, token_hash, application_id, event_id, slot_id, user_id, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id, sha256(token), application.id, application.event_id,
    application.slot_id, application.user_id, issuedAt, expiresAt,
  );

  return { token: `${PREFIX}${token}`, id, issuedAt, expiresAt };
}

/**
 * Resolves a scanned code, and spends it if it is good.
 *
 * ── Where the line between "tell them" and "say nothing" is drawn ──
 *
 * `adminInvitations` collapses every failure into one answer because the caller
 * there is an anonymous token-holder probing for live invitations, and any
 * distinction is a probe result.
 *
 * The caller here is a named, authenticated organizer who already holds
 * `attendance.mark` on this specific event and can mark any of these people
 * present by hand, on the screen they are already looking at. There is nothing
 * left to withhold from them about their own roster, and invitation-grade
 * opacity would cost real usability — at a noisy park, "that did not work"
 * cannot be told apart from a smeared camera lens.
 *
 * So: collapse everything about WHETHER A CODE EXISTS in the system, and
 * disclose everything the organizer could already learn from their roster or
 * from the phone being held up to them.
 *
 *   collapsed (422)  malformed, unknown, already replaced, already spent,
 *                    expired and belonging to some other event, or resolving to
 *                    a signup that is no longer accepted
 *   named (410/409)  expired for THIS event, or live for a DIFFERENT event
 *
 * The second group is reachable only by presenting a real code this server
 * minted, and each tells the organizer something actionable about a person
 * standing in front of them who volunteered to show it.
 *
 * @returns {{ok: true, row: object} | typeof CODE_REJECTED & {logReason: string}}
 */
export async function resolveCheckinToken(db, { token, eventId, now = new Date() }) {
  if (typeof token !== 'string' || !token) {
    return { ...CODE_REJECTED, logReason: describeScanFailure('no code supplied') };
  }
  if (!token.startsWith(PREFIX)) {
    return { ...CODE_REJECTED, logReason: describeScanFailure('not a WeVolunteer code') };
  }

  const row = await db.prepare('SELECT * FROM checkin_tokens WHERE token_hash = ?')
    .get(sha256(token.slice(PREFIX.length)));

  if (!row) {
    return { ...CODE_REJECTED, logReason: describeScanFailure('no such code') };
  }
  if (row.status === 'replaced') {
    return { ...CODE_REJECTED, logReason: describeScanFailure('code was refreshed') };
  }
  if (row.status === 'used') {
    return { ...CODE_REJECTED, logReason: describeScanFailure('code already spent') };
  }

  const expired = new Date(row.expires_at).getTime() <= new Date(now).getTime();
  const wrongEvent = row.event_id !== eventId;

  /* Expiry is checked before the event, so a stale code for somebody else's
     event does not reveal that it is for somebody else's event. */
  if (expired) {
    if (wrongEvent) {
      return { ...CODE_REJECTED, logReason: describeScanFailure('expired, and for another event') };
    }
    return {
      ok: false,
      status: 410,
      code: 'code_expired',
      error: 'That code has expired. Ask them to refresh it and try again.',
      logReason: describeScanFailure('expired'),
    };
  }

  if (wrongEvent) {
    /* Deliberately does not name the other event: one bit — "this is for
       something else" — is enough to stop the organizer chasing a phantom bug,
       and two events at one school on one morning is a real Saturday. */
    return {
      ok: false,
      status: 409,
      code: 'code_wrong_event',
      error: 'That code is for a different event.',
      logReason: describeScanFailure('code belongs to another event'),
    };
  }

  return { ok: true, row };
}

/**
 * Marks a code spent. Returns false if somebody else spent it first.
 *
 * The `status = 'pending'` predicate in the WHERE clause is the whole of the
 * replay protection: two organizers scanning the same phone at the same instant
 * both reach here, and exactly one UPDATE matches a row.
 */
export async function consumeCheckinToken(db, { tokenId, actorId, now = new Date() }) {
  const result = await db.prepare(`
    UPDATE checkin_tokens
    SET status = 'used', resolved_at = ?, resolved_by = ?
    WHERE id = ? AND status = 'pending'
  `).run(new Date(now).toISOString(), actorId, tokenId);

  return result.changes === 1;
}

/**
 * Deletes codes that expired more than a day ago.
 *
 * A day rather than immediately, so "did Leo's code work this morning?" is
 * still answerable in the afternoon. Beyond that it is credential material with
 * no remaining purpose, which is the same reason `tfa_email_codes` is swept.
 */
export async function sweepCheckinTokens(db, now = new Date()) {
  const cutoff = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  return (await db.prepare('DELETE FROM checkin_tokens WHERE expires_at < ?').run(cutoff)).changes;
}
