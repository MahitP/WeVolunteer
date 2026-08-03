import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { JWT_SECRET, COOKIE_NAME, cookieOptions, OAUTH_PROVIDERS_ENABLED } from '../config.js';
import { authenticateToken, formatUserResponse, inTransaction } from '../utils.js';
import { requireAAL2 } from '../authz.js';
import { ChallengeNotSpent, refuseReauth, spendChallenge } from '../reauthResponses.js';
// Directly, not through `spendChallenge`: that helper reads its three bindings
// off an authenticated `req`, and the OAuth callback has none — it is reached
// mid-redirect with the bindings carried in the signed state instead.
import { consumeChallenge } from '../reauth.js';
import { validateAccountFields } from '../accountValidation.js';
import { issueVerificationToken, sendVerificationMail } from '../services/verification.js';
import { issueSession } from './authRoutes.js';

import googleProvider from '../oauth/providers/google.js';
import microsoftProvider from '../oauth/providers/microsoft.js';
import appleProvider from '../oauth/providers/apple.js';

const router = express.Router();
const OAUTH_STATE_COOKIE = 'wev_oauth_state';
const SIGNUP_SESSION_TTL_MS = 15 * 60 * 1000;

const providers = {
  google: googleProvider,
  microsoft: microsoftProvider,
  apple: appleProvider
};

/**
 * Resolves `:provider` to a usable provider, or to the reason it isn't one.
 *
 * Unsupported (404), known-but-unbuilt (501) and known-but-unconfigured (503)
 * are genuinely different situations, and the UI says something different
 * about each. Collapsing them into one 400 "Unsupported provider" is why
 * pressing "Continue with Apple" used to fail silently.
 *
 * Exported for `reauthRoutes.js`, which needs the same four-way answer for the
 * step-up re-consent flow. Shared rather than copied: a second provider table
 * would be a second place to register a provider, and the failure mode of
 * forgetting one is a button that 404s only in the flow nobody tested. Route
 * modules already import from each other this way (accountRoutes.js takes
 * `OAUTH_ONLY` and `issueSession` from authRoutes.js).
 */
export function resolveProvider(name) {
  const key = String(name || '').toLowerCase();
  const provider = providers[key];
  if (!provider) {
    return { ok: false, status: 404, error: 'That sign-in provider is not supported.' };
  }
  if (provider.implemented === false) {
    return { ok: false, status: 501, error: `Signing in with ${provider.label} is not available yet.` };
  }
  if (!OAUTH_PROVIDERS_ENABLED[key]) {
    return {
      ok: false,
      status: 503,
      error: `Signing in with ${provider.label} is not set up on this site. Use your email address instead.`
    };
  }
  return { ok: true, key, provider };
}

/**
 * The signed-in user, if there is one — for the "connect this provider to my
 * existing account" flow.
 *
 * Reads the session COOKIE. It previously read only an `Authorization: Bearer`
 * header, which this app has not used since sessions moved into an HttpOnly
 * cookie; the client was sending the literal string "Bearer undefined". The
 * result was that linking from Settings never recognised the user, so
 * connecting Google to your own account demanded your password — and if the
 * Google address differed from your account address, dropped you into the
 * signup form while already signed in.
 */
function currentUserFromRequest(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const row = db.prepare('SELECT id, token_version, account_status FROM users WHERE id = ?').get(decoded.id);
    if (!row || row.account_status !== 'active') return null;
    if ((decoded.tokenVersion ?? 0) !== row.token_version) return null;
    return { id: row.id };
  } catch {
    return null;
  }
}

/**
 * This request's session id, for binding a challenge that will be spent later.
 *
 * Separate from `currentUserFromRequest` above rather than folded into it: that
 * function answers "who is this", is called on paths that have no interest in
 * the session's identity, and returns a deliberately minimal `{ id }`. Widening
 * it would put a claim into every caller's hands for the sake of one.
 *
 * Returns null on a token minted before per-session revocation existed.
 * `openChallenge` refuses to bind a grant to a null jti, so such a session
 * simply cannot start an auto-link — which is the correct answer, not a bug:
 * the remedy is signing in again, and every token authRoutes.js mints has one.
 */
function currentSessionJti(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET).jti ?? null;
  } catch {
    return null;
  }
}

function purgeExpiredSignupSessions() {
  try {
    const now = new Date().toISOString();
    db.prepare('DELETE FROM oauth_signup_sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
  } catch (err) {
    console.error('Failed to purge expired OAuth sessions/states:', err);
  }
}

/**
 * Sessions are minted by `authRoutes.js`, not here.
 *
 * ── Why this file no longer has its own (v1.2b Task 6) ──
 *
 * It had a near-copy that differed in exactly one claim: no `jti`. Everything
 * that identifies ONE session rather than an account keys on that claim, so a
 * provider sign-in silently produced a second-class session:
 *
 *   - `POST /api/auth/logout` revokes by jti, so signing out of one device did
 *     nothing for a provider-signed-in user.
 *   - `openChallenge` REFUSES to bind a grant to a jti-less session, because a
 *     grant nobody's session owns is spendable by anyone holding its id. With
 *     v1.2b that is decisive: every one of the five sensitive actions now needs
 *     a grant, so a provider-signed-in user would have been answered
 *     `session_not_bindable` on all five — locked out of deleting their own
 *     account, setting a first password, linking a second provider and
 *     exporting their data. Those are the exact capabilities this release exists
 *     to give provider-only accounts, and the copy here would have quietly
 *     withheld them from every account that reached the app through a provider.
 *
 * Duplicating session minting is what allowed the two to drift for as long as
 * nothing depended on the difference. One definition now, imported like
 * `OAUTH_ONLY` beside it.
 */

/** Which buttons the client should render. Public: it reveals only deployment config. */
router.get('/api/oauth/providers', (req, res) => {
  res.json(
    Object.entries(providers).map(([key, p]) => ({
      id: key,
      label: p.label || key,
      enabled: Boolean(OAUTH_PROVIDERS_ENABLED[key]),
      implemented: p.implemented !== false
    }))
  );
});

/**
 * Begins the flow. POST, not GET.
 *
 * It was a GET taking `?signupData=<base64>` — and that blob contained the
 * password the user had just typed on the signup form. A plaintext password
 * therefore travelled in a URL, which lands in the access log of every proxy
 * in front of the app, and was then stored, still in plaintext, in
 * oauth_signup_sessions for fifteen minutes. The password is no longer sent at
 * all (see below), and what remains is a body rather than a query string.
 */
router.post('/api/oauth/:provider/url', (req, res) => {
  const resolved = resolveProvider(req.params.provider);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const { key: providerName, provider } = resolved;

  const nonce = crypto.randomBytes(32).toString('hex');
  const statePayload = { nonce, provider: providerName };

  const user = currentUserFromRequest(req);
  if (user) statePayload.userId = user.id;

  /**
   * The step-up grant for an auto-link, carried through the signed state.
   *
   * ── Why the challenge has to travel this way ──
   *
   * The callback below adds a provider to an existing account in its
   * `auto_linked` branch, and that row is a NEW WAY TO SIGN IN: from then on
   * the callback's first branch logs in anyone presenting that provider
   * identity, for as long as the link exists. `POST /api/oauth/link` — the
   * other door to the same state change — is gated on `requireAAL2`, but that
   * endpoint only serves the caller who is NOT already signed in as the account
   * being linked — `link_required`, returned below when an account holds the
   * provider's own address but this session does not belong to it. The
   * distinction between the two doors is the SESSION, not the address: both
   * require the addresses to match. A caller who IS signed in as that account
   * comes through here, and that is the path the Settings button takes. Gating
   * one and not the other would leave the release's own rule — adding a
   * credential requires proving identity — true only of the door users walk
   * through.
   *
   * `requireAAL2` cannot be middleware on the callback: that route also serves
   * login and signup, neither of which has an account to have verified. And a
   * callback cannot be interrupted to ask for a verification — the user is
   * mid-redirect at the provider. So the proof has to be obtained BEFORE the
   * redirect and carried across it, which is what this does.
   *
   * `jti` rides along because `consumeChallenge` re-checks the session binding
   * and the callback is unauthenticated — there is no `req.sessionJti` there.
   * Taking it from the state is sound precisely because the state is signed by
   * us and single-use (`oauth_states`), and because the callback additionally
   * requires the nonce cookie set on this browser.
   *
   * Silently ignored for an unauthenticated caller. There is no account to
   * link to, so a challenge id is meaningless rather than hostile, and
   * `openChallenge` could not have issued one without a session anyway.
   */
  if (user && typeof req.body?.challengeId === 'string' && req.body.challengeId) {
    statePayload.challengeId = req.body.challengeId;
    statePayload.jti = currentSessionJti(req);
  }

  if (req.body && req.body.signupData) {
    const sd = req.body.signupData;
    if (typeof sd !== 'object' || Array.isArray(sd)) {
      return res.status(400).json({ error: 'Invalid signup details.' });
    }

    /**
     * Validate NOW, before sending the user to the provider.
     *
     * Two reasons. Security: this payload used to be written into the users
     * table on return with no checks whatsoever, so `role: "admin"` in it
     * self-registered an administrator. Product: a validation failure
     * discovered on the way back means the user has already authenticated with
     * Google and lands on an error page having done work for nothing.
     *
     * `email` is not taken from here — the provider is the authority on that,
     * and accepting a client-supplied address would let someone attach an
     * arbitrary email to a real Google identity.
     */
    const check = validateAccountFields({ ...sd, email: 'placeholder@example.com' });
    if (!check.ok) {
      return res.status(400).json({ error: check.error, field: check.field });
    }

    const { email: _discardEmail, ...safeFields } = check.value;
    // No password. It was never needed here — the account this creates signs in
    // through the provider — and carrying it made a URL and a database row into
    // places a plaintext credential could be read.
    purgeExpiredSignupSessions();
    const sessionId = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO oauth_signup_sessions (id, signup_data, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      sessionId,
      JSON.stringify(safeFields),
      new Date().toISOString(),
      new Date(Date.now() + SIGNUP_SESSION_TTL_MS).toISOString()
    );
    statePayload.signupSessionId = sessionId;
  }

  const state = jwt.sign(statePayload, JWT_SECRET, { expiresIn: '15m' });

  // Store state on the server to prevent replay attacks
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes
  db.prepare('INSERT INTO oauth_states (nonce, created_at, expires_at) VALUES (?, ?, ?)').run(nonce, now.toISOString(), expiresAt.toISOString());

  let url;
  try {
    url = provider.getAuthUrl(state);
  } catch (err) {
    console.error(`Failed to build ${providerName} auth URL:`, err);
    return res.status(503).json({ error: `Signing in with ${provider.label} is unavailable right now.` });
  }

  /**
   * CSRF binding for the state parameter.
   *
   * The nonce goes in a cookie whose NAME carries the first 8 hex characters
   * of that same nonce, rather than in one fixed-name cookie. A single shared
   * name means opening the sign-in page in a second tab overwrites the first
   * tab's nonce, and the first tab then fails its own callback — a spurious
   * "Security validation failed" for a user who did nothing wrong.
   */
  res.cookie(`${OAUTH_STATE_COOKIE}_${nonce.substring(0, 8)}`, nonce, {
    ...cookieOptions(),
    maxAge: SIGNUP_SESSION_TTL_MS
  });

  res.json({ url });
});

router.post('/api/oauth/:provider/callback', async (req, res) => {
  const resolved = resolveProvider(req.params.provider);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const { key: providerName, provider } = resolved;

  const { code, state } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code. Please try signing in again.' });
  }
  if (!state) {
    return res.status(400).json({ error: 'Missing state parameter. Please try signing in again.' });
  }

  let decodedState;
  try {
    decodedState = jwt.verify(state, JWT_SECRET);
  } catch {
    return res.status(400).json({ error: 'Your sign-in session expired or is invalid. Please try again.' });
  }

  if (decodedState.provider !== providerName) {
    return res.status(400).json({ error: 'Sign-in provider mismatch. Please try again.' });
  }

  const cookieId = String(decodedState.nonce || '').substring(0, 8);
  const expectedNonce = req.cookies[`${OAUTH_STATE_COOKIE}_${cookieId}`];
  if (!expectedNonce || expectedNonce !== decodedState.nonce) {
    return res.status(400).json({ error: 'Security validation failed. Please ensure cookies are enabled and try again.' });
  }

  // Server-side state invalidation (prevents replay attacks)
  const stateRow = db.prepare('SELECT 1 FROM oauth_states WHERE nonce = ?').get(decodedState.nonce);
  if (!stateRow) {
    return res.status(400).json({ error: 'Sign-in session expired or already used. Please try again.' });
  }
  db.prepare('DELETE FROM oauth_states WHERE nonce = ?').run(decodedState.nonce);

  res.clearCookie(`${OAUTH_STATE_COOKIE}_${cookieId}`);

  try {
    const claims = await provider.verifyCallback(code);
    const providerUserId = claims.sub;
    const providerEmail = String(claims.email || '').trim().toLowerCase();
    const providerNameClaim = claims.name;

    if (!providerUserId || !providerEmail) {
      return res.status(502).json({ error: `${provider.label} did not return an email address for that account.` });
    }

    // ── Returning user: this exact provider identity is already known ──
    const oauthRow = db.prepare(
      'SELECT * FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?'
    ).get(providerName, providerUserId);

    if (oauthRow) {
      const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(oauthRow.user_id);
      if (!userRow || userRow.account_status === 'deleted') {
        // The link is a tombstone pointing at a deleted account. Clear it so a
        // fresh sign-up with the same Google account is a clean signup rather
        // than a permanent dead end.
        db.prepare('DELETE FROM oauth_accounts WHERE id = ?').run(oauthRow.id);
        return res.status(401).json({ error: 'That account was deleted. You can create a new one.' });
      }
      if (userRow.account_status === 'suspended') {
        return res.status(403).json({ error: 'Account is suspended' });
      }

      db.prepare('UPDATE oauth_accounts SET last_used_at = ?, provider_email = ? WHERE id = ?')
        .run(new Date().toISOString(), providerEmail, oauthRow.id);

      const user = formatUserResponse(userRow);
      issueSession(res, user, userRow.token_version);
      return res.json({ action: 'login', user, emailVerified: userRow.email_verified === 1 });
    }

    // ── An account already holds this address ──
    const existingUser = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(providerEmail);

    if (existingUser) {
      if (existingUser.account_status === 'deleted') {
        // Anonymised tombstones use deleted_<id>@system.local, so a real
        // address here means an active person; treat anything else as absent.
        return res.status(401).json({ error: 'That account was deleted. You can create a new one.' });
      }
      if (existingUser.account_status === 'suspended') {
        return res.status(403).json({ error: 'Account is suspended' });
      }

      /**
       * Signed in as that very account — but a live session is not enough.
       *
       * This branch writes an `oauth_accounts` row, and that row is a new way
       * to sign in: the returning-user branch at the top of this handler logs
       * in anyone presenting the identity from now on, long after the session
       * that added it has gone. Until v1.2b it was reached on the strength of
       * `decodedState.userId` alone — which is to say, on the strength of
       * holding the cookie. `POST /api/oauth/link` makes the identical state
       * change and is gated on `requireAAL2('oauth.link')`; this is the same
       * door for the case where the provider's address matches the account's,
       * and it is the one the Settings button actually walks through.
       *
       * The grant is spent, not merely checked, in the same transaction as the
       * upsert. Checking without spending would leave it reusable, and a
       * five-minute reusable grant for "attach a provider" is a grant to attach
       * several.
       *
       * `session_jti` is verified by `consumeChallenge` against the value the
       * state carries, which `/url` took from the live cookie when the flow
       * started. So the grant must have been opened by the same sign-in that
       * began this redirect, and the nonce cookie above proves it is the same
       * browser coming back.
       */
      if (decodedState.userId && decodedState.userId === existingUser.id) {
        if (!decodedState.challengeId) {
          return res.status(403).json({
            error: 'Identity verification required',
            code: 'reauth_required',
            action: 'oauth.link',
            provider: providerName
          });
        }

        const now = new Date().toISOString();
        try {
          inTransaction(() => {
            const spent = consumeChallenge({
              db,
              challengeId: decodedState.challengeId,
              userId: existingUser.id,
              action: 'oauth.link',
              // Exactly the keys the registry binds for this action, and the
              // provider the row is actually about to name — never the one the
              // client claimed when it opened the challenge.
              params: { provider: providerName },
              sessionJti: decodedState.jti ?? null
            });
            if (!spent.ok) throw new ChallengeNotSpent(spent);

            db.prepare(`
              INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at, last_used_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, provider) DO UPDATE SET
                provider_user_id = excluded.provider_user_id,
                provider_email = excluded.provider_email,
                updated_at = excluded.updated_at,
                last_used_at = excluded.last_used_at
            `).run(`oauth-${crypto.randomUUID()}`, existingUser.id, providerName, providerUserId, providerEmail, now, now, now);
          });
        } catch (err) {
          if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
          throw err;
        }

        return res.json({ action: 'auto_linked', provider: providerName });
      }

      /**
       * Someone else's session, or no session. Proving control of the address
       * at the provider is NOT proof of control of the WeVolunteer account
       * that happens to use it — an address can be reassigned, and a Microsoft
       * directory attribute can simply be set. So this requires the account
       * password before the identities are joined.
       *
       * An OAuth-only account has no password to offer, so that combination
       * gets the recovery route instead of an unanswerable prompt.
       */
      if (existingUser.password_hash === '!OAUTH_ONLY!') {
        return res.status(409).json({
          error: 'An account already uses that email address, and it signs in with a different provider. '
            + 'Sign in the way you did before, then connect this provider from Settings.',
          code: 'link_requires_other_provider'
        });
      }

      const linkToken = jwt.sign(
        { action: 'link', userId: existingUser.id, provider: providerName, providerUserId, providerEmail },
        JWT_SECRET,
        { expiresIn: '15m' }
      );
      return res.json({ action: 'link_required', email: existingUser.email, provider: providerName, linkToken });
    }

    // ── Brand new person ──
    purgeExpiredSignupSessions();

    let pending = null;
    if (decodedState.signupSessionId) {
      const sessionRow = db.prepare('SELECT * FROM oauth_signup_sessions WHERE id = ?').get(decodedState.signupSessionId);
      if (sessionRow) {
        if (new Date(sessionRow.expires_at) > new Date()) {
          try {
            pending = JSON.parse(sessionRow.signup_data);
          } catch (e) {
            console.error('Failed to parse stored OAuth signup data:', e);
          }
        }
        db.prepare('DELETE FROM oauth_signup_sessions WHERE id = ?').run(decodedState.signupSessionId);
      }
    }

    if (pending) {
      // Re-validate on the way back. The stored blob was checked when it was
      // written, but it has been out of our hands since, and the row is cheap
      // to re-check against rules that may have changed under it.
      const check = validateAccountFields({ ...pending, email: providerEmail });
      if (!check.ok) {
        return res.status(400).json({ error: check.error, field: check.field });
      }
      const fields = check.value;

      if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(fields.username)) {
        return res.status(409).json({ error: 'That username was taken while you were signing in. Please choose another.', field: 'username' });
      }

      const newUserId = `user-${crypto.randomUUID()}`;
      const emailVerified = claims.emailVerified === true ? 1 : 0;
      const now = new Date().toISOString();

      inTransaction(() => {
        db.prepare(`
          INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, email_verified, avatar, bio, school, skills, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newUserId, fields.name, providerEmail, fields.username, '!OAUTH_ONLY!',
          fields.grade, fields.role,
          // Organizers are approved by staff before they can post events; that
          // is a separate gate from confirming an email address.
          fields.role === 'organizer' ? 0 : 1,
          emailVerified,
          fields.avatar, fields.bio, fields.school, JSON.stringify(fields.skills), now
        );

        db.prepare(`
          INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`oauth-${crypto.randomUUID()}`, newUserId, providerName, providerUserId, providerEmail, now, now, now);
      });

      const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(newUserId);
      const user = formatUserResponse(userRow);
      issueSession(res, user, userRow.token_version);

      // A provider that does not attest the address (Microsoft) still has to
      // confirm it by mail before the account can act.
      if (!emailVerified) {
        const token = issueVerificationToken(newUserId);
        sendVerificationMail(providerEmail, token);
      }

      return res.json({ action: 'login', user, emailVerified: emailVerified === 1 });
    }

    // No pending signup: send them to the form to choose a username and role.
    const signupToken = jwt.sign(
      {
        action: 'signup',
        provider: providerName,
        providerUserId,
        providerEmail,
        providerEmailVerified: claims.emailVerified === true,
        providerName: providerNameClaim
      },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    return res.json({
      action: 'signup_required',
      email: providerEmail,
      name: providerNameClaim,
      provider: providerName,
      signupToken
    });
  } catch (error) {
    console.error(`OAuth Callback Error (${providerName}):`, error);
    res.status(502).json({ error: `We could not complete sign-in with ${provider.label}. Please try again.` });
  }
});

/**
 * Joins a provider identity to the caller's own account, behind a fresh proof of
 * identity.
 *
 * ── What replaced what ──
 *
 * This route took an account password alongside an unauthenticated 15-minute
 * link token, which made it a pure password oracle: 600 guesses per window
 * against any account whose address somebody could produce at a provider. It is
 * now an authenticated route gated on `requireAAL2('oauth.link')` with the
 * provider bound in, so the proof is a challenge satisfied by a password or by
 * re-consent at a provider the account has ALREADY linked.
 *
 * Two consequences, both intended:
 *
 *  1. **A provider-only account can now link a second provider.** It used to be
 *     refused outright with a 409 — "that account has no password" — because the
 *     only proof this endpoint accepted was one it could not produce. Losing
 *     access to a single Google account was therefore losing the account.
 *     `disconnect`'s last-credential guard is untouched and still refuses to
 *     remove the final way in.
 *  2. **The caller must be signed in as the account being linked.** The token
 *     names a `userId`, and that used to be the ONLY thing tying the request to
 *     an account — the password was the proof it named the right one. Now the
 *     session is, so the token's `userId` must match it (see below). A person who
 *     reaches `link_required` while signed out signs in first, then verifies.
 */
router.post('/api/oauth/link', authenticateToken, requireAAL2('oauth.link'), (req, res) => {
  const { linkToken } = req.body ?? {};
  if (!linkToken) {
    return res.status(400).json({ error: 'Missing token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(linkToken, JWT_SECRET);
  } catch {
    return res.status(400).json({ error: 'That connection request expired. Please start again.' });
  }
  if (decoded.action !== 'link') {
    return res.status(400).json({ error: 'Invalid token' });
  }

  /**
   * The token must name the caller, and this check is load-bearing.
   *
   * `link_required` is issued for whichever account already holds the address
   * the provider returned — which is not necessarily the caller's. Without this
   * comparison, someone who controls a provider account bearing a victim's email
   * address could sign in as THEMSELVES, verify with their own credential, and
   * spend that grant to attach their provider identity to the victim's account —
   * after which "Continue with Google" signs them in as the victim. The password
   * this route used to demand was what tied the token's `userId` to the person
   * presenting it; the session is what ties it now, so the two have to agree.
   */
  if (decoded.userId !== req.user.id) {
    return res.status(403).json({
      error: 'That connection request is for a different account. Sign in to that account first.',
      code: 'link_token_other_account'
    });
  }

  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow || userRow.account_status !== 'active') {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date().toISOString();
    inTransaction(() => {
      /**
       * `provider` comes from the signed token, not the request body.
       *
       * It is the provider actually about to be written, and the grant is bound
       * to it — so a verification obtained to connect Google cannot be spent
       * connecting Microsoft. Taking it from the body would bind the check to a
       * value the caller could choose independently of the write, which is a
       * binding in name only.
       */
      spendChallenge(db, req, 'oauth.link', { provider: decoded.provider });

      db.prepare(`
        INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, provider) DO UPDATE SET
          provider_user_id = excluded.provider_user_id,
          provider_email = excluded.provider_email,
          updated_at = excluded.updated_at,
          last_used_at = excluded.last_used_at
      `).run(`oauth-${crypto.randomUUID()}`, userRow.id, decoded.provider, decoded.providerUserId, decoded.providerEmail, now, now, now);
    });

    /**
     * No new session is issued.
     *
     * It used to be, because the caller had just proved a password while signed
     * OUT and needed one. The caller is now already signed in — `authenticateToken`
     * is on this route — so there is nothing to issue: replacing a working
     * session with an equivalent one is churn, and it would invalidate any other
     * challenge the user currently holds, since every grant is bound to the
     * `jti` of the session that opened it.
     *
     * An earlier version of this note claimed the reason was that `issueSession`
     * "mints a token with no jti". That described the local copy this file used
     * to keep, which Task 6 deleted; the shared `issueSession` imported from
     * authRoutes.js has always set one. The conclusion was right and the stated
     * reason was not, which is worse than either alone — the next reader checks
     * the comment.
     */
    const user = formatUserResponse(userRow);
    res.json({ success: true, user, emailVerified: userRow.email_verified === 1 });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
    console.error('Link Error:', err);
    res.status(500).json({ error: 'Could not connect that account.' });
  }
});

/**
 * Removes a provider from the caller's account, behind a fresh proof of identity.
 *
 * ── Why this gained a gate (v1.2b audit, F-2) ──
 *
 * `POST /api/oauth/link` above has required step-up since Task 6, and the guide
 * records the rule as "adding a sign-in credential requires step-up". This
 * endpoint mutates the same table in the opposite direction and asked only for
 * a session, so the rule held in one direction only.
 *
 * The v1.2b plan did look at this route and marked it "already correct" — but
 * on the strength of the lockout guard below, which answers a different
 * question. "Never leave an account with no way back in" stops a user stranding
 * themselves; it says nothing about somebody holding a borrowed session
 * stripping a provider off an account that still has a password. That costs the
 * account holder the sign-in route they actually use, and removes one of the
 * two ways they could have satisfied any future step-up — including the one
 * that would let them undo it.
 *
 * `oauth.unlink` binds `provider`, mirroring `oauth.link`, so a verification
 * collected to remove Google cannot remove Microsoft instead.
 */
router.post('/api/oauth/disconnect', authenticateToken, requireAAL2('oauth.unlink'), (req, res) => {
  const { provider } = req.body;
  if (!provider || !providers[String(provider).toLowerCase()]) {
    return res.status(400).json({ error: 'Unknown provider.' });
  }
  const providerName = String(provider).toLowerCase();

  try {
    const userRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    const existing = db.prepare('SELECT 1 FROM oauth_accounts WHERE user_id = ? AND provider = ?')
      .get(req.user.id, providerName);
    if (!existing) {
      return res.status(404).json({ error: 'That provider is not connected to your account.' });
    }

    /**
     * Never leave an account with no way back in.
     *
     * Still checked BEFORE the grant is spent. A refusal here is the request
     * not happening, and it must not cost the user the verification they just
     * performed — least of all this one, where the person is provider-only and
     * had to complete a whole re-consent round trip at their provider to get
     * it. Same ordering rule as the "already in progress" check on the export
     * endpoint.
     */
    if (userRow.password_hash === '!OAUTH_ONLY!') {
      const providerCount = db.prepare('SELECT COUNT(*) as count FROM oauth_accounts WHERE user_id = ?')
        .get(req.user.id).count;
      if (providerCount <= 1) {
        return res.status(400).json({
          error: 'This is the only way you can sign in. Set a password first, then you can remove it.',
          code: 'last_sign_in_method'
        });
      }
    }

    inTransaction(() => {
      // Spent with the delete it authorises, bound to the provider actually
      // being removed: no removal without a spent grant, no spent grant
      // without a removal.
      spendChallenge(db, req, 'oauth.unlink', { provider: providerName });

      db.prepare('DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?').run(req.user.id, providerName);
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
    console.error('Disconnect Error:', err);
    res.status(500).json({ error: 'Failed to disconnect provider' });
  }
});

router.get('/api/oauth/accounts', authenticateToken, (req, res) => {
  try {
    const accounts = db.prepare(
      'SELECT provider, provider_email, created_at, last_used_at FROM oauth_accounts WHERE user_id = ?'
    ).all(req.user.id);
    res.json(accounts);
  } catch (err) {
    console.error('Fetch Accounts Error:', err);
    res.status(500).json({ error: 'Failed to fetch connected accounts' });
  }
});

export default router;
