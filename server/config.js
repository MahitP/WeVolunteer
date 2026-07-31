/**
 * All environment-derived configuration, in one place with no side effects.
 *
 * Routers import from here rather than from server.js, so that importing a
 * router does not boot a listener, open the production database, or start the
 * notification sweep. That is what makes route tests possible.
 */

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEMO_MODE = process.env.DEMO_MODE === 'true';
export const PORT = Number(process.env.API_PORT) || 5050;

/**
 * Session signing secret.
 *
 * Every session cookie in the system is signed with this. If it is guessable,
 * anyone can mint a token for any account — including an administrator — so a
 * weak value here defeats every other control in this file.
 *
 * Three things are enforced, and the split between them matters:
 *
 *   • Missing, in any environment → fatal. Unchanged.
 *   • A known placeholder or an obviously weak value, in PRODUCTION → fatal.
 *     The previous check only caught a missing secret, so shipping with the
 *     literal `your-super-secret-jwt-key` from .env.example passed silently.
 *     That is the realistic failure: not an empty variable, but a template value
 *     nobody replaced.
 *   • The same in development → a loud warning, not a crash. Refusing to boot
 *     locally over a weak secret would make people paste a real production
 *     secret into their dev .env to get past it, which is worse.
 *
 * The dev fallback lives here rather than in package.json's `dev` script. It was
 * there as `JWT_SECRET=${JWT_SECRET:-…}`, which set a shell variable — and a
 * shell variable takes precedence over `--env-file`, so it silently overrode a
 * real secret in .env. Development and production would then sign with different
 * keys, and setting a proper secret would appear to do nothing locally.
 */
const DEV_FALLBACK_SECRET = 'dev-only-insecure-secret-do-not-use-in-production';

/** Values that indicate nobody chose a secret. Compared case-insensitively. */
const PLACEHOLDER_SECRETS = [
  'your-super-secret-jwt-key',
  'your-secret-key',
  'change-me',
  'changeme',
  'secret',
  'test',
  'test-secret',
  DEV_FALLBACK_SECRET
];

function describeWeakSecret(value) {
  if (!value) return null;
  const normalised = value.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.includes(normalised)) return 'it is a placeholder from the template';
  if (value.trim().length < 32) return `it is only ${value.trim().length} characters (32 minimum)`;
  // A single repeated character passes a length check but carries no entropy.
  if (new Set(value.trim()).size < 8) return 'it has too few distinct characters to carry real entropy';
  return null;
}

let resolvedSecret = process.env.JWT_SECRET;

if (!resolvedSecret) {
  if (IS_PRODUCTION) {
    throw new Error(
      'FATAL: JWT_SECRET must be set. Generate one with:\n'
      + '  openssl rand -base64 48\n'
      + 'and set it in the deployment environment (never in a committed file).'
    );
  }
  resolvedSecret = DEV_FALLBACK_SECRET;
  console.warn(
    '[config] JWT_SECRET is not set — using an insecure development fallback.\n'
    + '         Sessions signed with it are trivially forgeable. Set a real value in .env.'
  );
}

const weakness = describeWeakSecret(resolvedSecret);
if (weakness) {
  const message =
    `JWT_SECRET is not usable as a signing secret: ${weakness}.\n`
    + 'Every session cookie is signed with it, so a guessable value lets anyone\n'
    + 'mint a token for any account, including an administrator.\n'
    + 'Generate one with:  openssl rand -base64 48';
  if (IS_PRODUCTION) throw new Error(`FATAL: ${message}`);
  console.warn(`[config] WARNING: ${message}`);
}

export const JWT_SECRET = resolvedSecret;

export const VALID_GRADES = ['9', '10', '11', '12', 'Adult', 'N/A'];
export const VALID_CATEGORIES = ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];

export const APP_NAME = process.env.APP_NAME || 'WeVolunteer';
export const MAX_AUTO_SELECT_DRAWS = Number(process.env.MAX_AUTO_SELECT_DRAWS) || 5;

/**
 * OAuth configuration.
 *
 * SECURITY — the mock transport.
 *
 * Both providers carry a test transport that skips the real code exchange and
 * takes the identity straight from the `code` parameter. Previously it switched
 * itself on whenever the client id was absent, via
 * `process.env.GOOGLE_CLIENT_ID || 'mock-client-id'`. That made a *missing*
 * environment variable — the single most likely deployment mistake there is —
 * silently turn the callback into an unauthenticated login-as-anyone endpoint:
 *
 *     POST /api/oauth/google/callback
 *     { "code": "{\"email\":\"admin@district.org\",\"sub\":\"1\"}", "state": "..." }
 *
 * The mock is now opt-in and impossible to reach in production. It requires
 * OAUTH_ALLOW_MOCK=true, and NODE_ENV must not be production. A production
 * process that sets the flag refuses to boot rather than starting insecure.
 */
export const OAUTH_ALLOW_MOCK = process.env.OAUTH_ALLOW_MOCK === 'true';
if (OAUTH_ALLOW_MOCK && IS_PRODUCTION) {
  throw new Error(
    'FATAL: OAUTH_ALLOW_MOCK=true is set in a production process. The mock OAuth '
    + 'transport accepts an unsigned identity from the request body and would let '
    + 'anyone sign in as any user. Unset it, and configure real provider credentials.'
  );
}

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
export const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';
export const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:5173/oauth/callback';

/**
 * Where the provider sends the user back — validated in production.
 *
 * The default above is right for development and catastrophic in production,
 * and it applies silently. Verified during the pre-pilot review: with real
 * Google credentials set and OAUTH_REDIRECT_URI forgotten, the server booted
 * without complaint, reported `{"id":"google","enabled":true}` so the "Continue
 * with Google" button rendered for everyone, and minted authorize URLs carrying
 * `redirect_uri=http://localhost:5173/oauth/callback`.
 *
 * Every student pressing that button then gets one of two outcomes. If
 * localhost is not a registered URI on the OAuth client, Google refuses with
 * `redirect_uri_mismatch` — a dead end on a sign-in path the app advertises. If
 * it IS still registered — the common case, because it is what development uses
 * and the same client tends to get reused — Google hands a live authorization
 * code to `http://localhost:5173` over plain HTTP on the user's own machine.
 *
 * Forgetting it is a likely mistake, not an exotic one: it is not listed in
 * deploy/wevolunteer.env.example, so an operator following the runbook has no
 * reason to know it exists.
 *
 * Everything else in this file fails CLOSED on this class of mistake — a
 * placeholder JWT_SECRET and OAUTH_ALLOW_MOCK in production both refuse to boot.
 * This did not, so it now does.
 *
 * Only enforced when a provider is actually configured: an email-only district
 * is a normal deployment and must not be made to set a variable for a feature it
 * does not use.
 */
const ANY_OAUTH_PROVIDER_CONFIGURED =
  Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  || Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET);

if (IS_PRODUCTION && ANY_OAUTH_PROVIDER_CONFIGURED) {
  let host = null;
  try {
    host = new URL(OAUTH_REDIRECT_URI).hostname;
  } catch {
    throw new Error(
      `FATAL: OAUTH_REDIRECT_URI is not a valid URL: ${OAUTH_REDIRECT_URI}\n`
      + 'It must be the absolute callback URL of this deployment, e.g.\n'
      + '  OAUTH_REDIRECT_URI=https://volunteers.example.org/oauth/callback'
    );
  }

  // Bracketed IPv6 comes back from URL as "[::1]" on some runtimes and "::1" on
  // others, so both spellings are checked.
  const isLoopback = host === 'localhost' || host === '127.0.0.1'
    || host === '::1' || host === '[::1]';

  if (isLoopback) {
    throw new Error(
      'FATAL: an OAuth provider is configured but OAUTH_REDIRECT_URI still points at '
      + `localhost (${OAUTH_REDIRECT_URI}).\n`
      + 'This is the development default. In production it sends every user who presses\n'
      + '"Continue with Google" to their own machine — and if localhost is still a\n'
      + 'registered redirect URI on the OAuth client, it delivers a live authorization\n'
      + 'code there over plain HTTP.\n'
      + 'Set it to this deployment\'s callback URL, e.g.\n'
      + '  OAUTH_REDIRECT_URI=https://volunteers.example.org/oauth/callback\n'
      + 'and register exactly that value with the provider. To run email-only instead,\n'
      + 'unset GOOGLE_CLIENT_ID/SECRET and MICROSOFT_CLIENT_ID/SECRET.'
    );
  }

  // Not fatal: the provider is the authority here and will reject it, so a hard
  // stop would be us guessing. A loud warning is proportionate — unlike the
  // loopback case, this one fails visibly at the provider rather than silently.
  if (!OAUTH_REDIRECT_URI.startsWith('https://')) {
    console.warn(
      `[config] WARNING: OAUTH_REDIRECT_URI is not https (${OAUTH_REDIRECT_URI}).\n`
      + '         Google and Microsoft both refuse non-HTTPS redirect URIs outside\n'
      + '         localhost, so provider sign-in will fail at the provider.'
    );
  }
}

/**
 * Whether a provider can actually be used, so the UI can hide a button that
 * would otherwise fail after the user has already left the site. Unconfigured
 * is a normal state (a district may run email-only), not an error.
 */
export const OAUTH_PROVIDERS_ENABLED = {
  google: OAUTH_ALLOW_MOCK || Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
  microsoft: OAUTH_ALLOW_MOCK || Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET),
  // Apple has no implementation behind it — see oauth/providers/apple.js.
  apple: false
};

// Removed as dead exports: SCHOOL_NAME, MAX_AUTO_SELECT_APPLICANTS and
// DEFAULT_EMAIL_FROM were declared here but imported nowhere. The first two
// were actively misleading — MAX_AUTO_SELECT_APPLICANTS reads like a cap on
// the Auto Select pool and enforced nothing. The client keeps its own
// SCHOOL_NAME in src/config.js, which IS used; email.js keeps its own
// EMAIL_FROM. Nothing here changes behaviour.

export const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

/**
 * Whether a new account must confirm its email address before using the app.
 *
 * ON by default, inverted from the previous behaviour.
 *
 * It used to default off, and the anti-lockout reasoning for that ("turning it
 * on without a working SMTP transport locks every user out") no longer holds:
 * email.js refuses to boot a production process that has no SMTP transport,
 * and in development the mock transport prints the link to the console, so
 * there is no configuration in which the flag is on and confirmation is
 * impossible.
 *
 * Meanwhile the cost of the old default was severe and invisible. Nothing in
 * the login path ever consulted `email_verified`, so an unconfirmed account
 * could sign in and call every endpoint; only the SPA refused to render, and
 * the SPA is not a security boundary. On a platform holding minors' records
 * that means anyone able to type an address they do not own — a student using
 * a teacher's address, say — got a working account.
 *
 * Set REQUIRE_EMAIL_VERIFICATION=false to opt out deliberately.
 */
export const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';

// Paths an authenticated-but-unverified user may still reach when
// REQUIRE_EMAIL_VERIFICATION is on: enough to see their own account and finish
// verifying. Deliberately minimal — no action routes, no other users' data.
export const EMAIL_GATE_ALLOWLIST = [
  '/api/auth/me',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',
  // Signing out and deleting an unconfirmed account must always be possible —
  // otherwise a typo in an address creates an account its owner can neither
  // use nor get rid of.
  '/api/auth/logout',
  '/api/auth/account',
  '/api/notifications',
  /**
   * Correcting a mistyped address is the whole point of the gate being
   * escapable, so these are load-bearing rather than a convenience.
   *
   * The account most likely to be sitting behind this gate is one whose address
   * has a typo in it — which is precisely the account that can never confirm,
   * and therefore never reach anything not on this list. Leaving the
   * email-change routes off it would mean the only way out stayed "abandon the
   * account", and an abandoned account holds its email and username forever.
   *
   * `confirm-email-change` is unauthenticated and so never reaches this check;
   * it is listed for completeness of the flow it belongs to.
   */
  '/api/auth/change-email',
  '/api/auth/cancel-email-change',
  '/api/auth/pending-email-change'
];

/**
 * Session cookie.
 *
 * Replaces the v1.0 scheme of a JWT in localStorage sent as an Authorization
 * header. The token itself is unchanged — same claims, same 7-day expiry, same
 * signing secret. Only the transport moved, into a place script cannot read.
 */
export const COOKIE_NAME = 'wev_session';

/** Must match the JWT's `expiresIn: '7d'` — a cookie that outlives its token
 *  produces a confusing 403 on a session the browser still believes in. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Options for the session cookie.
 *
 * `sameSite: 'lax'` and NO CSRF token, deliberately.
 *
 * Cookies reintroduce CSRF, which an Authorization header is structurally
 * immune to — so this is only an upgrade if that exposure is actually closed.
 * It is, by the topology: production serves the SPA and the API from one
 * Express process (app.js), and development proxies /api through Vite, so the
 * browser sees a single origin in both. `Lax` blocks cross-site POST, PATCH and
 * DELETE, which is the entire CSRF surface available here.
 *
 * A double-submit token would add nothing against that threat model — it
 * defends against a same-site attacker on a sibling subdomain, which this
 * deployment does not have. Adding one now would be unjustified complexity.
 *
 * REVISIT THIS if the app is ever served from a subdomain alongside another
 * application, or if the API moves to a different origin from the SPA. Either
 * change invalidates the reasoning above and makes a CSRF token necessary.
 *
 * `secure` is gated on production because development runs over plain HTTP
 * through the Vite proxy; a Secure cookie is silently dropped there, which
 * presents as "login succeeds but every subsequent request is 401" — a failure
 * with no visible cause.
 */
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: SEVEN_DAYS_MS,
    path: '/'
  };
}

/**
 * Options for DELETING the session cookie.
 *
 * Deliberately not `cookieOptions()`. Express's `res.clearCookie` merges the
 * options it is given over its own `expires: new Date(1)`, and `res.cookie`
 * then recomputes `expires` from `maxAge` whenever `maxAge` is present — so
 * passing the full options through sets the cookie to expire in seven days
 * instead of clearing it. The attributes that matter for deletion are the ones
 * the browser matches on (name, path, domain); the rest must not carry a
 * lifetime.
 */
export function clearCookieOptions() {
  const { maxAge: _drop, ...rest } = cookieOptions();
  return rest;
}
