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
