/**
 * Build-time flags.
 *
 * Demo mode is opt-in, never opt-out. It gates the account switcher and the
 * one-click seeded sign-ins — scaffolding for exploring the product, which in
 * a real deployment would be a way to sign in as anyone with a published
 * password. A production build has no VITE_DEMO_MODE, so this is false and
 * both disappear.
 *
 * The server has a matching DEMO_MODE flag guarding the reset endpoint. The
 * two are independent on purpose: neither can switch the other on.
 */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

// Global application configurations
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'WeVolunteer';
export const SCHOOL_NAME = import.meta.env.VITE_SCHOOL_NAME || 'South Brunswick, NJ';
export const ENABLE_LEADERBOARD = import.meta.env.VITE_ENABLE_LEADERBOARD !== 'false';
export const DEFAULT_THEME_COLOR = import.meta.env.VITE_DEFAULT_THEME_COLOR || '#2563eb';

/**
 * Where the district's privacy notice lives.
 *
 * This platform holds identifying information about minors — names, grades,
 * schools, email addresses — and shows some of it to other users (organizers
 * see contact details for students who apply to their events). Nothing in the
 * product told a student or parent what is collected, who can see it, how long
 * it is kept, or how to have it removed.
 *
 * Deliberately empty by default, and every control that depends on it renders
 * only when it is set. Shipping placeholder legal text would be worse than
 * shipping none: it would create the appearance of a reviewed policy where
 * none exists. The district supplies the URL; this only wires it in.
 *
 * Set VITE_PRIVACY_URL at build time to switch on the signup acknowledgement.
 */
export const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL || '';

/**
 * The origin printed on a certificate, for whoever has to verify it.
 *
 * This used to be the literal string "wevolunteer.org", which meant every
 * printed certificate directed a school office to a domain the district does
 * not control, no matter where the app was actually deployed.
 *
 * The default is the origin the page is being served from, which is correct
 * without any configuration: the person printing is already on the right host.
 * VITE_PUBLIC_URL exists to override it for the case where certificates are
 * printed from somewhere other than the public address (a staging host, or an
 * internal hostname behind the district's proxy).
 *
 * Returns a bare origin with no trailing slash, e.g. "volunteers.example.org".
 */
export function publicOrigin() {
  const configured = import.meta.env.VITE_PUBLIC_URL;
  const raw = configured || (typeof window !== 'undefined' ? window.location.origin : '');
  return String(raw).replace(/\/+$/, '').replace(/^https?:\/\//, '');
}
