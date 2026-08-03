import crypto from 'crypto';
import { CLIENT_ROUTE_PATTERNS, UNKNOWN_ROUTE } from './clientRoutes.js';

/**
 * Error capture: redact, normalise, fingerprint, record — and never throw.
 *
 * ── Boundaries ──
 *
 * Imports `node:crypto` and `clientRoutes.js` (plain data), and nothing else.
 * `db` arrives as an argument on every call, so a test drives this against a
 * throwaway file, the workers and the scheduler can use it outside any request,
 * and there is no cycle with `app.js`. Same reasoning as `server/reauth.js`.
 *
 * ── The property that matters most ──
 *
 * `recordError` NEVER throws. It is called from the Express error handler, and
 * an exception while handling an exception is one Express answers by killing the
 * response — for a throw in an async path, it can take the process down. The
 * whole body is wrapped, and every failure returns a value. Monitoring that can
 * take down the thing it monitors is worse than no monitoring.
 */

export const REDACTED = '[redacted]';

/** Evidence kept per problem. Beyond this the oldest rows are dropped. */
export const MAX_EVENTS_PER_GROUP = 50;

/**
 * Occurrences of one fingerprint per hour above which evidence stops being
 * stored. The counter keeps climbing; only the duplication stops.
 */
export const MAX_EVENTS_PER_HOUR = 100;

/**
 * The ceiling on distinct OPEN groups a client can create.
 *
 * `POST /api/errors/report` is unauthenticated by design, and the fingerprint is
 * computed over a client-supplied message — so the number of distinct client
 * groups is attacker-chosen, and distinct messages are one line of script. The
 * per-group event cap does not help: every forged fingerprint earns its own
 * group and its own fresh allowance of events.
 *
 * 500 is far above honest use (a release with 500 genuinely distinct client bugs
 * has problems a dashboard will not solve) and far below anything that threatens
 * the database.
 */
export const CLIENT_GROUP_CEILING = 500;

/**
 * Where overflow is counted instead of being lost.
 *
 * When the ceiling is reached, new client groups stop being created and this one
 * row's counter climbs. An operator seeing it knows the ceiling was hit and how
 * often, which is the signal worth having; silently dropping the reports would
 * hide both the flood and the fact that reporting had stopped working.
 */
export const OVERFLOW_FINGERPRINT = 'client-overflow';

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_ROUTE_INPUT = 2048;

/**
 * The hard bound on what the redactor is ever asked to scan.
 *
 * Found by testing rather than reasoning: redacting a 100 kB message took ~13
 * SECONDS. The email rule is `[A-Za-z0-9._%+-]+@…`, and against a long run of
 * matching characters with no `@` the engine retries from every start position —
 * quadratic in the input length. Message length is attacker-controlled through
 * the unauthenticated intake, so that is a request that burns the event loop:
 * the reporter becoming the outage it exists to detect.
 *
 * Cutting first bounds the work. It does NOT weaken the "truncate after
 * redacting" rule that keeps a secret near the end of a message from surviving
 * the cut — content beyond this bound is discarded outright, not stored
 * unredacted, so there is nothing left to leak. 8 kB matches the intake's own
 * body cap, and a stack trace does not need more.
 */
const MAX_RAW_INPUT = 8192;

const SOURCES = Object.freeze(['server', 'client', 'worker']);

/**
 * Keys `context` may carry. Everything else is DROPPED, not sanitised.
 *
 * A denylist fails on the first thing nobody thought of; an allowlist fails
 * closed. `password`, `newEmail` and `challengeId` are not listed here and
 * therefore cannot be stored, whatever a caller believes.
 */
const CONTEXT_KEYS = Object.freeze([
  'route', 'method', 'statusCode', 'migrationVersion',
  'jobId', 'eventId', 'slotId', 'component', 'boundary'
]);

/* ── Redaction ─────────────────────────────────────────────────────────── */

/**
 * Rules ordered most-specific-first, so a JWT is recognised as a JWT before its
 * segments are eaten by the generic long-token rule.
 */
const REDACTIONS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email address'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/g, 'JWT'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer token'],
  [/\breauth-[A-Za-z0-9-]{8,}/gi, 'step-up challenge id'],
  [/\b[0-9a-f]{24,}\b/gi, 'long hex run — a token, hash or id'],
  [/\b\d{7,}\b/g, 'long digit run — an id or a phone number'],
];

/**
 * Strips the things that carry a person, then truncates.
 *
 * Truncation is LAST so a secret near the end of a long message is redacted
 * before the cut rather than being preserved by it.
 */
export function redactMessage(message) {
  if (typeof message !== 'string') return '';
  // Bound the scan before it starts — see MAX_RAW_INPUT.
  let out = message.length > MAX_RAW_INPUT ? message.slice(0, MAX_RAW_INPUT) : message;
  for (const [pattern] of REDACTIONS) out = out.replace(pattern, REDACTED);
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

/**
 * Keeps the frames worth reading and strips the ones that name a person.
 *
 * A deploy path can carry a username (`/home/alice/wev/...`) and a developer
 * machine almost always does, so absolute prefixes above the repository are
 * rewritten to a relative form. `node_modules` frames beyond the first are
 * dropped: the first says which dependency, the rest are its internals.
 */
export function redactStack(stack) {
  if (typeof stack !== 'string') return null;
  // Same bound, same reason: a client-supplied stack is attacker-sized.
  const bounded = stack.length > MAX_RAW_INPUT ? stack.slice(0, MAX_RAW_INPUT) : stack;

  let seenNodeModules = false;
  const kept = [];
  for (const line of bounded.split('\n')) {
    const isNodeModules = line.includes('node_modules');
    if (isNodeModules) {
      if (seenNodeModules) continue;
      seenNodeModules = true;
    }
    kept.push(
      line
        .replace(/file:\/\/\/?/g, '')
        // Anything before a repository directory is machine-specific.
        .replace(/(?:\/[^\s:()[\]]+)*\/((?:server|src|bin|node_modules)\/)/g, '$1')
    );
  }

  const out = redactMessage(kept.join('\n'));
  return out.length > MAX_STACK ? `${out.slice(0, MAX_STACK)}…` : out;
}

/* ── Client route normalisation ────────────────────────────────────────── */

const PATTERN_SEGMENTS = CLIENT_ROUTE_PATTERNS.map(p => ({
  pattern: p,
  segments: p.split('/').filter(Boolean),
  // More literal segments = a more specific pattern. `/events/new` must win
  // over a hypothetical `/events/:id` regardless of declaration order.
  literals: p.split('/').filter(s => s && !s.startsWith(':')).length,
}));

/**
 * Turns whatever a client claimed its route was into something safe to store.
 *
 * ── Why this exists ──
 *
 * The rule that `route` is an Express pattern and never a URL covers SERVER
 * errors. A client report has no Express pattern to fall back on: the browser
 * sends the string it thinks it was on, and a SPA route carries exactly what
 * that rule refuses — `/events?q=<a home address>`,
 * `/reset-password?token=<a live token>`, `/verify/<a certificate code>`.
 *
 * ── The order is the security ──
 *
 * 1. Refuse anything that is not a plausible path, by TYPE and SIZE first, so
 *    hostile input never reaches the matcher.
 * 2. DROP the query string and the fragment. Not redact — drop. Nothing in a
 *    query string helps diagnose a crash, and refusing to capture beats
 *    sanitising what was captured (the same reasoning as having no body column).
 * 3. Match against the allowlist and return the PATTERN. The input is never the
 *    output, which is what makes a certificate code or a real user id
 *    unstorable rather than merely unlikely.
 * 4. Anything unmatched is `unknown` — never the raw path, because an unmatched
 *    path is the case most likely to be hostile or to carry an id.
 * 5. Redact the result anyway. Today that is a no-op on a closed set of
 *    patterns; it is the line that still holds if step 3 is ever loosened.
 *
 * Returns `unknown` for every refusal and never throws — this runs on an
 * unauthenticated path, where a thrown error is a denial-of-service lever.
 */
export function normaliseClientRoute(route) {
  try {
    if (typeof route !== 'string') return UNKNOWN_ROUTE;
    if (route.length === 0 || route.length > MAX_ROUTE_INPUT) return UNKNOWN_ROUTE;

    // Drop the fragment, then the query. Fragment first: `?` may appear inside
    // a fragment and would otherwise leave part of it behind.
    let path = route.split('#')[0].split('?')[0];

    if (!path.startsWith('/')) return UNKNOWN_ROUTE;
    // `//evil.com/x` is protocol-relative and is a URL, not a path.
    if (path.startsWith('//')) return UNKNOWN_ROUTE;
    if (path.includes('\\') || path.includes('\0')) return UNKNOWN_ROUTE;

    const segments = path.split('/').filter(Boolean);
    // Traversal never appears in a legitimate SPA route.
    if (segments.some(s => s === '.' || s === '..')) return UNKNOWN_ROUTE;

    if (segments.length === 0) return matchOrUnknown([]);
    return matchOrUnknown(segments);
  } catch {
    // Unreachable by construction; present because this is the one function in
    // the module that hostile input reaches first.
    return UNKNOWN_ROUTE;
  }
}

function matchOrUnknown(segments) {
  let best = null;
  for (const candidate of PATTERN_SEGMENTS) {
    if (candidate.segments.length !== segments.length) continue;
    const matches = candidate.segments.every(
      (seg, i) => seg.startsWith(':') || seg === segments[i]
    );
    if (!matches) continue;
    if (!best || candidate.literals > best.literals) best = candidate;
  }
  if (!best) return UNKNOWN_ROUTE;
  // Step 5: defence in depth. A no-op against the current closed set.
  const redacted = redactMessage(best.pattern);
  return redacted === best.pattern ? best.pattern : UNKNOWN_ROUTE;
}

/**
 * A server or worker route is already a pattern from our own code, but it is
 * still bounded and redacted rather than trusted — a handler that built its
 * route string from user input would otherwise be a way in.
 */
function normaliseServerRoute(route) {
  if (typeof route !== 'string' || route.length === 0) return null;
  if (route.length > MAX_ROUTE_INPUT) return UNKNOWN_ROUTE;
  const redacted = redactMessage(route.split('#')[0].split('?')[0]);
  return redacted.length > 0 ? redacted : null;
}

/* ── Fingerprinting ────────────────────────────────────────────────────── */

/**
 * Collapses the parts of a message that vary between occurrences of the same
 * bug: numbers, quoted strings, and anything redaction already replaced.
 *
 * `Cannot read 'x' of undefined at row 41` and `... at row 9` are one problem,
 * and a dashboard that lists them separately is a list nobody reads.
 */
function normaliseForFingerprint(message) {
  return String(message ?? '')
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Stable identity for one problem.
 *
 * Computed AFTER redaction and normalisation, deliberately: a fingerprint built
 * from the raw message would be a hash of personal data, stored in a primary key
 * and shown on a dashboard. Hashing does not make an email address stop being
 * one, and it would be the single field on the row nobody thought to redact.
 */
export function fingerprint({ source, kind, message, route }) {
  const basis = [
    String(source ?? ''),
    String(kind ?? ''),
    normaliseForFingerprint(message),
    String(route ?? ''),
  ].join(' ');
  return crypto.createHash('sha256').update(basis).digest('hex');
}

/* ── Recording ─────────────────────────────────────────────────────────── */

/** Keeps only the keys the schema and the allowlist both admit. */
function safeContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const out = {};
  for (const key of CONTEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(context, key)) continue;
    const value = context[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = redactMessage(value).slice(0, 200);
  }
  const keys = Object.keys(out);
  return keys.length === 0 ? null : JSON.stringify(out);
}

/**
 * Records one occurrence. Returns a result; never throws.
 *
 * The return value is for tests and for callers that want to know — no caller is
 * required to check it, and none may rely on a throw.
 */
export function recordError(db, event = {}) {
  try {
    if (!db || typeof db.prepare !== 'function') return { ok: false, reason: 'no_db' };

    const source = SOURCES.includes(event.source) ? event.source : null;
    // Not guessed. Source is assigned server-side at every call site, so an
    // unknown one is a programming error, and inventing a value would file the
    // report under a category it does not belong to.
    if (!source) return { ok: false, reason: 'bad_source' };

    const kind = typeof event.kind === 'string' && event.kind.trim()
      ? redactMessage(event.kind).slice(0, 100)
      : 'Error';
    const message = redactMessage(typeof event.message === 'string' ? event.message : String(event.message ?? ''));
    const route = source === 'client'
      ? normaliseClientRoute(event.route)
      : normaliseServerRoute(event.route);

    const fp = fingerprint({ source, kind, message, route });
    const now = new Date().toISOString();

    const existing = db.prepare('SELECT fingerprint FROM error_groups WHERE fingerprint = ?').get(fp);

    if (!existing && source === 'client') {
      const { c } = db.prepare(
        "SELECT COUNT(*) AS c FROM error_groups WHERE source = 'client' AND status = 'open'"
      ).get();
      if (c >= CLIENT_GROUP_CEILING) {
        recordOverflow(db, now);
        // Deliberately `ok`. The caller answers 202 either way: a different
        // answer would tell an attacker exactly when the ceiling was reached,
        // and a client that retries on failure would amplify the flood.
        return { ok: true, fingerprint: OVERFLOW_FINGERPRINT, overflow: true };
      }
    }

    if (existing) {
      db.prepare(`
        UPDATE error_groups
           SET occurrences = occurrences + 1,
               last_seen_at = ?,
               status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
               resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END
         WHERE fingerprint = ?
      `).run(now, fp);
    } else {
      db.prepare(`
        INSERT INTO error_groups
          (fingerprint, source, kind, message, route, status, occurrences, users_seen,
           first_seen_at, last_seen_at, release)
        VALUES (?, ?, ?, ?, ?, 'open', 1, 0, ?, ?, ?)
      `).run(fp, source, kind, message, route, now, now,
        typeof event.release === 'string' ? event.release.slice(0, 40) : null);
    }

    // Above the hourly rate the counter keeps climbing and the evidence stops
    // duplicating — 100 copies of one stack say nothing the first said.
    const recentEvents = db.prepare(
      'SELECT COUNT(*) AS c FROM error_events WHERE fingerprint = ? AND occurred_at > ?'
    ).get(fp, new Date(Date.now() - 3600_000).toISOString()).c;

    if (recentEvents < MAX_EVENTS_PER_HOUR) {
      db.prepare(`
        INSERT INTO error_events
          (id, fingerprint, occurred_at, stack, route, method, status_code,
           user_hash, role, user_agent, context)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `err-${crypto.randomUUID()}`, fp, now,
        redactStack(event.stack),
        route,
        typeof event.method === 'string' ? event.method.slice(0, 10) : null,
        Number.isInteger(event.statusCode) ? event.statusCode : null,
        typeof event.userHash === 'string' ? event.userHash.slice(0, 64) : null,
        typeof event.role === 'string' ? event.role.slice(0, 40) : null,
        typeof event.userAgent === 'string' ? redactMessage(event.userAgent).slice(0, 80) : null,
        safeContext(event.context)
      );

      // Keep only the newest MAX_EVENTS_PER_GROUP rows for this problem.
      db.prepare(`
        DELETE FROM error_events
         WHERE fingerprint = ?
           AND id NOT IN (
             SELECT id FROM error_events WHERE fingerprint = ?
             ORDER BY occurred_at DESC, id DESC LIMIT ?
           )
      `).run(fp, fp, MAX_EVENTS_PER_GROUP);
    }

    /**
     * `users_seen` counts distinct users among the RETAINED evidence, not all
     * time — and cannot mean anything else. Events are capped while occurrences
     * are not, and an exact all-time count would require keeping every hash,
     * which is the thing this design refuses to do. The dashboard must say
     * "distinct users seen recently" rather than imply a total.
     */
    db.prepare(`
      UPDATE error_groups
         SET users_seen = (
           SELECT COUNT(DISTINCT user_hash) FROM error_events
            WHERE fingerprint = ? AND user_hash IS NOT NULL
         )
       WHERE fingerprint = ?
    `).run(fp, fp);

    return { ok: true, fingerprint: fp };
  } catch (err) {
    // The whole point. Never rethrow, never let a reporting failure become the
    // user's problem.
    try { console.error('[errorReporter] failed to record an error:', err?.message ?? err); } catch { /* nothing left to try */ }
    return { ok: false, reason: 'record_failed' };
  }
}

/** The reserved counter row. Best-effort by the same rule as everything here. */
function recordOverflow(db, now) {
  try {
    const exists = db.prepare('SELECT 1 FROM error_groups WHERE fingerprint = ?').get(OVERFLOW_FINGERPRINT);
    if (exists) {
      db.prepare(
        'UPDATE error_groups SET occurrences = occurrences + 1, last_seen_at = ? WHERE fingerprint = ?'
      ).run(now, OVERFLOW_FINGERPRINT);
    } else {
      db.prepare(`
        INSERT INTO error_groups
          (fingerprint, source, kind, message, route, status, occurrences, users_seen, first_seen_at, last_seen_at)
        VALUES (?, 'client', 'ClientGroupCeiling', 'client error group ceiling reached', NULL, 'open', 1, 0, ?, ?)
      `).run(OVERFLOW_FINGERPRINT, now, now);
    }
  } catch { /* the ceiling still held, which is what mattered */ }
}
