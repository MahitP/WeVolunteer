import express from 'express';
import { probeWritable as probeDatabaseWritable } from './db/dialectSql.js';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createRedisLimitStore } from './redis/limitStore.js';
import { createVolumeLimitStore } from './redis/volumeLimit.js';
import { shareTokenLimiter } from './organizationLimiters.js';
import cookieParser from 'cookie-parser';
import path from 'path';
import { readFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import {
  DEMO_MODE, IS_PRODUCTION, ALLOWED_ORIGINS, COOKIE_NAME, JWT_SECRET, A11Y_HARNESS
} from './config.js';
import { db } from './db.js';
import { recordError, hashUserId } from './errorReporter.js';
import { logHttpRequest } from './telemetry.js';
import { recordHttpRequest } from './observability/metrics.js';
import { limitHandler } from './rateLimitResponse.js';

import authRoutes from './routes/authRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import issueRoutes from './routes/issueRoutes.js';
import accountRoutes from './routes/accountRoutes.js';
import userRoutes from './routes/userRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import applicationRoutes from './routes/applicationRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import contentRoutes from './routes/contentRoutes.js';
import geocodeRoutes from './routes/geocodeRoutes.js';
import weatherRoutes from './routes/weatherRoutes.js';
import travelRoutes from './routes/travelRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import privacyRoutes from './routes/privacyRoutes.js';
import oauthRoutes from './routes/oauthRoutes.js';
import reauthRoutes from './routes/reauthRoutes.js';
import personaRoutes from './routes/personaRoutes.js';
import errorRoutes from './routes/errorRoutes.js';
import legalRoutes from './routes/legalRoutes.js';
import legalAdminRoutes from './routes/legalAdminRoutes.js';
import impactRoutes from './routes/impactRoutes.js';
import invitationRoutes from './routes/invitationRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import appealsRoutes from './routes/appealsRoutes.js';
// UPLOADS_ROOT alongside the router on purpose: the module that WRITES the
// pictures is the one that decides where they live, and the static mount below
// serves exactly that. See the comment at the mount.
import profilePictureRoutes, { UPLOADS_ROOT } from './routes/profilePictureRoutes.js';
import badgeRoutes from './routes/badgeRoutes.js';
import twoFactorRoutes from './routes/twoFactorRoutes.js';
import directoryRoutes from './routes/directoryRoutes.js';
import organizationRoutes from './routes/organizationRoutes.js';
import externalHoursRoutes from './routes/externalHoursRoutes.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

/**
 * ── Why this is a production requirement and not a nicety ──
 *
 * Every per-IP control on this platform — the login limiter, the mail limiter,
 * the export and re-auth limiters — reads `req.ip`. Behind a reverse proxy with
 * `trust proxy` unset, Express reports the PROXY's address for every request, so
 * all of them collapse into a single bucket: one person fumbling their password
 * ten times locks out everybody, and a real attacker is rate-limited alongside
 * the school they are attacking.
 *
 * `deploy/wevolunteer.env.example` has always called this required. Nothing
 * enforced it, which is the gap between a document and a guarantee. Production
 * now refuses to boot without it, in the same style as the other four blockers.
 */
if (!process.env.TRUST_PROXY && process.env.NODE_ENV === 'production') {
  console.error(
    'FATAL: TRUST_PROXY must be set in production. Without it Express reads the '
    + 'proxy\'s address as the client address, and every per-IP rate limiter '
    + '(sign-in, mail, export, re-auth) shares one bucket for the whole site. '
    + 'Set it to the number of proxies in front of this process — TRUST_PROXY=1 '
    + 'for a single nginx — or to a specific address list.'
  );
  process.exit(1);
}

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
/**
 * A correlation id for every request, and one structured record when it ends.
 *
 * ── Why first ──
 *
 * Before compression, before helmet, before the body parser: a request that is
 * refused by CORS, killed by the body-size limit or rejected as malformed JSON
 * is exactly the one somebody will later be trying to find, and an id assigned
 * after those would not exist on any of them.
 *
 * ── What the id is for ──
 *
 * It is the thread from a browser error to a backend log. `X-Request-Id` goes
 * back on the response, `api.js` puts it on the `ApiError` it throws, the crash
 * reporter sends it with the report, and the error handler stores it on the
 * error row. Searching one id in Better Stack then returns the access record,
 * the error record and — through `fingerprint` — the group in the dashboard.
 *
 * An inbound `X-Request-Id` is DELIBERATELY not honoured. It is client-supplied,
 * unauthenticated and would let anyone poison a shared field or collide with
 * somebody else's trace. A proxy that wants its own id can read this one out of
 * the response.
 *
 * ── Why `res.on('finish')` ──
 *
 * It fires once the response is flushed, which is the only point at which the
 * status code and the duration are both known. `close` would also fire for a
 * client that hung up, and a cancelled request is not a server event worth a
 * record.
 *
 * Nothing here can fail a request: the handler is wrapped, and `logHttpRequest`
 * cannot throw.
 */
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      /* The Express PATTERN, never `req.originalUrl` — a real URL carries a
         query string, and query strings carry search terms and addresses.
         Resolved once and shared, so the log record and the metric cannot
         disagree about which route this was. */
      const route = req.route?.path ?? routePatternOf(req);

      logHttpRequest({
        method: req.method,
        route,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
        requestId: req.id,
        role: req.principal?.effectiveRole ?? req.user?.role,
        userHash: hashUserId(req.user?.id),
      });

      /**
       * The same request, as a metric.
       *
       * Not a duplicate of the line above, and the difference is the point: the
       * log record is SAMPLED (5% of successes, every error), so it cannot
       * answer "what is the p95 right now". This counts every request without
       * exception, at a fixed cost that does not grow with traffic, and carries
       * no identifier of any kind — see `metrics.js` on cardinality.
       *
       * Unconditional: with telemetry off this is a call into a no-op meter.
       */
      recordHttpRequest({
        method: req.method,
        route,
        statusCode: res.statusCode,
        durationMs,
      });
    } catch { /* telemetry must never touch the response */ }
  });

  next();
});

/**
 * The mounted path for a request that never reached a route handler.
 *
 * `req.route` is undefined for a 404, for anything refused by middleware, and
 * for a static file. `req.baseUrl` is the mount point, which is safe (it is
 * declared in code) and answers "was this /api or the SPA" — enough to tell a
 * flood of 404s against the API from a bot crawling the front end.
 */
function routePatternOf(req) {
  if (typeof req.baseUrl === 'string' && req.baseUrl) return req.baseUrl;
  return req.originalUrl?.startsWith('/api') ? '/api/*' : null;
}

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

      /**
       * No 'unsafe-inline'. This is the directive that matters: it is what
       * stops an injected <script> from executing. Stage 3's theme pre-paint
       * script is an external file in public/ specifically to satisfy this.
       *
       * `cdn.amplitude.com` is here because `initAll` loads Amplitude's
       * engagement bundle from it at runtime. It is a third-party script origin
       * and therefore the most consequential line in this block — it is listed
       * only because the SDK cannot function without it, and it stays inert
       * while no API key is configured.
       */
      /**
       * `'wasm-unsafe-eval'` is what lets the on-device AI runtime compile its
       * WebAssembly module. Without it the browser refuses every
       * `WebAssembly.compile`/`instantiate` in the page and local inference
       * cannot start at all — there is no way to ship that feature without this
       * token.
       *
       * It is narrower than it reads. `'wasm-unsafe-eval'` permits compiling
       * WebAssembly and nothing else; it does NOT restore `eval()`, `new
       * Function()`, or inline script. Those remain refused, which is the
       * property this directive block exists to hold. An injected script still
       * cannot execute — and a script that cannot execute cannot reach
       * WebAssembly either.
       *
       * Unconditional rather than gated on a server flag, following the same
       * reasoning as the Amplitude host below: this widens what the page MAY do
       * and switches nothing on. Local AI is a build-time client flag
       * (VITE_LOCAL_AI), and the server cannot see it. Gating this on a second,
       * server-side flag would mean two settings that must agree, and the
       * failure when they disagree is the worst kind — the feature ships, the
       * page renders, and every model load is refused by the browser with an
       * error that names WebAssembly rather than the misconfiguration.
       */
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'https://cdn.amplitude.com'],

      /**
       * Session Replay compresses in a worker created from a blob.
       * `workerSrc` falls back to `scriptSrc` and then `defaultSrc`, neither of
       * which allows `blob:` — so without this the recorder is refused with an
       * error that names the worker rather than Amplitude.
       */
      workerSrc: ["'self'", 'blob:'],

      /**
       * The client previously used 576 inline `style={{}}` blocks, but they have been
       * refactored. The few remaining dynamic styles use element.style which is CSP safe.
       */
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],

      // index.css:1 imports Bricolage Grotesque and Public Sans.
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],

      // data: covers the inline SVG favicon and any base64 image.
      imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://*.basemaps.cartocdn.com'],

      /**
       * The API is same-origin in both topologies: production serves the SPA
       * and the API from this process, and development proxies /api through
       * Vite.
       *
       * The Amplitude hosts are the exception, and they are listed because the
       * alternative is worse than listing them: without these the SDK fails
       * silently in production — the page renders, nothing errors visibly, and
       * every event is refused by the browser. That is a integration that looks
       * installed and measures nothing.
       *
       * These four are the hosts actually observed in a running session:
       * ingestion, the CDN bundle, the Session Replay config, and the
       * general-settings endpoint. Named individually rather than as a wildcard
       * on `amplitude.com`, so a future Amplitude product cannot start talking
       * to a new subdomain without somebody adding it here on purpose.
       *
       * This widens what the page MAY reach; it does not switch anything on.
       * Analytics stays inert unless VITE_AMPLITUDE_API_KEY is set at build
       * time, and .env.example ships it empty.
       */
      connectSrc: [
        "'self'",
        'https://*.tile.openstreetmap.org',
        'https://*.basemaps.cartocdn.com',
        'https://api2.amplitude.com',
        'https://sr-client-cfg.amplitude.com',
        'https://gs.amplitude.com',
        'https://cdn.amplitude.com',

        /**
         * Where the on-device AI models are downloaded from.
         *
         * `huggingface.co` serves two things: the metadata API, which is where
         * the expected byte length and SHA-256 of every model file come from,
         * and the `/resolve/` URL that 302s to the CDN.
         *
         * ── The wildcard, and why it is not the pattern above ──
         *
         * The Amplitude hosts are named individually precisely so a new
         * subdomain cannot be reached without somebody adding it on purpose,
         * and the same instinct applies here. It does not survive contact with
         * how Hugging Face actually serves files. Measured on 2026-08-15, a
         * `/resolve/` request redirects to `us.aws.cdn.hf.co` — a
         * region-and-provider-specific host, and Hugging Face's own
         * documentation warns these hostnames may change without notice.
         *
         * Pinning the one observed host would mean a student routed to a
         * different region gets a refused request instead of a model, with no
         * error anybody would connect to this file. So the wildcard is scoped
         * to the `cdn.` label rather than to `hf.co`: it covers the regional
         * variants of the content-delivery subtree and nothing else. A future
         * Hugging Face *product* on some other `hf.co` subdomain is still
         * refused, which is the property the Amplitude comment is protecting.
         *
         * ── If this ever needs to go away ──
         *
         * Self-hosting the weights removes both lines and returns connect-src
         * to same-origin. Client-side that is one constant, `MODEL_BASE_URL` in
         * `src/ai/models.js`; nothing else knows where the files come from.
         *
         * As with Amplitude, this widens what the page MAY reach and switches
         * nothing on. Nothing is fetched unless VITE_LOCAL_AI is set at build
         * time AND somebody chooses a model.
         */
        'https://huggingface.co',
        'https://*.cdn.hf.co',
      ],

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

/**
 * The Resend webhook needs the bytes as received, so it is mounted BEFORE the
 * global JSON parser for exactly the reason the error-report cap above is.
 *
 * Its signature is an HMAC over the exact request body. A parsed-then-
 * re-serialised object has different key order and whitespace, so verifying
 * against `JSON.stringify(req.body)` fails for every legitimate request and
 * passes for none — a failure that looks indistinguishable from a wrong secret.
 *
 * 64 kB: a delivery event is a few hundred bytes, and this is an
 * unauthenticated endpoint.
 */
app.use('/api/webhooks/resend', express.raw({ type: '*/*', limit: '64kb' }));

app.use(express.json({ limit: '100kb' }));

// Populates req.cookies for authenticateToken. Mounted before the routers and
// before the rate limiters so every downstream handler sees the same shape.
app.use(cookieParser());

/**
 * Which limiters keep a SHARED counter, and which stay in process memory.
 *
 * Five of them below carry `store: createRedisLimitStore(...)` — the mail
 * pair, re-authentication, appeals and certificate verification — together with
 * the login-failure counter in authRoutes.js, which is not middleware. What
 * they gain is that a restart no longer clears them: today a deploy in the
 * middle of a password spray hands the attempt a fresh budget. They are also
 * the ones a second application instance would silently double, which is why
 * `docs/plans/supabase-vercel-migration-plan.md` §4.4 names shared-store rate
 * limiting as the first prerequisite for one.
 *
 * ── Why the three sign-in limiters are NOT among them ──
 *
 * `authLimiter`, `loginLimiter` and `loginIpCeilingLimiter` were the obvious
 * candidates and were measured out again. Two things make them the most
 * expensive limiters here rather than the most valuable. They sit on the
 * highest-volume authentication paths — `/api/auth/login`, `/api/oauth`,
 * signup, reset — and every one of them sets `skipSuccessfulRequests`, which
 * costs an INCREMENT on every request and a DECREMENT on every success, so the
 * common case (somebody signing in correctly) is the expensive one.
 *
 * Modelled at the traffic in docs/operations/upstash.md §7.3, sharing those
 * three costs about 536 commands per user per month against the free plan's
 * 500,000 — which is 107% of the monthly allowance at a thousand users, before
 * anything else spends a command. Leaving them in memory brings the whole
 * integration to about 98.
 *
 * What is given up is small and is bounded, because the control that actually
 * limits password guessing against an account IS shared: `loginFailures` in
 * authRoutes.js caps ten failures per account across every device, survives a
 * restart, and is keyed on the resolved account rather than on what was typed.
 * These three are the per-device layer over it, and per-device is the layer a
 * single-instance deployment already enforces correctly.
 *
 * The rest — `apiLimiter`, `lookupLimiter`, `errorReportLimiter`,
 * `appealReadLimiter`, and the per-route limiters in geocode, weather, travel,
 * legal, issues and exports — stay in memory for the same reason at a larger
 * scale. `apiLimiter` alone allows 600 requests per fifteen minutes per device,
 * so metering it would spend the monthly allowance in an afternoon and then
 * fail open for everything else.
 *
 * When Redis is unconfigured or unreachable, the store falls back to an
 * in-process counter it has been incrementing all along, so the behaviour is
 * exactly what it is today rather than a reset. See `redis/limitStore.js`.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: limitHandler('Too many sign-in attempts from this device.'),
});

/**
 * Account creation, counted — every request, not only the ones that fail.
 *
 * ── The hole this closes ──
 *
 * `/api/auth/signup` was mounted on `authLimiter`, and `authLimiter` carries
 * `skipSuccessfulRequests: true`. A successful signup answers 201, so it was
 * never counted, and the only ceiling on creating accounts was `apiLimiter` at
 * 600 per 15 minutes — roughly 2,400 accounts an hour from one address, each a
 * bcrypt hash, a user row, and a verification email to an address the CALLER
 * chose.
 *
 * That last part is the amplification worth naming: signup mails whatever
 * address it is handed, so an uncounted signup endpoint is also a mail relay
 * aimed at whoever the caller names, spending this platform's sending
 * reputation.
 *
 * This is the same defect, in the same shape, that `mailLimiter` below exists to
 * fix. Its own comment records forgot-password as "a route that always returns
 * 200, so skipSuccessfulRequests made it effectively unlimited". Signup was left
 * on the limiter that has that flag, and it is the one endpoint where the
 * mistake also writes rows.
 *
 * ── And the opposite failure, on the same line ──
 *
 * `authLimiter` allows ten FAILURES per address. A school egresses from one
 * public address and a signup form fails for ordinary reasons — password too
 * short, username taken, email mistyped. So the eleventh student in a building
 * to fumble the form was refused for the rest of the window. That is the exact
 * shared-address problem `loginIpCeilingLimiter` and `mailLimiter` were built to
 * remove, still sitting on the one form every account passes through once.
 *
 * So this route leaves `authLimiter` entirely rather than being tightened. It
 * needs a limiter that counts everything and a ceiling a campus will not meet,
 * which are opposite changes to the two halves of what it had.
 *
 * ── Choosing 300, and being honest about what it does ──
 *
 * A two-thousand-student building rolling out over a morning is on the order of
 * a few hundred signups per quarter hour; `loginIpCeilingLimiter` reasons the
 * same way and lands on 200 for failures alone. 300 clears a campus and still
 * cuts the uncounted 2,400/hour by half.
 *
 * But the IP figure is the least important part of this, and pretending
 * otherwise would be the wrong record to leave. On a shared address no per-IP
 * number can separate an attacker from a campus; this is a volume brake. What
 * bounds abuse per identity is `mailLimiter`, which caps requests naming the
 * same address and costs a campus nothing because a campus does not sign the
 * same address up twice, and email verification, which leaves an unverified
 * account inert.
 */
export const signupLimiter = rateLimit({
  store: createRedisLimitStore({ name: 'signup' }),
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.SIGNUP_RATE_LIMIT) || (DEMO_MODE ? 10000 : 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many accounts have been created from this network recently.'),
});

/**
 * The sign-in limiter, keyed on the DEVICE **and the account being tried**.
 *
 * ── The lockout this replaces ──
 *
 * `authLimiter` above is keyed on the device address alone at ten failures per
 * fifteen minutes. A school leaves through one public address, so those ten were
 * shared by the whole building: ten different students each mistyping their
 * password once exhausted the budget, and the eleventh student — typing the
 * CORRECT password — was refused with 429 for the rest of the window. Measured
 * exactly that way, with production limits, before this existed. On signup day
 * that is not an edge case, it is the morning.
 *
 * ── Why the key gains the identifier ──
 *
 * The thing being protected is an account, so the budget belongs to the pair.
 * One student's typos can no longer spend another student's allowance, while a
 * single account still tolerates only ten failures from a given device — and
 * `loginFailures` in authRoutes.js independently caps that same account at ten
 * failures across ALL devices, which is what actually bounds brute force.
 *
 * The identifier is normalised and hashed. Normalised because `Leo@x.com` and
 * `leo@x.com` are one account and two spellings must not buy two budgets — the
 * same reasoning as `throttleKey`. Hashed because a limiter key lives in memory
 * and can surface in diagnostics, and these keys would otherwise be a list of
 * who tried to sign in.
 *
 * ── What still stops spraying ──
 *
 * Nothing here, deliberately: per-pair keying is blind to one device working
 * through a thousand accounts one attempt each, which is the shape `authLimiter`
 * caught by accident. `loginIpCeilingLimiter` below is the replacement, and it
 * is the reason this change is not a net loss of protection.
 *
 * Requests with no identifier (a malformed body) fall back to the address alone,
 * so a caller cannot buy an unlimited budget by omitting the field.
 */
function loginKeyGenerator(req, res) {
  const raw = req.body?.email;
  const identifier = typeof raw === 'string' && raw.trim()
    ? createHash('sha256').update(raw.trim().toLowerCase()).digest('hex').slice(0, 32)
    : null;
  const ip = ipKeyGenerator(req, res);
  return identifier ? `login:${ip}:${identifier}` : `login:${ip}`;
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT) || (DEMO_MODE ? 1000 : 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: loginKeyGenerator,
  handler: limitHandler('Too many sign-in attempts for that account from this device.'),
});

/**
 * The per-address ceiling underneath the per-account limiter above.
 *
 * This is the anti-spray bound, and it is the whole reason keying the limiter on
 * the account pair is safe. One device may accumulate this many FAILED sign-ins
 * across however many accounts it likes, and then it is done for the window.
 *
 * ── Choosing the number ──
 *
 * It has to sit above what a school generates and below what an attacker needs.
 * A two-thousand-student building on signup morning, at a few percent mistyping
 * once, is on the order of a hundred failures per quarter hour; a password spray
 * worth running wants thousands. 200 clears the former with room and still costs
 * an attacker fifteen minutes per two hundred guesses from each address they
 * control — against accounts that `loginFailures` independently caps at ten
 * failures each, so the spray cannot come back to the same account tomorrow and
 * continue.
 *
 * Generous rather than tight on purpose, for the reason recorded on
 * `mailIpCeilingLimiter`: it must never be the thing a legitimate campus hits,
 * only the thing an address-rotating attack hits. `LOGIN_IP_CEILING` overrides
 * it for a deployment that knows its own population.
 *
 * Successes are skipped here too. A building signing in all morning is not an
 * attack, and counting successes would reintroduce the lockout by another route.
 */
export const loginIpCeilingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_IP_CEILING) || (DEMO_MODE ? 10000 : 200),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: limitHandler('Too many failed sign-in attempts from this network.'),
});

/**
 * The blanket API limiter's key: the SESSION when there is one, the address
 * otherwise.
 *
 * ── The lockout this replaces ──
 *
 * `apiLimiter` covers every `/api` request and had no key generator, so
 * `express-rate-limit` keyed it on `req.ip`: 600 requests per fifteen minutes
 * for a whole school's shared egress address. A signed-in session makes several
 * requests per screen, so a few dozen students browsing at lunchtime exhausted
 * the building's budget and the next person to open the app got a 429 on a
 * request that was neither abusive nor theirs to pay for.
 *
 * This is the same failure, on the broadest limiter in the application, that was
 * already found and fixed twice: `loginLimiter` was re-keyed onto `ip + account`
 * after ten students mistyping once locked out a building, and `mailLimiter`
 * onto the target address after a campus shared five verification emails.
 * `apiLimiter` was the one left on a bare address.
 *
 * ── Why this loosens nothing ──
 *
 * The per-bucket number is unchanged. An anonymous caller is still bounded by
 * address at exactly the same rate; one account is still bounded at exactly the
 * same rate. The only behaviour that changes is that one person's browsing no
 * longer spends another person's allowance. Nothing gains budget; a building
 * stops losing it.
 *
 * ── Why the token is VERIFIED and not merely read ──
 *
 * Keying on an unverified cookie would let an attacker mint a fresh value per
 * request and never share a bucket with themselves — an unlimited budget, which
 * is worse than the defect being fixed. So the signature is checked, and
 * anything that fails falls back to the address. That costs one HMAC on a path
 * that is about to do considerably more work than that, and it is the same
 * verification `authenticateToken` performs a few middlewares later.
 *
 * The subject is hashed for the reason `loginKeyGenerator` gives: a limiter key
 * lives in memory and can surface in diagnostics, and these keys would otherwise
 * be a list of who was using the application.
 *
 * A preauth token is deliberately NOT treated as a session. It is issued
 * mid-sign-in, before the second factor, and `authenticateToken` refuses it as a
 * full session; letting it name a bucket here would give the half-authenticated
 * state an identity the rest of the application does not grant it.
 */
function apiLimiterKey(req, res) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload?.id && !payload.preauth) {
        return `api:u:${createHash('sha256').update(String(payload.id)).digest('hex').slice(0, 32)}`;
      }
    } catch {
      /* Expired, forged, or signed with a rotated secret. Treated as anonymous,
         which is both correct and the safe direction: it keys on the address. */
    }
  }
  return `api:ip:${ipKeyGenerator(req, res)}`;
}

/**
 * In-process, and it must stay there — the one limiter deliberately left off
 * the shared Redis store the five below use.
 *
 * At 600 requests per fifteen minutes per bucket this is by a wide margin the
 * highest-volume limiter in the application, and metering it through Upstash
 * would cost more of the monthly allowance than every other limiter combined —
 * the arithmetic is in `docs/operations/upstash.md` §7.3. It is a volume
 * control, not a credential control, and the credential controls (`loginFailures`
 * in authRoutes.js, `mailLimiter`) are the ones that are shared.
 *
 * ── What keying it per session does to that arithmetic ──
 *
 * `apiLimiterKey` above buckets a signed-in caller by session rather than by
 * address, so the number of live buckets now tracks concurrent USERS rather
 * than egress addresses — more buckets, each smaller. That makes a shared store
 * more expensive, not less, so the decision to keep this one in memory is
 * strengthened by the re-key rather than reopened by it.
 *
 * The cost of staying in memory is bounded and known: a restart clears the
 * counters, and a second instance would meter independently. For a volume
 * brake, both are acceptable — and `docs/operations/horizontal-scaling.md`
 * records it as such rather than as a solved problem.
 */
const API_LIMIT = Number(process.env.API_RATE_LIMIT) || (DEMO_MODE ? 10000 : 600);

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  /**
   * Shared, but not metered per request — see `redis/volumeLimit.js`.
   *
   * This limiter sits on every `/api` call, so metering each one exactly would
   * cost about 6,600 Redis commands per user per month against a free plan that
   * allows 500 per user at a thousand users. Instead the count is exact
   * locally, and is reconciled through Redis only once a caller passes a
   * quarter of the ceiling — which almost nobody ever does, so almost nobody
   * ever costs a command.
   */
  store: createVolumeLimitStore({ name: 'api', limit: API_LIMIT }),
  /* `API_RATE_LIMIT` follows the convention the four limiters above already use
     (`LOGIN_RATE_LIMIT`, `LOGIN_IP_CEILING`, `MAIL_RATE_LIMIT`,
     `REAUTH_RATE_LIMIT`): a deployment that knows its own population can say so,
     and `bin/load-test.mjs` can hold the production number while it measures. */
  limit: API_LIMIT,
  keyGenerator: apiLimiterKey,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  /**
   * The Resend delivery webhook is exempt, and it is the only exemption.
   *
   * Every delivery event arrives from Resend's own addresses, so all of them
   * share ONE bucket — and a single send produces up to three events (sent,
   * delivered, and possibly bounced). Signup day at a school is a few hundred
   * verification emails inside a few minutes, which is comfortably past 600 in
   * fifteen. The 429s would not lose the events (Resend retries) but they would
   * delay them and fill the log with a failure that is not one.
   *
   * Exempting it is safe because it is not an unauthenticated endpoint in the
   * way the limiter cares about: the signature is checked before anything is
   * parsed or written, and an unsigned request costs one HMAC and a 401. There
   * is nothing to flood.
   */
  /**
   * The accessibility harness is the second exemption, and the only other one.
   *
   * `A11Y_HARNESS` is false unless `WEV_A11Y_HARNESS=1` is set AND this is not
   * production, and `server.js` refuses to boot on the combination — see the
   * constant's own comment in `config.js` for the measurement that motivated it
   * and for why the ceiling was not simply raised. Nothing else is exempted:
   * every credential limiter still counts the harness.
   */
  skip: (req) => req.path === '/webhooks/resend' || A11Y_HARNESS,
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
  store: createRedisLimitStore({ name: 'mail' }),
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
  store: createRedisLimitStore({ name: 'mail-ip' }),
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
  store: createRedisLimitStore({ name: 'cert-verify' }),
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
  store: createRedisLimitStore({ name: 'reauth' }),
  limit: Number(process.env.REAUTH_RATE_LIMIT) || (DEMO_MODE ? 1000 : 5),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: limitHandler('Too many verification attempts.'),
});

export const appealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  store: createRedisLimitStore({ name: 'appeal' }),
  limit: DEMO_MODE ? 1000 : 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('We have received your recent attempts. Please give our team time to review your case.'),
});

/**
 * Reading an appeal form, as opposed to filing one.
 *
 * Deliberately generous, and separate from `appealLimiter`, because the person
 * hitting it is locked out of their account and this page is the only thing they
 * can reach. Re-reading it — to check the deadline, to re-read the reason, to
 * show a parent — must never cost them the ability to file. Still bounded,
 * because the route is unauthenticated and answers about a real account.
 */
/* In-process: this counts every READ of the appeal page, including the
   re-reads it is deliberately generous about, so it is a volume control rather
   than a guessing control. `appealLimiter`, which bounds actually filing, is
   the one that carries a shared counter. */
export const appealReadLimiter = rateLimit({
  store: createRedisLimitStore({ name: 'appeal-read' }),
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 1000 : 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many requests. Please wait a moment and reload the page.'),
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
/* In-process: a broken build makes every client report at once, which is
   precisely when spending the monthly Redis allowance would be worst. The
   500-group storage ceiling in errorReporter.js is the bound that matters here,
   and it is already durable. */
export const errorReportLimiter = rateLimit({
  store: createRedisLimitStore({ name: 'error-report' }),
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.ERROR_REPORT_RATE_LIMIT) || (DEMO_MODE ? 1000 : 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many error reports from this device.'),
});

/* In-process: a signup form probes availability as somebody types, so this
   counts successes at keystroke volume. Sharing it would cost roughly as much
   allowance as every failure-counting limiter above put together, to harden a
   control whose real protection is that it answers slowly and generically. */
export const lookupLimiter = rateLimit({
  store: createRedisLimitStore({ name: 'lookup' }),
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 5000 : 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many lookups from this device.'),
});

app.use('/api/auth/login', loginIpCeilingLimiter, loginLimiter);
/**
 * The second factor, limited SEPARATELY — `/api/auth/login` does not cover it.
 *
 * `app.use('/api/auth/login', …)` matches at path-segment boundaries, so it
 * applies to `/api/auth/login` and `/api/auth/login/x` and NOT to
 * `/api/auth/login-2fa`, which is a sibling rather than a child. The two
 * endpoints that actually verify the second factor were therefore carrying
 * nothing but the blanket `apiLimiter` — 600 requests per fifteen minutes per
 * device — while the password step they follow carried ten.
 *
 * The in-handler counters in authRoutes.js (five per preauth token, twenty per
 * account per rolling fifteen minutes) are what genuinely bound guessing, and
 * they still are. This is the network-level floor underneath them: the account
 * counters are per account, so without it a single device could work through
 * many accounts at API volume, and each account's counter would look calm.
 *
 * Listed as two explicit mounts rather than a `/api/auth/login-2fa` prefix plus
 * a hope, because the prefix behaviour above is exactly what went wrong here.
 */
app.use('/api/auth/login-2fa', loginIpCeilingLimiter, loginLimiter);
/**
 * Sending an emailed code is a MAIL endpoint, and authLimiter above does not
 * bound it: `skipSuccessfulRequests` means a successful send costs nothing, and
 * a successful send is exactly the request being abused. The handler's own
 * sixty-second cooldown is per account, so it caps one mailbox at fifteen
 * messages per quarter hour and says nothing about how many mailboxes one
 * device may work through. The per-IP ceiling counts every request and is what
 * makes this endpoint cost something in aggregate.
 */
app.use('/api/auth/login-2fa/email/send', mailIpCeilingLimiter);
/**
 * Per-address first, then the network ceiling. `authLimiter` is deliberately
 * absent — see `signupLimiter` for why its two halves were both wrong here.
 */
app.use('/api/auth/signup', mailLimiter, signupLimiter);
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
/**
 * The other unauthenticated reads of real data.
 *
 * Mounted here, ahead of the blanket `apiLimiter`, for the same reason
 * `/api/certificates/verify` is: they answer without a session, so nothing else
 * stands between them and being used as a free database probe.
 * `shareTokenLimiter` counts successes deliberately — see its own note for why,
 * and for why its message must never read as a verdict on the link.
 *
 * ── The prefix covers BOTH public organization endpoints, on purpose ──
 *
 * This used to be `/api/public/organizations/invite`, which left
 * `/api/public/organizations/:handle` — the canonical public page — behind
 * `apiLimiter` alone. That is the wrong way round if either needs more
 * protection: an invitation token is 32 random bytes and unguessable, while a
 * handle is the club's NAME and guessable by design, so the handle route is the
 * one an enumeration would actually target.
 *
 * One budget for both is right rather than convenient. The shape of legitimate
 * traffic is identical — a club puts an address somewhere and a class of thirty
 * opens it from one school connection — and the ceiling is what bounds a
 * scraper. 120 per 15 minutes per device is roughly eight a minute: useless for
 * walking a namespace, invisible to anybody reading a page.
 *
 * The AUTHENTICATED routes that consume a token carry a different limiter inside
 * the router, keyed on the account, because a device-keyed one there would
 * refuse the students at the back of that same class.
 */
app.use('/api/public/organizations', shareTokenLimiter);
app.use('/api', apiLimiter);

app.use(webhookRoutes);
app.use(issueRoutes);
app.use(authRoutes);
app.use(accountRoutes);
app.use(userRoutes);
/* The v1.3 member directory. Mounted after userRoutes so that its
   `/api/users/by-username/:username` and `/api/users/:id/public-profile` paths
   sit alongside the existing `/api/users/:id/profile` rather than shadowing it. */
app.use(directoryRoutes);
app.use(organizationRoutes);
app.use(externalHoursRoutes);
app.use(oauthRoutes);
app.use(reauthRoutes);
app.use(personaRoutes);
app.use(eventRoutes);
app.use(applicationRoutes);
app.use(attendanceRoutes);
app.use(adminRoutes);
app.use(contentRoutes);
app.use(geocodeRoutes);
app.use(weatherRoutes);
app.use(travelRoutes);
app.use(messageRoutes);
app.use(privacyRoutes);
app.use(errorRoutes);
app.use(legalRoutes);
/* The owner-only editor. Its paths are `/api/admin/legal/...`, which cannot
   collide with `legalRoutes`' `/api/legal/...`, so the order of these two is
   free — they are adjacent because they are the same subject. */
app.use(legalAdminRoutes);
app.use(impactRoutes);
app.use(invitationRoutes);
app.use(reportRoutes);
app.use(profilePictureRoutes);
app.use(badgeRoutes);
app.use(twoFactorRoutes);
/**
 * Reading the appeal form must not spend the budget for filing it.
 *
 * This was `app.use('/api/appeals/token', appealLimiter, mailIpCeilingLimiter)`,
 * which applies to every method. `appealLimiter` is 5 per 15 minutes keyed on IP
 * with successes counted — so a suspended student who opened the link, reloaded
 * after a typo and came back later had spent their entire filing allowance on
 * page views. On a school NAT, where the whole district shares one address, five
 * page loads locked out everybody. Worse, `mailIpCeilingLimiter` is shared with
 * forgot-password and resend-verification, so appeal *reads* could exhaust the
 * campus's password resets.
 *
 * Split by method: reads get a generous limiter of their own and never touch the
 * mail ceiling (a read sends no mail); writes keep the strict pair.
 */
app.get('/api/appeals/token/:token', appealReadLimiter);
app.post('/api/appeals/token/:token', appealLimiter, mailIpCeilingLimiter);
// The authenticated sibling had no limiter at all, so one signed-in account
// could bury the queue that a genuinely suspended student is waiting in.
app.post('/api/appeals', appealLimiter);
app.use(appealsRoutes);


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
async function probeWritable() {
  const now = Date.now();
  if (writeProbeCache.ok !== null && now - writeProbeCache.at < WRITE_PROBE_INTERVAL_MS) {
    return writeProbeCache.ok;
  }

  /* The probe itself lives in `db/dialectSql.js`: PostgreSQL has no pragmas, and
     its equivalent trick — allocating a transaction id — is different enough to
     want the reasoning written down beside the SQLite one rather than branched
     inline here. The caching and the /health wiring stay. */
  let ok = false;
  try {
    ok = await probeDatabaseWritable(db);
  } catch {
    ok = false;
  }

  writeProbeCache = { at: now, ok };
  return ok;
}

// Health check is registered BEFORE the production SPA catch-all below, so it
// always returns its JSON — a load balancer must never receive index.html here.
/**
 * Connection-pool saturation, for a load run and for an operator who asks.
 *
 * ── Why it is behind a flag, and off by default ──
 *
 * `/health` is UNAUTHENTICATED, and this file already refuses to put detail on
 * it — the 503 branches deliberately return no error text so the endpoint cannot
 * become a filesystem oracle by echoing a path out of a SQLite message. Pool
 * counts are not user data, but they do publish how much concurrent traffic the
 * deployment is carrying, and that is not something an uptime monitor needs.
 *
 * ── Why it exists at all ──
 *
 * `waiting` is the number that matters and the only one nothing else reports.
 * The pool is deliberately small (ten — see `db/engine.js` for the argument),
 * so the failure mode under load is not an error, it is requests queueing for a
 * client. That looks exactly like "the database got slower" from the outside,
 * and `bin/load-test.mjs` cannot tell the two apart without this.
 *
 * Absent on SQLite, which has no pool, rather than reported as zeroes — a zero
 * would read as "measured, and fine".
 */
function poolStats() {
  if (process.env.HEALTH_POOL_STATS !== 'true') return {};
  const stats = db.stats;
  return stats ? { pool: stats } : {};
}

app.get('/health', async (req, res) => {
  let readable = false;
  try {
    await db.prepare('SELECT 1').get();
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

  const writable = await probeWritable();
  if (!writable) {
    return res.status(503).json({
      status: 'error',
      database: 'read-only',
      writable: false,
      version: VERSION
    });
  }

  res.json({
    status: 'ok', database: 'connected', writable: true, version: VERSION,
    ...poolStats(),
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

/**
 * Profile pictures, in every environment — not only in production.
 *
 * ── The incident ──
 *
 * This mount used to sit inside the `if (IS_PRODUCTION)` block below, next to
 * the built client. Development is where the feature is actually used by hand,
 * and it was the one environment in which nothing served the file: the browser
 * asked Vite (:5173), Vite looked in its own publicDir, did not find the file the
 * API had written under `server/public/`, and answered the SPA shell — 200 with
 * `content-type: text/html`. The `<img>` was handed HTML, could not decode it,
 * and showed nothing. "I can edit my avatar but it never appears."
 *
 * Two things are load-bearing here:
 *
 *   1. `UPLOADS_ROOT` is IMPORTED from the module that writes the files rather
 *      than re-derived. Both sides used to compute `path.join(process.cwd(),
 *      'public', 'uploads')`, which is `server/public/uploads` under the npm
 *      workspace scripts and `public/uploads` under vitest — so the two agreed
 *      in the test suite and only in the test suite. One constant, one place.
 *   2. It is registered unconditionally, and ABOVE the SPA fallback, so a
 *      request for a picture is answered by this middleware or by the 404 below
 *      it — never by index.html. A miss that arrives as 200 text/html is
 *      indistinguishable from success to everything except an image decoder.
 *
 * The bytes are user-supplied, so: no directory listings, no dotfiles, and
 * `immutable` is safe because the filename carries `Date.now()` — replacing a
 * picture mints a new URL, so the bytes behind a given one never change.
 */
app.use('/uploads', express.static(UPLOADS_ROOT, {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// Deliberately terminal: see (2) above. A picture that is gone is a 404, which
// is a thing the client can recognise and fall back from.
app.use('/uploads', (req, res) => {
  res.status(404).json({ error: 'Not found' });
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

/**
 * Route a rejected async handler into the error middleware below, instead of
 * letting it kill the process.
 *
 * ── The outage this prevents ──
 *
 * Express 4 does not understand promises. An `async (req, res)` handler that
 * throws returns a rejected promise which Express drops on the floor; Node
 * raises `unhandledRejection`; `shutdown.js` treats that as fatal and drains.
 * So ONE failing request took the entire server down for every user.
 *
 * Found by the production boot rehearsal on 2026-08-18, not by the suite. A
 * single `GET /api/organizations` — one unquoted alias in an ORDER BY, wrong
 * only on PostgreSQL — logged `column "membercount" does not exist` and the
 * process exited three requests into the session.
 *
 * 51 of the 206 async route handlers have no try/catch of their own, so this was
 * not one unlucky route. On SQLite most of them never throw, which is why it was
 * invisible: PostgreSQL turns every dialect difference, constraint violation and
 * transient pool error into exactly this.
 *
 * ── Why here, and not 51 try/catch blocks ──
 *
 * A wrapper at each site is 51 chances to forget the 52nd. This walks the router
 * stack once, after everything is mounted and before the error handler is
 * registered, and wraps each handler so a rejection becomes `next(err)`. The
 * error middleware below then answers the request the way it already answers
 * every other failure.
 *
 * Handlers of arity 4 are error middleware and are left alone — wrapping one
 * would change how Express classifies it. Layers are marked so a second pass
 * cannot double-wrap. `unhandledRejection` stays fatal in shutdown.js: it is
 * still the right response to a rejection from somewhere that is NOT a request,
 * and this narrows what reaches it rather than muting it.
 */
export function routeAsyncErrorsToExpress(stack) {
  for (const layer of stack ?? []) {
    if (layer.route?.stack) routeAsyncErrorsToExpress(layer.route.stack);

    const fn = layer.handle;
    if (typeof fn !== 'function' || fn.length >= 4 || fn.__asyncErrorsRouted) continue;

    /**
     * A mounted sub-router is descended into, never wrapped.
     *
     * `app.use(someRouter)` makes a layer whose `handle` IS the router function,
     * and that function carries the `.stack` of everything inside it. Replacing
     * it with a wrapper drops the `.stack`, and anything walking the tree stops
     * dead at the mount point — which is not hypothetical: it broke
     * `routes.resetRemoved` (which descends via `layer.handle.stack` to prove no
     * reset route is reachable) and `authz.completeness` (which enumerates every
     * mounted route to prove each one is gated). Two authorization-adjacent
     * guards went blind, and both said so.
     *
     * There is nothing to gain by wrapping one either: a router does not reject,
     * the handlers inside it do, and those are reached by the recursion.
     */
    if (Array.isArray(fn.stack)) {
      routeAsyncErrorsToExpress(fn.stack);
      continue;
    }

    const wrapped = function asyncErrorBoundary(req, res, next) {
      let result;
      try {
        result = fn.call(this, req, res, next);
      } catch (err) {
        next(err);
        return undefined;
      }
      /* Returns the HANDLED chain, not the original promise. Express ignores the
         return value, but anything that does await it — a test, a future
         wrapper — would otherwise see the same rejection a second time and
         resurrect the unhandled rejection this exists to prevent. */
      if (result && typeof result.then === 'function') return result.then(undefined, next);
      return result;
    };
    wrapped.__asyncErrorsRouted = true;
    layer.handle = wrapped;
  }
}

routeAsyncErrorsToExpress(app._router?.stack);

// Error handler registered LAST, so it catches errors from every layer above,
// including the static/SPA block.
app.use(async (err, req, res, _next) => {
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
   *
   * The limit is read from the error rather than written into the sentence,
   * because it is NOT one number. `/api/errors/report` is mounted with its own
   * 8 kB parser, and a 9 kB report to that path was refused — correctly — while
   * being told "the limit is 100kb", which is the one piece of advice guaranteed
   * not to work. body-parser puts the limit it actually applied on `err.limit`.
   */
  if (err.type === 'entity.too.large') {
    const kb = Number.isFinite(err.limit) ? Math.round(err.limit / 1024) : null;
    return res.status(413).json({
      error: kb
        ? `That request was too large. The limit is ${kb}kb.`
        : 'That request was too large.',
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
  await recordError(db, {
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
    /* `requestId` joins this row to the access record and to whatever the
       browser reported, which is the whole point of the id. It is a UUID this
       server generated; see the note on CONTEXT_KEYS. */
    context: { statusCode: 500, method: req.method, requestId: req.id }
  });
});
