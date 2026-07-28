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

export const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET must be set.');

export const VALID_GRADES = ['9', '10', '11', '12', 'Adult', 'N/A'];
export const VALID_CATEGORIES = ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];

export const APP_NAME = process.env.APP_NAME || 'WeVolunteer';
export const MAX_AUTO_SELECT_DRAWS = Number(process.env.MAX_AUTO_SELECT_DRAWS) || 5;

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
 * Off by default: turning it on without a working SMTP transport locks every
 * user out with no way through. Turn it on once SMTP_* is configured (see
 * Task 6 / README).
 */
export const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === 'true';

// Paths an authenticated-but-unverified user may still reach when
// REQUIRE_EMAIL_VERIFICATION is on: enough to see their own account and finish
// verifying. Deliberately minimal — no action routes, no other users' data.
export const EMAIL_GATE_ALLOWLIST = [
  '/api/auth/me',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',
  '/api/notifications'
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
