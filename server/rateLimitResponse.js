/**
 * The 429 response body shared by every limiter on the platform.
 *
 * ── Why this is its own module ──
 *
 * `limitHandler` lived in `app.js` next to the limiters that use it, which read
 * well until you follow the imports: `checkinLimiters.js` and `reportLimiter.js`
 * also need it, and they are reached *from* `app.js` by way of the route modules
 * — so importing it back out of `app.js` closed a cycle.
 *
 * That cycle worked, but only by accident of how ESM instantiates modules: a
 * hoisted `function` declaration is initialised before any module body runs, so
 * the half-evaluated `app.js` could still hand the binding over. Anything that
 * rewrites the declaration into an assigned binding — a bundler, a coverage
 * instrumenter, a hot-reloader, an APM loader hook such as
 * `import-in-the-middle` — puts it in the temporal dead zone instead, and the
 * process dies at boot with `Cannot access 'limitHandler' before initialization`
 * rather than warning about anything.
 *
 * The function depends on nothing, so the fix is to keep it where nothing has to
 * reach backwards for it. This module imports no other module in the tree and
 * must stay that way: it is a leaf, and that is the whole point of it.
 */

/**
 * Builds the 429 response for a limiter.
 *
 * express-rate-limit's default is `text/plain` "Too many requests, please try
 * again later." The client parses every error body as JSON, so that default
 * left it with nothing to show and it fell back to printing the raw status —
 * students hitting the login limiter were told "Request failed (429)", which
 * explains neither what happened nor what to do.
 *
 * Every limited response is now JSON in the same `{ error }` shape as the rest
 * of the API, carries `code: 'rate_limited'` so a caller can branch on it, and
 * states the wait in minutes derived from the limiter's own window.
 */
export function limitHandler(message) {
  return (req, res) => {
    const resetAt = req.rateLimit?.resetTime;
    const minutes = resetAt
      ? Math.max(1, Math.ceil((new Date(resetAt) - Date.now()) / 60000))
      : 15;
    res.status(429).json({
      error: `${message} Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      code: 'rate_limited',
      retryAfterMinutes: minutes
    });
  };
}
