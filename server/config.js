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

export const JWT_SECRET = process.env.JWT_SECRET || 'sbvolunteers_secret_key_12345';

export const VALID_GRADES = ['9', '10', '11', '12', 'Adult', 'N/A'];
export const VALID_CATEGORIES = ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];

export const APP_NAME = process.env.APP_NAME || 'SBVolunteers';
export const SCHOOL_NAME = process.env.SCHOOL_NAME || 'South Brunswick, NJ';
export const MAX_AUTO_SELECT_APPLICANTS = Number(process.env.MAX_AUTO_SELECT_APPLICANTS) || 100;
export const MAX_AUTO_SELECT_DRAWS = Number(process.env.MAX_AUTO_SELECT_DRAWS) || 5;
export const DEFAULT_EMAIL_FROM = `"${APP_NAME}" <noreply@sbvolunteers.org>`;

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
