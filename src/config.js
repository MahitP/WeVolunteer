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
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'SBVolunteers';
export const SCHOOL_NAME = import.meta.env.VITE_SCHOOL_NAME || 'South Brunswick, NJ';
export const ENABLE_LEADERBOARD = import.meta.env.VITE_ENABLE_LEADERBOARD !== 'false';
export const DEFAULT_THEME_COLOR = import.meta.env.VITE_DEFAULT_THEME_COLOR || '#2563eb';
