import crypto from 'crypto';

/**
 * PKCE (RFC 7636) — binding an authorization code to the flow that started it.
 *
 * ── Why this application needs it despite having a client secret ──
 *
 * PKCE is usually described as the fix for PUBLIC clients, which this is not:
 * the code exchange happens server-side with `GOOGLE_CLIENT_SECRET` /
 * `MICROSOFT_CLIENT_SECRET`. The reason it matters anyway is the redirect target.
 *
 * `OAUTH_REDIRECT_URI` is `…/oauth/callback` — a route in the SPA. So the
 * provider hands the authorization code to the BROWSER, which then posts it to
 * `POST /api/oauth/:provider/callback`. The code therefore exists, briefly, in a
 * place the server does not control: in a URL, in history, in anything reading
 * the address bar, and in whatever a referrer or an extension can see.
 *
 * Without PKCE, that code plus the (server-held) secret is all the token endpoint
 * needs — so an intercepted code is redeemable by anyone who can reach our
 * callback with it. The signed, single-use, cookie-bound `state` already makes
 * that hard: an attacker would need the matching state AND the per-nonce cookie
 * from the victim's browser. PKCE closes the remaining case by making the code
 * itself useless without a verifier that never left this process.
 *
 * ── S256, never `plain` ──
 *
 * `plain` sends the verifier as the challenge, which means the authorize request
 * carries the secret through the same browser the code comes back through, and
 * protects against nothing. Both providers support S256; there is no reason to
 * offer a downgrade, so this module cannot express one.
 */

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. 32 bytes → 43. */
export function createVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * The S256 challenge for a verifier.
 *
 * base64url of the raw SHA-256 digest — not the hex digest, which is the usual
 * mistake and produces a challenge the provider rejects with an opaque
 * `invalid_grant` at exchange time rather than at authorize time.
 */
export function challengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** The authorize-request parameters for a verifier. */
export function authorizeParams(verifier) {
  return {
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
  };
}
