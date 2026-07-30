import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { DEMO_MODE, IS_PRODUCTION, ALLOWED_ORIGINS } from './config.js';
import { db } from './db.js';

import authRoutes from './routes/authRoutes.js';
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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

if (process.env.TRUST_PROXY) {
  const value = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(value) ? process.env.TRUST_PROXY : value);
}

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

// Endpoints that send an email must count EVERY request, not just failures:
// forgot-password always returns 200 (so it cannot leak whether an address
// exists), which means authLimiter's skipSuccessfulRequests would never count
// it and it would have no effective limit at all. This limiter guards against
// using either endpoint to flood someone's inbox.
export const mailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.MAIL_RATE_LIMIT) || (DEMO_MODE ? 1000 : 5),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many email requests from this device.'),
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
export const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 5000 : 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many lookups from this device.'),
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/forgot-password', mailLimiter);
app.use('/api/auth/resend-verification', mailLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/verify-email', authLimiter);

/**
 * Endpoints that check a password but are not /login.
 *
 * Each of these was reachable 600 times per window under apiLimiter alone,
 * which made every one of them a better brute-force target than the login form
 * it sat beside:
 *   • /api/oauth/link       — takes an account password with an unauthenticated
 *                             15-minute token, so it is a pure password oracle.
 *   • /api/auth/change-password — takes the current password.
 *   • DELETE /api/auth/account  — takes the password, and succeeds destructively.
 */
app.use('/api/auth/change-password', authLimiter);
app.use('/api/auth/account', authLimiter);

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
app.use(oauthRoutes);
app.use(eventRoutes);
app.use(applicationRoutes);
app.use(attendanceRoutes);
app.use(adminRoutes);
app.use(contentRoutes);
app.use(geocodeRoutes);
app.use(weatherRoutes);
app.use(messageRoutes);
app.use(privacyRoutes);


// Read once at import rather than per request. Derived from package.json so it
// cannot drift from the released version the way a hardcoded literal did — this
// previously reported 2.0.0 against a 1.0.0 release, which is actively
// misleading when you are trying to identify a running build during an incident.
const VERSION = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
).version;

// Health check is registered BEFORE the production SPA catch-all below, so it
// always returns its JSON — a load balancer must never receive index.html here.
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'connected', version: VERSION });
  } catch {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

if (IS_PRODUCTION) {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
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
  console.error('Unhandled error:', err);
  const status = err.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: status === 400 ? 'Invalid JSON' : 'Internal server error' });
});
