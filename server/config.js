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
export const DEFAULT_EMAIL_FROM = `"${APP_NAME}" <noreply@sbvolunteers.org>`;

export const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);
