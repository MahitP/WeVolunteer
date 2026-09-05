/**
 * CSRF defence in depth, and the one thing it adds that the CORS layer cannot.
 *
 * ── What already protects this application ──
 *
 * Two things, and they are genuinely load-bearing:
 *
 *   1. `sameSite: 'lax'` on the session cookie (config.js), which stops a
 *      browser attaching it to a CROSS-SITE POST, PATCH or DELETE.
 *   2. A server-side Origin allowlist on `/api` (app.js), which answers a
 *      request from an unlisted origin with 403 before any handler runs.
 *
 * Between them the classic attack — evil.example auto-submitting a form at our
 * API — is refused twice. This module does not replace either.
 *
 * ── The two gaps it closes ──
 *
 * **A sibling subdomain is SAME-SITE.** `SameSite=Lax` is scoped to the
 * registrable domain, so `wevolunteers.org` and `app.wevolunteers.org` are the
 * same site and Lax does not blink: the cookie IS attached to a POST from one
 * to the other. config.js says so itself, in the comment on `cookieOptions`:
 *
 *     REVISIT THIS if the app is ever served from a subdomain alongside another
 *     application […] Either change invalidates the reasoning above.
 *
 * The planned `wevolunteers.org` + `app.wevolunteers.org` split is exactly that
 * condition. The Origin allowlist would still refuse it as long as the
 * marketing origin is never added to `CORS_ORIGINS` — but that makes a
 * security property depend on an operator remembering not to add a hostname
 * they own to a list of hostnames they own. That is a configuration away from
 * being wrong, and nothing would report it.
 *
 * **A request with no `Origin` is currently allowed.** The CORS layer returns
 * early for it, reasoning that it is curl or a health checker. True today, and
 * it stays true here for requests carrying no session — but it means the
 * allow-decision rests on the absence of a header rather than on evidence of
 * intent.
 *
 * ── Why `Sec-Fetch-Site` ──
 *
 * It is set by the BROWSER, not by the page, and it cannot be overridden by
 * script — it is a forbidden header name. So unlike `Origin` (absent in some
 * cases) or `Referer` (strippable by referrer policy), a value that arrives is
 * evidence, and script on an attacking page cannot forge it. Every browser
 * that could carry out this attack sends it.
 *
 *     same-origin  the page and this API share an origin        -> allow
 *     none         typed, bookmarked, or a non-browser client   -> allow
 *     same-site    a SIBLING SUBDOMAIN                          -> REFUSE
 *     cross-site   a different site entirely                    -> REFUSE
 *
 * ── Why it only guards cookie-bearing requests ──
 *
 * CSRF is an *ambient credential* attack: it works because the browser attaches
 * the session automatically. A request with no session cookie has nothing to
 * abuse, and refusing it would break the legitimate non-browser callers the
 * CORS layer deliberately admits — health checks, the accessibility harness,
 * curl in a runbook. So the guard applies precisely where the vulnerability
 * exists: an unsafe method, carrying our session cookie, that the browser
 * itself reports did not originate from our own origin.
 *
 * This also means the guard cannot be defeated by omitting the cookie, because
 * omitting the cookie is not an attack — the request is then unauthenticated
 * and every existing authorization check applies to it.
 */
import { COOKIE_NAME } from './config.js';

/** Methods that cannot change state, and so cannot be the target of CSRF. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What the browser reports, and whether we accept it for a state change. */
const REFUSED_FETCH_SITES = new Set(['cross-site', 'same-site']);

/**
 * Reads the session cookie without depending on cookie-parser having run.
 *
 * `req.cookies` is populated by `cookieParser()` upstream, but a guard whose
 * correctness silently depends on middleware ORDER is a guard that fails open
 * the day someone reorders app.js. The raw header is the authority; the parsed
 * object is the fast path.
 */
function carriesSession(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return true;
  const raw = req.headers.cookie;
  if (!raw) return false;
  return raw.split(';').some(part => part.trim().startsWith(`${COOKIE_NAME}=`));
}

/**
 * Express middleware. Mount on `/api`, after cookie-parser, before the routers.
 *
 * Answers 403 with the same JSON shape the rest of the API uses, so a client
 * that hits it sees an error it can render rather than an HTML error page.
 */
export function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!carriesSession(req)) return next();

  const site = req.headers['sec-fetch-site'];
  if (site && REFUSED_FETCH_SITES.has(site)) {
    /* Deliberately does not name the offending origin. The response is read by
       whatever made the request, and confirming which sibling hostnames reach
       the API is not information to hand back. */
    return res.status(403).json({
      error: 'Cross-site request refused.',
      code: 'CSRF_REFUSED'
    });
  }

  return next();
}
