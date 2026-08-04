import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { DEMO_MODE, IS_PRODUCTION, ALLOWED_ORIGINS, COOKIE_NAME } from './config.js';
import { db } from './db.js';
import { recordError, hashUserId } from './errorReporter.js';

import authRoutes from './routes/authRoutes.js';
import accountRoutes from './routes/accountRoutes.js';
import userRoutes from './routes/userRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import applicationRoutes from './routes/applicationRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import contentRoutes from './routes/contentRoutes.js';
import geocodeRoutes from './routes/geocodeRoutes.js';
import weatherRoutes from './routes/weatherRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import privacyRoutes from './routes/privacyRoutes.js';
import oauthRoutes from './routes/oauthRoutes.js';
import reauthRoutes from './routes/reauthRoutes.js';
import errorRoutes from './routes/errorRoutes.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

if (process.env.TRUST_PROXY) {
  const value = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(value) ? process.env.TRUST_PROXY : value);
}

/**
 * Response compression.
 *
 * Measured before this existed: `GET /api/events` with 503 events returned
 * 690,129 bytes, and requesting it with `Accept-Encoding: gzip` returned a
 * byte-identical response because nothing was negotiating encoding. The same
 * payload gzips to 12,769 bytes — 54× smaller.
 *
 * That matters more here than the raw ratio suggests: this is a mobile-first
 * product used on school cellular, and App.jsx refetches the event list on every
 * session restore. JSON of this shape (repeated keys, repeated organizer names)
 * is close to the best case for gzip.
 *
 * Mounted FIRST, before helmet and the routers, because compression works by
 * wrapping `res.write`/`res.end` — middleware registered after a response has
 * already been written cannot compress it.
 *
 * `threshold: 1024` leaves small bodies alone: below roughly a kilobyte the
 * gzip header and CPU cost exceed the saving. Level 6 is zlib's default and the
 * usual size/CPU knee; level 9 costs materially more CPU for a few percent.
 *
 * BREACH is not a concern for these responses. The attack needs an attacker-
 * controlled string reflected into the same response as a secret; the session
 * lives in an HttpOnly cookie and is never echoed in a body, and there is no CSRF
 * token in a payload to extract.
 */
app.use(compression({
  threshold: 1024,
  level: 6,
  // Honour an explicit opt-out, which is the documented escape hatch for a
  // client that needs to read a raw stream (and makes the export endpoints
  // debuggable without decompressing).
  filter: (req, res) => (req.headers['x-no-compression'] ? false : compression.filter(req, res))
}));

app.use(helmet({
  /**
   * CSP was disabled outright in v1.0, which left cross-site scripting with no
   * mitigation at all — the same threat that motivated moving the session token
   * out of localStorage. An HttpOnly cookie stops an injected script *reading*
   * the session; it does nothing to stop the script running and making
   * authenticated same-origin requests with it. This directive set is the half
   * of that pair that addresses the vector rather than the consequence.
   */
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],

      // No 'unsafe-inline'. This is the directive that matters: it is what
      // stops an injected <script> from executing. Stage 3's theme pre-paint
      // script is an external file in public/ specifically to satisfy this.
      scriptSrc: ["'self'"],

      /**
       * The client previously used 576 inline `style={{}}` blocks, but they have been
       * refactored. The few remaining dynamic styles use element.style which is CSP safe.
       */
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],

      // index.css:1 imports Bricolage Grotesque and Public Sans.
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],

      // data: covers the inline SVG favicon and any base64 image.
      imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://*.basemaps.cartocdn.com'],

      // The API is same-origin in both topologies: production serves the SPA
      // and the API from this process, and development proxies /api through
      // Vite. Nothing legitimate calls a third-party origin.
      connectSrc: ["'self'", 'https://*.tile.openstreetmap.org', 'https://*.basemaps.cartocdn.com'],

      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Scoped to /api deliberately.
//
// Mounted globally, this also guarded the static bundle — and browsers send an
// `Origin` header when fetching `<script type="module">` even same-origin. So a
// production deployment whose CORS_ORIGINS did not exactly match its public
// origin answered its own JavaScript with 403 and served a blank white page,
// with nothing in the UI to explain it. That is the wrong failure for a
// misconfigured allowlist, and it made CORS_ORIGINS a silent, total outage
// rather than the API access control it is meant to be.
//
// The allowlist exists to say who may call the API from another origin. The
// SPA's own assets are public files and are served regardless — they already
// were to any client that omitted the header.
app.use('/api', cors((req, callback) => {
  const origin = req.headers.origin;
  const allow = { origin: true, credentials: true };

  // No Origin at all: curl, a health checker, a same-origin GET. Never a
  // cross-site browser request, so nothing to guard against.
  if (!origin) return callback(null, allow);

  if (ALLOWED_ORIGINS.includes(origin)) return callback(null, allow);

  // Development only: any loopback origin.
  //
  // In dev the client is served by Vite on its own port and proxies /api here,
  // so the browser's Origin is the Vite origin while the Host has been rewritten
  // to this server — the same-origin check below cannot match. Pinning
  // CORS_ORIGINS to a fixed port breaks the moment Vite picks a different one
  // (which it does whenever 5173 is taken), and the failure is invisible:
  // every GET works and only writes fail, so the app loads and login 403s.
  //
  // Strictly gated on NOT production, so this can never widen a real
  // deployment. A production build never reaches this branch.
  if (!IS_PRODUCTION) {
    try {
      const { hostname } = new URL(origin);
      const isLocalNetwork = hostname === 'localhost' || 
                             hostname === '127.0.0.1' || 
                             hostname === '[::1]' || 
                             hostname.startsWith('192.168.') || 
                             hostname.startsWith('10.') || 
                             /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname);
      if (isLocalNetwork) {
        return callback(null, allow);
      }
    } catch { /* malformed Origin — fall through to the checks below */ }
  }

  // Same-origin requests must always pass.
  //
  // Browsers attach `Origin` to POST/PATCH/DELETE even when the page and the
  // API share an origin — which they do in the production topology, where this
  // same Express process serves both. Without this check, a deployment whose
  // CORS_ORIGINS did not exactly match its public origin still loaded the app
  // and still served every GET, but refused every login and every write with a
  // 403 the UI could not explain. A partial failure like that is far harder to
  // diagnose than a total one.
  //
  // Comparing the Origin's host to the request's own Host is not a weakening:
  // a cross-site request carries the attacker's origin and the victim's host,
  // so it still fails. (The reverse proxy must pass the real Host through —
  // `proxy_set_header Host $host` — which the deployment runbook specifies.)
  let sameOrigin = false;
  try {
    sameOrigin = new URL(origin).host === req.headers.host;
  } catch {
    sameOrigin = false; // malformed Origin header
  }
  if (sameOrigin) return callback(null, allow);

  callback(new Error(`Origin not allowed by CORS: ${origin}`));
}));

/**
 * Minimal request log.
 *
 * The application produced no access log at all — 671 `console.log` calls of
 * incidental detail and no record of who called what. During an incident ("a
 * student says their hours vanished at some point on Tuesday") there was nothing to
 * reconstruct from, and the reverse proxy's log knows the URL but not which account
 * was behind the session.
 *
 * Deliberately hand-rolled rather than adding morgan: this is four lines of
 * behaviour, and a new production dependency needs more justification than that.
 *
 * ── What is deliberately NOT logged ──
 *
 * The query string is stripped. `/?verify=<token>` and `/?reset=<token>` carry live
 * single-use credentials, and while those are client-side routes rather than API
 * calls, a log format that includes query strings is one refactor away from
 * capturing them. Bodies are never logged — they hold passwords. The user id is
 * included because it is the thing that makes the log useful for support, and it is
 * an opaque identifier rather than a name or address.
 *
 * Off by default outside production so `npm test` output stays readable; set
 * REQUEST_LOG=true to force it on.
 */
const REQUEST_LOG = process.env.REQUEST_LOG
  ? process.env.REQUEST_LOG === 'true'
  : IS_PRODUCTION;

if (REQUEST_LOG) {
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const pathOnly = req.originalUrl.split('?')[0];
      const actor = req.user?.id ? ` user=${req.user.id}` : '';
      console.log(
        `[req] ${req.method} ${pathOnly} ${res.statusCode} ${ms.toFixed(0)}ms${actor}`
      );
    });
    next();
  });
}

/**
 * A tighter body cap for the one unauthenticated write, mounted BEFORE the
 * global parser — and the ordering is the entire point.
 *
 * The obvious placement, a route-level `express.json({ limit: '8kb' })` on the
 * handler itself, does nothing at all. `express.json` marks a request parsed and
 * skips one that already is, so by the time a router runs, the global parser
 * below has consumed the body under the 100 kB limit and the tighter cap never
 * engages. Measured before this was written: a 5 kB body sailed through a 1 kB
 * route-level limit with a 200.
 *
 * That silence is what makes it worth a comment. A test written from the design
 * would expect a 413, get a 202, and the tempting fix is to relax the test
 * rather than notice the control was never active.
 *
 * Scoped to the one path, so every other route keeps the 100 kB limit below.
 * A stack trace does not need more than 8 kB, and this is the only endpoint in
 * the application that accepts a body from someone with no session.
 */
app.use('/api/errors/report', express.json({ limit: '8kb' }));

app.use(express.json({ limit: '100kb' }));

// Populates req.cookies for authenticateToken. Mounted before the routers and
// before the rate limiters so every downstream handler sees the same shape.
app.use(cookieParser());

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
function limitHandler(message) {
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

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: limitHandler('Too many sign-in attempts from this device.'),
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 10000 : 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many requests from this device.'),
});

/**
 * Endpoints that send an email must count EVERY request, not just failures:
 * forgot-password always returns 200 (so it cannot leak whether an address
 * exists), which means authLimiter's skipSuccessfulRequests would never count
 * it and it would have no effective limit at all.
 *
 * ── Keyed on the ADDRESS, not the device ──
 *
 * This was 5 per 15 minutes per IP. A school campus leaves through a single public
 * address, so on signup day the entire building shared five resend-verification
 * attempts between them — and with REQUIRE_EMAIL_VERIFICATION defaulting to ON,
 * being unable to resend is being unable to use the account at all. The sixth
 * student to mistype their address was stuck until the window rolled over.
 *
 * Meanwhile the abuse this limiter exists to prevent — using the app to flood
 * somebody's inbox — is inherently per-ADDRESS. Keying on the target address makes
 * the limit match the abuse: one address still gets five messages per window, while
 * two hundred different students behind one NAT do not contend at all.
 *
 * Rotating the address to get a fresh bucket is the obvious bypass, which is why
 * `mailIpCeilingLimiter` below sits underneath this one. Both must pass.
 */
function mailKeyGenerator(req, res) {
  const raw = req.body?.email;
  if (typeof raw === 'string' && raw.includes('@')) {
    // Normalised so `Ava@School.org`, `ava@school.org` and a padded variant share
    // one bucket — otherwise case alone multiplies the allowance indefinitely.
    return `mail:${raw.trim().toLowerCase()}`;
  }

  /**
   * No address in the body — which is the case for `resend-verification`, an
   * authenticated endpoint that takes the account from the session.
   *
   * Keying that on IP would rebuild the exact problem this function exists to fix,
   * on the single endpoint where it hurts most: resend-verification is what a
   * student uses when their verification mail did not arrive, so a per-campus limit
   * there means the sixth student to need help cannot get it.
   *
   * The session cookie identifies the account, and cookieParser runs before these
   * limiters so it is available even though `authenticateToken` has not run yet.
   * It is hashed rather than used directly: a rate-limiter key is held in memory and
   * can surface in diagnostics, and a raw session JWT is a live credential.
   */
  const session = req.cookies?.[COOKIE_NAME];
  if (session) {
    const digest = createHash('sha256').update(session).digest('hex').slice(0, 32);
    return `sess:${digest}`;
  }

  // Genuinely anonymous and address-less: per-IP, so the endpoint is never
  // unlimited. ipKeyGenerator handles IPv6 normalisation, which a bare req.ip does
  // not.
  return `ip:${ipKeyGenerator(req, res)}`;
}

export const mailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.MAIL_RATE_LIMIT) || (DEMO_MODE ? 1000 : 5),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: mailKeyGenerator,
  handler: limitHandler('Too many email requests for that address.'),
});

/**
 * Per-IP ceiling under the per-address limiter above.
 *
 * Generous on purpose: it must never be what a legitimate campus hits, only what an
 * address-rotating enumeration attempt hits. 120 per 15 minutes is far above any
 * plausible human use of one address, and far below the volume needed to walk a
 * district's address space.
 */
export const mailIpCeilingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.MAIL_IP_CEILING) || (DEMO_MODE ? 10000 : 120),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many email requests from this network.'),
});

// The public certificate-verify endpoint is unauthenticated by design (a
// school office checking a printout has no account), so it has no other
// guard against being hammered to enumerate codes. Every request counts —
// deliberately no skipSuccessfulRequests — because a successful lookup is
// exactly the thing an enumeration attempt looks like from the outside.
export const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Wording matters here: this response must never read as a verdict on the
  // certificate. A school office checking several printouts in a row is the
  // expected way to hit this, and telling them a genuine record is invalid
  // would be worse than making them wait.
  handler: limitHandler('Too many certificate checks from this device. This is not a verdict on the certificate.'),
});

/**
 * Availability probes for the signup form.
 *
 * These answer "does this person have an account here" to anyone who asks, and
 * the people here are mostly minors. The form needs them — a username field
 * with no live check is a worse experience for everyone — but the honest
 * ceiling for one person filling in one form is a few dozen probes, not the
 * 600 that the blanket apiLimiter allowed. `skipSuccessfulRequests` is
 * deliberately off: a successful lookup is exactly what harvesting looks like.
 */
/**
 * The step-up password path.
 *
 * `reauth.js` locks a single challenge after five wrong guesses, and on its own
 * that bounds nothing: opening a fresh challenge costs one request and resets
 * the counter, so an attacker holding a stolen session can guess indefinitely
 * at one extra round trip per attempt. The per-challenge limit is about one
 * challenge; this is about the endpoint, and only the pair of them bounds
 * guessing.
 *
 * Tighter than authLimiter's 10 because the population is different. /login is
 * used by everyone, several times a day, and is where a mistyped password
 * normally happens; re-verification is used a handful of times a year by any
 * one person, immediately after they have already signed in — so five failures
 * in fifteen minutes is far outside honest use and well inside what a guesser
 * needs.
 *
 * `skipSuccessfulRequests` so that a user working through several sensitive
 * settings in one sitting never spends the budget by succeeding. The guessing
 * allowance is unchanged by that: an attacker's attempts are, by definition,
 * the ones that fail.
 *
 * Per-IP, matching the login limiter it sits beside. The campus-NAT problem
 * documented on mailLimiter above applies in principle, but the endpoint it
 * would strand somebody on is one they reach only after signing in
 * successfully, and diverging from /login's keying on the app's other password
 * oracle would need a better reason than symmetry.
 */
export const reauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.REAUTH_RATE_LIMIT) || (DEMO_MODE ? 1000 : 5),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: limitHandler('Too many failed verification attempts from this device.'),
});

/**
 * Client error reports.
 *
 * The only unauthenticated write in the application, so it carries a limiter of
 * its own rather than relying on the blanket apiLimiter's 600.
 *
 * Successes are COUNTED — unlike authLimiter, which skips them. A flood of
 * accepted reports is exactly what an attacker sends, and this endpoint answers
 * 202 to everything, so skipping successes would skip the entire attack.
 *
 * Twenty per fifteen minutes is far above honest use: the client caps itself at
 * five reports per page load, so twenty is four full page loads of a completely
 * broken build from one address.
 *
 * Per-IP, and therefore only half the protection. It bounds requests from one
 * address and says nothing about a thousand; the 500-group ceiling in
 * errorReporter.js bounds STORAGE regardless of where the traffic comes from.
 * Neither subsumes the other and both are required.
 */
export const errorReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.ERROR_REPORT_RATE_LIMIT) || (DEMO_MODE ? 1000 : 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many error reports from this device.'),
});

export const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 5000 : 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many lookups from this device.'),
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
// Both mail endpoints get the per-IP ceiling first, then the per-address limiter.
// Order is immaterial to the outcome (both must pass) but reads in the direction of
// broad-to-specific.
app.use('/api/auth/forgot-password', mailIpCeilingLimiter, mailLimiter);
app.use('/api/auth/resend-verification', mailIpCeilingLimiter, mailLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/verify-email', authLimiter);

/**
 * Sensitive account actions that are not /login.
 *
 * Each was reachable 600 times per window under apiLimiter alone, which made
 * every one of them a better brute-force target than the login form it sat
 * beside:
 *   • /api/oauth/link       — took an account password with an unauthenticated
 *                             15-minute token, so it was a pure password oracle.
 *   • /api/auth/change-password — took the current password.
 *   • DELETE /api/auth/account  — took the password, and succeeds destructively.
 *
 * None of the three takes a password any more (v1.2b Task 6): each is behind
 * `requireAAL2`, and the only password comparison in the step-up flow is
 * `/api/auth/reauth/password`, which carries its own much tighter limiter below.
 * These mounts stay regardless — the endpoints are still destructive or
 * identity-changing, which is reason enough not to serve them at general API
 * volume, and DELETE /api/auth/account is also on the email-gate allowlist, so
 * it is reachable by accounts that can reach almost nothing else.
 */
app.use('/api/auth/change-password', authLimiter);
app.use('/api/auth/account', authLimiter);

/**
 * Changing the email address sends two mails per request — a confirmation to
 * the new address and a security notice to the old one — so it belongs on the
 * mail limiter, not just the auth one. Without it, a live session could be used
 * to flood an arbitrary address with confirmation mail from this domain.
 *
 * It took the account password until v1.2b Task 6, which made it a password
 * oracle on the same footing as /change-password. It is now behind
 * `requireAAL2('email.change')` instead, and the mail-flooding reason above is
 * the one that keeps these limiters here.
 */
app.use('/api/auth/change-email', mailIpCeilingLimiter, mailLimiter);
app.use('/api/auth/confirm-email-change', authLimiter);
app.use('/api/auth/change-username', authLimiter);

/**
 * Step-up re-verification.
 *
 * The prefix carries authLimiter for the same reason /api/oauth does: opening a
 * challenge writes a row and the OAuth callback grants one, so neither belongs
 * at general API volume. authLimiter skips successful requests, so a user
 * verifying normally never counts against it.
 *
 * The password path additionally carries its own, much tighter limiter — it is
 * a password oracle on the same footing as /api/auth/change-password, and the
 * per-challenge attempt counter does not bound an attacker willing to open a
 * new challenge per guess. Both must pass; the specific one is mounted second
 * so the broad refusal is the one a flood sees first.
 */
app.use('/api/errors/report', errorReportLimiter);
app.use('/api/auth/reauth', authLimiter);
app.use('/api/auth/reauth/password', reauthLimiter);

// Mounted on the prefix rather than per-route, so /link is counted once. The
// callback mints sessions and /url writes a pending-signup row, so neither
// belongs at general API volume either. authLimiter skips successful requests,
// so the read-only /providers and /accounts calls the UI makes cost nothing.
app.use('/api/oauth', authLimiter);

app.use('/api/auth/check-username', lookupLimiter);
app.use('/api/auth/check-email', lookupLimiter);

app.use('/api/certificates/verify', verifyLimiter);
app.use('/api', apiLimiter);

app.use(authRoutes);
app.use(accountRoutes);
app.use(userRoutes);
app.use(oauthRoutes);
app.use(reauthRoutes);
app.use(eventRoutes);
app.use(applicationRoutes);
app.use(attendanceRoutes);
app.use(adminRoutes);
app.use(contentRoutes);
app.use(geocodeRoutes);
app.use(weatherRoutes);
app.use(messageRoutes);
app.use(privacyRoutes);
app.use(errorRoutes);


// Read once at import rather than per request. Derived from package.json so it
// cannot drift from the released version the way a hardcoded literal did — this
// previously reported 2.0.0 against a 1.0.0 release, which is actively
// misleading when you are trying to identify a running build during an incident.
const VERSION = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
).version;

/**
 * How often the WRITE half of the health probe actually runs.
 *
 * The write probe touches page 1, which appends a WAL frame. Measured properly, by
 * isolating it from database seeding: 500 probes with the interval forced to 1ms
 * grew the `-wal` sidecar by 2,060,000 bytes — **~4,120 bytes per probe**, i.e. one
 * page plus frame header. (A first attempt attributed 2.9 MB to the probe; almost
 * all of that turned out to be DEMO_MODE seeding, which produces 1.9 MB on its own.
 * Recorded so the number is not re-derived wrongly.)
 *
 * At the original 10s default that is ~8,600 probes and ~35 MB of WAL churn per day
 * on a system that may be otherwise idle. At 60s it is ~5.8 MB. The file stays
 * bounded either way because SQLite auto-checkpoints, and a clean shutdown
 * checkpoints the remainder — `user_version` and `integrity_check` were both intact
 * after the stress run — so this is about pointless I/O, not growth.
 *
 * 60s still surfaces a read-only or full-disk condition well inside the alerting
 * window the runbook specifies (`/health` failing twice consecutively). The read
 * probe stays unconditional because it costs nothing.
 *
 * Why a page write at all, rather than `BEGIN IMMEDIATE; ROLLBACK;` — which would
 * take a write lock with no WAL frame: acquiring a lock proves the file is not
 * read-only, but it does NOT prove there is room to write. On a single-volume
 * deployment holding the database, the logs, the backups and the export archives,
 * disk exhaustion is the likelier of the two failures, so the probe has to actually
 * write something.
 */
const WRITE_PROBE_INTERVAL_MS = Number(process.env.HEALTH_WRITE_PROBE_MS) || 60_000;

let writeProbeCache = { at: 0, ok: null };

/**
 * Confirms the database can be written, not merely read.
 *
 * ── Why a read was not enough ──
 *
 * The probe used to be `db.prepare('SELECT 1').get()`. SQLite serves reads
 * perfectly well from a database it cannot write to, so a full disk or a read-only
 * remount left every mutation in the app returning 500 while this endpoint
 * reported `{"status":"ok","database":"connected"}`. The runbook's two
 * highest-priority alerts both key off /health, so the monitor stayed green
 * through precisely the incident it exists to catch — and on the volume holding a
 * school's service-hour records, that is the incident that matters.
 *
 * ── Why `PRAGMA user_version` ──
 *
 * It is read, then written back unchanged. That attempts a genuine page write, so
 * it fails on a read-only filesystem AND on a full disk, while leaving no logical
 * trace: no scratch table, no row, no schema change, nothing to clean up, and no
 * value that any other code reads (verified: `user_version` is referenced nowhere
 * else in the codebase). A scratch INSERT/ROLLBACK would also work but leaves
 * rowid sequences and WAL frames behind for no extra signal.
 */
function probeWritable() {
  const now = Date.now();
  if (writeProbeCache.ok !== null && now - writeProbeCache.at < WRITE_PROBE_INTERVAL_MS) {
    return writeProbeCache.ok;
  }

  let ok = false;
  try {
    const current = db.prepare('PRAGMA user_version').get();
    const value = Number(current?.user_version ?? 0);
    // Interpolated rather than bound: PRAGMA does not accept bind parameters. The
    // value comes from SQLite itself and is coerced through Number(), so it cannot
    // carry anything but a number.
    db.exec(`PRAGMA user_version = ${value}`);
    ok = true;
  } catch {
    ok = false;
  }

  writeProbeCache = { at: now, ok };
  return ok;
}

// Health check is registered BEFORE the production SPA catch-all below, so it
// always returns its JSON — a load balancer must never receive index.html here.
app.get('/health', (req, res) => {
  let readable = false;
  try {
    db.prepare('SELECT 1').get();
    readable = true;
  } catch {
    readable = false;
  }

  if (!readable) {
    // 503 rather than 500: this is "not available right now", which is what a load
    // balancer and an uptime monitor are built to interpret. Deliberately no error
    // detail — /health is unauthenticated and must not become a filesystem oracle
    // by echoing a path out of a SQLite error message.
    return res.status(503).json({
      status: 'error',
      database: 'disconnected',
      writable: false,
      version: VERSION
    });
  }

  const writable = probeWritable();
  if (!writable) {
    return res.status(503).json({
      status: 'error',
      database: 'read-only',
      writable: false,
      version: VERSION
    });
  }

  res.json({ status: 'ok', database: 'connected', writable: true, version: VERSION });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

if (IS_PRODUCTION) {
  const distPath = path.join(__dirname, '../dist');

  /**
   * Static assets, with cache headers matched to how Vite names them.
   *
   * Everything under `assets/` carries a content hash in its filename
   * (`index-DyqEDd61.js`), so the bytes behind a given URL can never change — which
   * is precisely the condition `immutable` describes. Without it these were served
   * with only an ETag, so every navigation on a cold-ish cache still paid a
   * conditional request per asset. On school cellular, over ~20 chunks, that is the
   * difference between one round trip and twenty.
   *
   * `index.html` is deliberately excluded and marked no-cache: it is the file that
   * points at the hashed assets, so a cached copy would keep sending returning
   * users to the previous deployment's chunks indefinitely.
   */
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/[/\\]assets[/\\]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));

  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(distPath, 'index.html'));
    } else {
      res.status(404).json({ error: 'Endpoint not found' });
    }
  });
}

// Error handler registered LAST, so it catches errors from every layer above,
// including the static/SPA block.
app.use((err, req, res, _next) => {
  if (String(err.message).startsWith('Origin not allowed by CORS')) {
    console.warn(err.message);
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  /**
   * A body express.json refused is the CALLER's mistake, not ours.
   *
   * `entity.too.large` used to fall through to the 500 branch, so a client that
   * posted more than the 100kb limit was told the server had failed. That
   * misleads the caller — nothing suggests "send less" — and it files a routine
   * rejected request as a server defect in monitoring, which buries the real
   * 500s among the noise.
   */
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'That request was too large. The limit is 100kb.',
      code: 'payload_too_large'
    });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Only genuinely unexpected failures are logged as errors and reported as 500,
  // so the log stays a list of things worth investigating.
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });

  /**
   * Recorded AFTER the response, and only on this branch.
   *
   * ── After ──
   *
   * The response is already written when this runs, so nothing here can change
   * what the user receives. That ordering is the whole reason capture is safe to
   * put in an error handler at all: this is code running while handling an
   * exception, and an exception thrown *here* is one Express answers by killing
   * the response. `recordError` never throws — but the ordering means it would
   * not matter even if that guarantee were lost.
   *
   * ── Only this branch ──
   *
   * The CORS 403, the 413 and the 400 above return before reaching this line,
   * deliberately. `entity.too.large` used to fall through to the 500 branch and
   * was moved out precisely because "it files a routine rejected request as a
   * server defect in monitoring, which buries the real 500s among the noise" —
   * and a dashboard is exactly the monitoring that comment was about. A client
   * posting an oversized body is not a defect in this application.
   *
   * `req.route?.path` is the Express PATTERN (`/api/events/:id`), never
   * `req.originalUrl` — a real URL carries a query string, and query strings
   * carry search terms, addresses and email addresses. It is undefined when the
   * failure happened before routing resolved, which is honest: there was no
   * route.
   */
  recordError(db, {
    source: 'server',
    kind: err?.constructor?.name || 'Error',
    message: err?.message,
    stack: err?.stack,
    route: req.route?.path,
    method: req.method,
    statusCode: 500,
    userHash: hashUserId(req.user?.id),
    role: req.principal?.effectiveRole ?? req.user?.role,
    release: VERSION,
    context: { statusCode: 500, method: req.method }
  });
});
