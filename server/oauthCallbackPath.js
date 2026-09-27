/**
 * The one path the OAuth providers are allowed to send a user back to.
 *
 * ── Why this is a shared constant and not a string in two places ──
 *
 * `OAUTH_REDIRECT_URI` is an environment variable, so nothing in the repository
 * describes the value a deployment actually runs. On 2026-09-12 production was
 * set to `https://app.wevolunteers.org/api/auth/google/callback` — a route that
 * has never existed on either side. The provider was asked to deliver every
 * authorization code to a 404, and Google sign-in had never worked in
 * production. No test noticed, because no test can see a deployment's
 * environment, and the config guard beside this one only asked whether the host
 * was a loopback address. The host was right. The path was invented.
 *
 * The callback is served by the SPA — `App.jsx` renders `OAuthCallback` at this
 * path, which then posts the code to `/api/oauth/<provider>/callback`. So the
 * value lives here, `App.jsx` routes on it, and `config.js` refuses to boot a
 * production server whose redirect URI does not end at it. Changing the route
 * now moves the guard with it; changing it in one place only is a build error
 * rather than a silent 404 discovered by a student pressing a button.
 *
 * Kept in `server/` because `src/` already imports shared constants from here
 * (see `src/eventCategories.js`, `src/moderation.js`) and never the reverse.
 * It must stay dependency-free for that reason: this module is bundled into the
 * browser, so anything it imports goes with it.
 */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';
