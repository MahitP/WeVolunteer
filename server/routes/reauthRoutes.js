import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { JWT_SECRET } from '../config.js';
import { authenticateToken } from '../utils.js';
import { SENSITIVE_ACTIONS, isSensitiveAction } from '../sensitiveActions.js';
import {
  openChallenge, grantByPassword, grantByOAuth, peekChallenge,
  REAUTH_ERRORS, CHALLENGE_TTL_MS
} from '../reauth.js';
import { refuseReauth } from '../reauthResponses.js';
import { resolveProvider } from './oauthRoutes.js';

/**
 * The four endpoints that MINT assurance: open a challenge, then satisfy it
 * with a password or with a fresh provider re-consent.
 *
 * ── What this file is not ──
 *
 * Nothing here authorises anything. A granted challenge is a fact recorded in
 * `reauth_challenges`; it becomes authority only when the endpoint performing
 * the sensitive action spends it with `consumeChallenge`, inside that handler's
 * own transaction, against the action and the params it is actually about to
 * perform. `requireAAL2` in front of that handler is an early refusal, not the
 * check. Splitting it that way is deliberate: a middleware that consumed on the
 * way in would burn the grant whenever the handler then rejected the request
 * for an unrelated reason, leaving the user to re-verify for something that
 * never happened.
 *
 * ── Why re-consent exists at all ──
 *
 * A provider-only account has no password, so before this it confirmed
 * something as irreversible as account deletion by typing its own username —
 * and the handler's own comment conceded the point: "Typing the account's own
 * username is not a credential." A username is public within the app and is
 * visible on every comment the person has ever posted. Re-consent replaces it
 * with an actual credential check, performed by the identity provider.
 *
 * That substitution is only real if the provider genuinely re-authenticates.
 * See `oauth/providers/google.js` for `prompt=login` + `max_age=0`; without
 * them the provider answers from the session it already has, which proves
 * nothing that a stolen session did not already prove — and it fails silently,
 * because the flow still completes.
 *
 * ── Error vocabulary ──
 *
 * `reauth.js` returns a closed set of machine-readable refusals, and
 * `reauthResponses.js` maps each to one status and one sentence, in ONE table,
 * so no route can invent a different answer for the same condition. That table
 * lived here until Task 6 gave the five endpoints that SPEND a grant the same
 * refusals to answer — it moved next door rather than being copied, and this
 * file imports it like they do. `password_unavailable` in particular must never
 * read as "wrong password": the sentinel is not a bcrypt hash, so a naive
 * comparison returns false and tells someone with no password that their
 * password is wrong.
 */

const router = express.Router();
const E = REAUTH_ERRORS;

/**
 * The refusal for a session that cannot have a challenge bound to it.
 *
 * `openChallenge` THROWS on a missing jti — correctly, because a grant bound to
 * no session is spendable by anyone holding the id, which is not a step-up at
 * all. But `authenticateToken` still admits jti-less tokens: they predate
 * per-session revocation and stay valid for up to seven days after a deploy, so
 * this is reachable rather than theoretical. (Provider sign-ins were a second,
 * permanent source of them until Task 6 gave `oauthRoutes.js` the shared
 * `issueSession`; without that fix every provider-signed-in user would have met
 * this refusal on every sensitive action.) Letting the throw escape would
 * answer 500 — filing an ordinary, recoverable situation as a server defect and
 * telling the user nothing they can act on.
 *
 * 401 with its own code, because the remedy is a new session and nothing else:
 * the client signs the user out and back in, and every token minted by
 * authRoutes.js carries a jti.
 */
function requireBindableSession(req, res) {
  if (req.sessionJti) return true;
  res.status(401).json({
    error: 'This sign-in is too old to verify with. Please sign in again.',
    code: 'session_not_bindable'
  });
  return false;
}

/**
 * A stable, non-reversible marker for the caller's address.
 *
 * `reauth_challenges.ip_hash` exists to correlate abandoned and failed
 * verifications during an incident, which a hash serves as well as the address
 * does. Storing the address itself would be storing network metadata about a
 * minor for the sake of a diagnostic, and the sweep's retention window is
 * written around that (see CHALLENGE_RETENTION_MS).
 */
function hashIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

/* ── POST /api/auth/reauth/challenge ─────────────────────────────────────── */

/**
 * Opens a challenge for one action, with its arguments bound in.
 *
 * `params` is folded into the row's `params_hash` here and re-derived from the
 * real request when the grant is spent, so verifying in order to move your
 * address to a@x.com cannot also authorise moving it to the attacker's — the
 * binding most step-up implementations omit.
 */
router.post('/api/auth/reauth/challenge', authenticateToken, async (req, res) => {
  const { action, params } = req.body ?? {};

  /**
   * An unregistered action is a 400, before anything is written.
   *
   * `openChallenge` would throw on it, and the throw is right there — but a
   * typo in a client is a bad request, not a server fault, and the registry is
   * the whole point: the set of things step-up protects is enumerated in one
   * place rather than implied by which endpoints happen to check.
   */
  if (!isSensitiveAction(action)) {
    return res.status(400).json({
      error: 'That is not an action that can be verified.',
      code: 'unknown_action'
    });
  }

  if (!requireBindableSession(req, res)) return;

  let opened;
  try {
    opened = await openChallenge({
      db,
      userId: req.user.id,
      action,
      params: params ?? {},
      sessionJti: req.sessionJti,
      ipHash: hashIp(req)
    });
  } catch (err) {
    console.error('Failed to open a reauth challenge:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  /**
   * An account that can answer nothing is a recovery problem, not a challenge.
   *
   * `openChallenge` narrows the action's methods to the ones THIS account can
   * satisfy and documents that an empty list is left for the caller to reject.
   * Returning it as a normal challenge would hand the client a modal with no
   * buttons and a five-minute countdown. The row it just wrote is left to the
   * sweep: it is ungrantable by construction (no password, no provider), so
   * deleting it here would only add a statement that cannot change any outcome.
   */
  if (opened.methods.length === 0) {
    return res.status(409).json({
      /* Not "your school administrator": WeVolunteer is run independently
         (Posture B), and nobody at a school can reach this account. */
      error: 'This account has no way to verify your identity. Tell us through Report a problem and we will help you get back in.',
      code: 'no_verification_method'
    });
  }

  return res.status(201).json({
    challengeId: opened.id,
    action,
    label: SENSITIVE_ACTIONS[action].label,
    methods: opened.methods,
    expiresAt: opened.expiresAt,
    expiresInSeconds: Math.round(CHALLENGE_TTL_MS / 1000),
    /* The ACCOUNT's remaining guesses, not this row's — so a dialog reopened by
       a page refresh states the budget the server will actually enforce. */
    attemptsRemaining: opened.attemptsRemaining
  });
});

/* ── POST /api/auth/reauth/password ──────────────────────────────────────── */

router.post('/api/auth/reauth/password', authenticateToken, async (req, res) => {
  const { challengeId, password } = req.body ?? {};
  if (!challengeId || typeof challengeId !== 'string') {
    return res.status(400).json({ error: 'Missing verification request.', code: 'missing_challenge' });
  }

  // The password is NOT validated for shape here. Every wrong answer is a wrong
  // answer, and `grantByPassword` is the one place that decides what one costs
  // — splitting that judgement across two files is how an attempt ends up
  // uncounted.
  const result = await grantByPassword({ db, challengeId, userId: req.user.id, password });
  if (!result.ok) return refuseReauth(res, result);

  return res.json({ granted: true, method: 'password' });
});

/* ── GET /api/auth/reauth/oauth/:provider ────────────────────────────────── */

/**
 * Sends the user to their provider to re-authenticate.
 *
 * ── Why this writes nothing ──
 *
 * It is a redirect built from a challenge that already exists plus a signed
 * state, and that is the whole answer to it being a GET. `sameSite: 'lax'`
 * blocks cross-site POST/PATCH/DELETE but permits a top-level GET navigation,
 * so an attacker's page CAN cause this request to be made with the victim's
 * cookie. What it cannot do is supply a challenge id: without one belonging to
 * the caller this route 404s, and with one it changes nothing — the worst
 * available outcome is that the victim is shown their own provider's sign-in
 * page. The grant still requires the callback, which requires the state this
 * response contains.
 *
 * ── Why no nonce cookie, unlike the sign-in flow ──
 *
 * `oauthRoutes.js` pairs its state with a nonce cookie and an `oauth_states`
 * row because at that point in a sign-in there is no session to bind to. Here
 * there is: the state carries `userId` and this session's `jti`, and the
 * callback requires the SAME authenticated session to present it. That is the
 * binding the nonce cookie is a substitute for, not a weaker version of it.
 */
router.get('/api/auth/reauth/oauth/:provider', authenticateToken, async (req, res) => {
  const resolved = resolveProvider(req.params.provider);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const { key: providerName, provider } = resolved;

  const challengeId = typeof req.query.challengeId === 'string' ? req.query.challengeId : null;
  if (!challengeId) {
    return res.status(400).json({ error: 'Missing verification request.', code: 'missing_challenge' });
  }

  if (!requireBindableSession(req, res)) return;

  /**
   * The challenge must exist, belong to the caller, and still be open.
   *
   * `peekChallenge` answers `not_granted` for exactly that state — present,
   * unexpired, unconsumed, unlocked, and awaiting a grant — which is the one
   * case this route should proceed on. `ok` (already granted and still
   * spendable) is also allowed through: that is the user pressing the provider
   * button twice, and `grantByOAuth` treats a re-grant of a live grant as the
   * success it is. Everything else is a genuine refusal, and refusing it HERE
   * rather than after the round trip means the user is not sent to Google to
   * come back to an error.
   */
  const peeked = await peekChallenge({ db, challengeId, userId: req.user.id });
  if (!peeked.ok && peeked.error !== E.NOT_GRANTED) return refuseReauth(res, peeked);

  const state = jwt.sign(
    {
      // Purpose, so a state minted anywhere else in this application — the
      // sign-in flow signs its own with the same key — cannot be spent here.
      purpose: 'reauth',
      challengeId,
      userId: req.user.id,
      provider: providerName,
      jti: req.sessionJti
    },
    JWT_SECRET,
    // Deliberately the challenge's own lifetime. A state that outlived the
    // challenge it names could only ever come back to a refusal.
    { expiresIn: Math.round(CHALLENGE_TTL_MS / 1000) }
  );

  let url;
  try {
    // `forceReauth` is the point of this whole flow: it is what turns "the
    // provider still has a session for somebody" into "the person at the
    // keyboard just proved who they are". See google.js for the full reasoning.
    url = provider.getAuthUrl(state, { forceReauth: true });
  } catch (err) {
    console.error(`Failed to build ${providerName} re-verification URL:`, err);
    return res.status(503).json({ error: `Verifying with ${provider.label} is unavailable right now.` });
  }

  return res.redirect(302, url);
});

/* ── POST /api/auth/reauth/oauth/:provider/callback ──────────────────────── */

router.post('/api/auth/reauth/oauth/:provider/callback', authenticateToken, async (req, res) => {
  const resolved = resolveProvider(req.params.provider);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const { key: providerName, provider } = resolved;

  const { code, state } = req.body ?? {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code. Please try verifying again.' });
  }
  if (!state || typeof state !== 'string') {
    return res.status(400).json({ error: 'Missing state parameter. Please try verifying again.' });
  }

  const invalidState = () => res.status(400).json({
    error: 'That verification link expired or is not valid. Please start again.',
    code: 'invalid_state'
  });

  let decoded;
  try {
    decoded = jwt.verify(state, JWT_SECRET);
  } catch {
    return invalidState();
  }

  /**
   * Four checks on the state, and every one of them is load-bearing.
   *
   * `purpose` — the sign-in and account-link flows sign their own states with
   *   this key, and neither proves anything about who is holding the session.
   * `provider` — a state minted for Google must not be redeemed at Microsoft,
   *   where a different `sub` namespace would be compared against a different
   *   linked row.
   * `userId` — the grant is written against the CALLER, so a state naming
   *   somebody else must not be usable to grant them anything.
   * `jti` — this must be the same sign-in that started the flow. Without it a
   *   state captured from one browser could be redeemed in another, which is
   *   the exact scenario the challenge's session binding exists for.
   *
   * All four are folded into one answer on purpose: telling a caller WHICH of
   * them failed describes the shape of a state they do not hold.
   */
  if (decoded.purpose !== 'reauth') return invalidState();
  if (decoded.provider !== providerName) return invalidState();
  if (decoded.userId !== req.user.id) return invalidState();
  if (!req.sessionJti || decoded.jti !== req.sessionJti) return invalidState();

  let claims;
  try {
    claims = await provider.verifyCallback(code);
  } catch (error) {
    console.error(`Reauth callback error (${providerName}):`, error);
    return res.status(502).json({ error: `We could not complete verification with ${provider.label}. Please try again.` });
  }

  if (!claims || !claims.sub) {
    return res.status(502).json({ error: `${provider.label} did not identify that account.` });
  }

  /**
   * `grantByOAuth` is what compares the returned `sub` against the
   * `provider_user_id` on THIS user's linked row.
   *
   * That comparison, not the successful round trip, is the security of this
   * path. A completed OAuth flow attests who is at the keyboard and nothing
   * more; without the comparison an attacker with a stolen session presses
   * "verify with Google", signs in as themselves, and is re-verified as the
   * victim. Deliberately not re-implemented here — every statement against
   * `reauth_challenges` and its bindings lives in reauth.js, so a second reader
   * cannot quietly implement four of the five.
   */
  const result = await grantByOAuth({
    db,
    challengeId: decoded.challengeId,
    userId: req.user.id,
    provider: providerName,
    subject: claims.sub
  });
  if (!result.ok) return refuseReauth(res, result);

  return res.json({ granted: true, method: 'oauth' });
});

export default router;
