import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { JWT_SECRET, COOKIE_NAME, cookieOptions, OAUTH_PROVIDERS_ENABLED } from '../config.js';
import { authenticateToken, formatUserResponse, inTransaction } from '../utils.js';
import { validateAccountFields } from '../accountValidation.js';
import { issueVerificationToken, sendVerificationMail } from '../services/verification.js';

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
 */
function resolveProvider(name) {
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

/** Expired pending signups are dead weight and hold personal details. Sweep on use. */
function purgeExpiredSignupSessions() {
  try {
    db.prepare('DELETE FROM oauth_signup_sessions WHERE expires_at < ?').run(new Date().toISOString());
  } catch (err) {
    console.error('Failed to purge expired OAuth signup sessions:', err);
  }
}

function issueSession(res, user, tokenVersion) {
  const token = jwt.sign(
    { id: user.id, role: user.role, email: user.email, name: user.name, tokenVersion: tokenVersion ?? 0 },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

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

      // Already signed in as that very account: linking needs no extra proof.
      if (decodedState.userId && decodedState.userId === existingUser.id) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, provider) DO UPDATE SET
            provider_user_id = excluded.provider_user_id,
            provider_email = excluded.provider_email,
            updated_at = excluded.updated_at,
            last_used_at = excluded.last_used_at
        `).run(`oauth-${crypto.randomUUID()}`, existingUser.id, providerName, providerUserId, providerEmail, now, now, now);

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

/** Joins a provider identity to an existing password account, proven by that password. */
router.post('/api/oauth/link', (req, res) => {
  const { linkToken, password } = req.body;
  if (!linkToken || !password) {
    return res.status(400).json({ error: 'Missing token or password' });
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

  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
    if (!userRow || userRow.account_status !== 'active') {
      return res.status(404).json({ error: 'User not found' });
    }
    // An OAuth-only row stores the sentinel, which is not a bcrypt hash;
    // compareSync would just return false and read as "wrong password".
    if (userRow.password_hash === '!OAUTH_ONLY!') {
      return res.status(409).json({ error: 'That account has no password. Sign in with your existing provider instead.' });
    }
    if (!bcrypt.compareSync(password, userRow.password_hash)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        provider_user_id = excluded.provider_user_id,
        provider_email = excluded.provider_email,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at
    `).run(`oauth-${crypto.randomUUID()}`, userRow.id, decoded.provider, decoded.providerUserId, decoded.providerEmail, now, now, now);

    const user = formatUserResponse(userRow);
    issueSession(res, user, userRow.token_version);
    res.json({ success: true, user, emailVerified: userRow.email_verified === 1 });
  } catch (err) {
    console.error('Link Error:', err);
    res.status(500).json({ error: 'Could not connect that account.' });
  }
});

router.post('/api/oauth/disconnect', authenticateToken, (req, res) => {
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

    // Never leave an account with no way back in.
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

    db.prepare('DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?').run(req.user.id, providerName);
    res.json({ success: true });
  } catch (err) {
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
