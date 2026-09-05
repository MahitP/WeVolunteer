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

/**
 * Forwards a recorded error to Better Stack, if it is configured.
 *
 * ── Why the import is lazy ──
 *
 * This module's header states its boundary: `node:crypto` and `clientRoutes.js`
 * (plain data), and nothing else — which is what lets a test drive it against a
 * throwaway file and what keeps it out of a cycle with `app.js`. A top-level
 * import of `telemetry.js` would break that claim, and `telemetry.js` imports
 * `redactMessage` from HERE, so it would also be a cycle.
 *
 * A failure to load leaves telemetry permanently off for the process and
 * changes nothing else — the row is already written by the time this runs.
 */
let telemetryModule = null;
/* Started at module load rather than on first use, so the resolution is done
   long before a request is served and no process ever loses its FIRST error to
   a cold import. Fire-and-forget: a failure leaves telemetry off and changes
   nothing else. The dynamic form is what breaks the cycle — by the time this
   promise settles, both modules have finished evaluating. */
import('./telemetry.js')
  .then((m) => { telemetryModule = m; })
  .catch(() => { telemetryModule = null; });

function emitErrorTelemetry(fields) {
  try {
    if (!telemetryModule?.logEvent) return;
    telemetryModule.logEvent('error', 'error.recorded', {
      ...fields,
      errorType: fields.kind,
      level: 'error',
    });
  } catch { /* never let reporting the error become the error */ }
}

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
  'jobId', 'eventId', 'slotId', 'component', 'boundary',
  /**
   * The correlation id of the request this failed in, when there was one.
   *
   * Safe by construction: a v4 UUID this server generated in `app.js` and
   * handed back on `X-Request-Id`. It names no person and carries no meaning
   * outside this system — which is exactly why it can be the thread from a
   * browser crash report to the access record to this row.
   */
  'requestId'
]);

/* ── Redaction ─────────────────────────────────────────────────────────── */

/**
 * Rules ordered most-specific-first, so a JWT is recognised as a JWT before its
 * segments are eaten by the generic long-token rule.
 */
const REDACTIONS = [
  /* A URL carrying credentials in its authority — `postgres://user:pass@host`.
     Ordered above the generic token rules so the whole credential goes at once
     rather than the password being partly eaten by the long-token rule and the
     username surviving next to it.

     Nothing is known to log a connection string today: `resolveDb.mjs` prints
     host and database only, and `pg` does not put the DSN in its error
     messages. This is defence in depth, and cheap. The path that would matter
     is the one that already caught a partial email leak — a driver error
     recorded verbatim, stored in `error_reports`, and read later by an
     administrator through the admin UI. A single such message would put the
     production database password on an application screen.

     Deliberately requires BOTH a userinfo part and a password, so ordinary URLs
     — every link in every stack trace — are untouched.

     FIRST, ahead of the email rule, and that ordering is the whole point.
     `user:password@host` is shaped exactly like an address, so the email rule
     matched `hunter2-s3cret@db.abcdefgh.supabase.co` and left
     `postgres://postgres:` standing next to it. The password did disappear,
     which is why this looked fine, but by accident and only partly: the role
     name survived, and a rule that happens to cover a case is one refactor
     away from not covering it. Most-specific-first, as the note above says. */
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi, 'URL credentials'],
  /* The local part and the domain are matched with UNICODE letter classes, not
     `A-Za-z`. With the ASCII-only version the rule did not fail cleanly on
     `josé.garcía@lincolnhigh.k12.il.us` — it matched from the first ASCII run
     that reached the `@` and stored `josé.garcí[redacted]`, leaving the
     student's given name and most of their surname in the table. A partial
     match is worse than no match: the row looks redacted, so nobody reads it
     as a leak. Accented names are ordinary in a school district, and the
     notification worker records the message of a failed send verbatim, so a
     single bounce is the whole path. Found by probing the rules with realistic
     PII during the v1.2c final release review.

     `\p{M}` is here because a combining mark is a separate code point: without
     it a decomposed `e` + U+0301 would end the match at the mark and reproduce
     the same partial leak in a different alphabet. */
  [/[\p{L}\p{M}\p{N}._%+-]+@[\p{L}\p{M}\p{N}.-]+\.[\p{L}]{2,}/gu, 'email address'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/g, 'JWT'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer token'],
  [/\breauth-[A-Za-z0-9-]{8,}/gi, 'step-up challenge id'],
  /* A certificate code is a BEARER CREDENTIAL, not an identifier:
     `GET /api/certificates/verify/:code` is unauthenticated and answers with a
     student's name, the event, and their hours. `normaliseClientRoute` already
     refuses to store one in `route`; a code that arrives inside a *message*
     reached the table anyway, and would sit there for up to 180 days.

     Spelled with the generator's own alphabet (`certificates.js`, which
     excludes I, O, 0 and 1) and deliberately case-SENSITIVE, so it cannot eat
     an unrelated lowercase path segment — `wev-test-abcd`, the shape
     `testServer.js` gives its scratch directories, appears in stack traces. */
  [/\bWEV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}\b/g, 'certificate code'],
  [/\b[0-9a-f]{24,}\b/gi, 'long hex run — a token, hash or id'],
  /**
   * A bare IPv4 literal, which every rule above walks straight past.
   *
   * Found by probing the telemetry path with realistic values during the final
   * pre-launch pass: `logEvent`'s field allowlist drops `ip` outright, so the
   * structured path was never the exposure. Free text was. A message like
   * "signed in from 203.0.113.7" reached the wire intact, because an address is
   * not a URL, not an email, not hex, and not a seven-digit run — it falls
   * between every rule in this table.
   *
   * It matters here rather than in the abstract because an IP is personal data
   * under GDPR/UK GDPR when it identifies a person, this is a service holding
   * minors' records, and `error_reports` keeps a message for up to 180 days
   * where an administrator reads it. The same message also leaves the process
   * for Better Stack.
   *
   * Octets are bounded to 0-255 rather than `\d{1,3}` so the rule matches
   * addresses and not any four dot-separated numbers. That keeps it off version
   * strings with three parts (`1.2.0`, the value this process logs as
   * `release`), ISO timestamps, stack positions (`/x.js:123:456`) and
   * coordinate pairs — the same restraint the phone rule below documents. A
   * genuine four-part version like `1.0.0.0` is also a syntactically valid
   * address and will be redacted; that is the deliberate trade, and it is the
   * safe direction to be wrong in.
   *
   * Word boundaries, so an address is caught with punctuation around it — in
   * parentheses, at the end of a sentence, after a colon, inside a URL path.
   * Private and loopback addresses are redacted too: `10.x`, `192.168.x` and
   * `127.0.0.1` describe internal topology, and a rule with carve-outs is a
   * rule somebody has to reason about before trusting it.
   *
   * IPv6 is deliberately NOT handled here. Every compact pattern for it also
   * matches a clock — `15:30:00` is three colon-separated hex-legal groups —
   * and a redactor that eats timestamps out of stack traces costs more than the
   * case it closes. Closing it properly means a validating matcher rather than
   * one more line in this table, and it is recorded as follow-up rather than
   * smuggled in beside an IPv4 fix.
   */
  [/\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g, 'IP address'],
  /* Written phone numbers, BEFORE the digit-run rule below and separate from
     it. That rule names a phone number as one of the things it catches, and it
     only ever caught unformatted ones: `5551234567` was redacted while
     `555-123-4567`, `555.123.4567`, `555 123 4567` and `+1 (555) 123-4567`
     went through untouched — which is every way a person actually writes one.
     Found by probing the rules with realistic PII shapes during the v1.2c
     release review rather than by reading them.

     Deliberately narrow: it requires the 3-3-4 grouping, so dates
     (`2026-08-04`), versions (`1.2.3`), stack positions (`/x.js:123:456`),
     ISO timestamps and coordinate pairs are all left alone. Over-redaction has
     its own cost — a message where every number is `[redacted]` cannot be
     debugged from. */
  [/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, 'phone number'],
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
  ].join('\0');
  return crypto.createHash('sha256').update(basis).digest('hex');
}

/**
 * The value the `user_hash` column exists to hold.
 *
 * The dashboard asks "how many distinct people hit this" and "is this one
 * person's odd data". A digest answers both. The id would answer a third
 * question nobody asked and would make this table a second record of who did
 * what, expiring on a different schedule from the account itself.
 *
 * Here rather than at each call site so there is one definition: four
 * `createHash('sha256')` calls scattered through the workers is four chances for
 * one of them to store `user.id` by mistake, and that mistake is invisible until
 * somebody reads the table.
 *
 * Truncated to 32 characters, matching `reauth_challenges.ip_hash`. Not a
 * security boundary — it is a correlation key, and a full digest would be no
 * less reversible by guessing an id and hashing it.
 */
export function hashUserId(userId) {
  if (typeof userId !== 'string' || userId.length === 0) return null;
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 32);
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
export async function recordError(db, event = {}) {
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

    const existing = await db.prepare('SELECT fingerprint FROM error_groups WHERE fingerprint = ?').get(fp);

    if (!existing && source === 'client') {
      const { c } = await db.prepare(
        "SELECT COUNT(*) AS c FROM error_groups WHERE source = 'client' AND status = 'open'"
      ).get();
      if (c >= CLIENT_GROUP_CEILING) {
        await recordOverflow(db, now);
        // Deliberately `ok`. The caller answers 202 either way: a different
        // answer would tell an attacker exactly when the ceiling was reached,
        // and a client that retries on failure would amplify the flood.
        return { ok: true, fingerprint: OVERFLOW_FINGERPRINT, overflow: true };
      }
    }

    /**
     * ONE atomic upsert, not a SELECT followed by an INSERT or an UPDATE.
     *
     * The read above decides the ceiling, which is advisory — a race there costs
     * at most one extra group. Deciding the WRITE from it is a different matter:
     * two reports carrying the same fingerprint both read "not present", both
     * take the INSERT branch, and the second one violates
     * `error_groups_pkey`. The whole report is then lost, because the failure
     * happens before the event row is written.
     *
     * SQLite made that almost unreachable — the handler ran synchronously behind
     * a write gate — so the shape survived. On PostgreSQL the pool makes it
     * ordinary, and an error reporter that drops reports when several arrive
     * together is worst exactly when it is most needed.
     *
     * Columns on the right-hand side are qualified with the table name.
     * PostgreSQL treats a bare `occurrences` in `DO UPDATE SET` as ambiguous
     * between the existing row and the proposed one and refuses the statement;
     * the qualified form means the stored row on both engines.
     */
    await db.prepare(`
      INSERT INTO error_groups
        (fingerprint, source, kind, message, route, status, occurrences, users_seen,
         first_seen_at, last_seen_at, release)
      VALUES (?, ?, ?, ?, ?, 'open', 1, 0, ?, ?, ?)
      ON CONFLICT (fingerprint) DO UPDATE
        SET occurrences  = error_groups.occurrences + 1,
            last_seen_at = excluded.last_seen_at,
            status       = CASE WHEN error_groups.status = 'resolved' THEN 'open' ELSE error_groups.status END,
            resolved_at  = CASE WHEN error_groups.status = 'resolved' THEN NULL ELSE error_groups.resolved_at END
    `).run(fp, source, kind, message, route, now, now,
      typeof event.release === 'string' ? event.release.slice(0, 40) : null);

    // Above the hourly rate the counter keeps climbing and the evidence stops
    // duplicating — 100 copies of one stack say nothing the first said.
    const recentEvents = (await db.prepare(
      'SELECT COUNT(*) AS c FROM error_events WHERE fingerprint = ? AND occurred_at > ?'
    ).get(fp, new Date(Date.now() - 3600_000).toISOString())).c;

    if (recentEvents < MAX_EVENTS_PER_HOUR) {
      await db.prepare(`
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
      await db.prepare(`
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
    await db.prepare(`
      UPDATE error_groups
         SET users_seen = (
           SELECT COUNT(DISTINCT user_hash) FROM error_events
            WHERE fingerprint = ? AND user_hash IS NOT NULL
         )
       WHERE fingerprint = ?
    `).run(fp, fp);

    /**
     * Telemetry, LAST and only on the success path.
     *
     * After the row is written, so a telemetry problem cannot cost the evidence
     * — the database is the record and Better Stack is a copy of it. Only on
     * success, so what reaches the vendor is exactly what reached the table,
     * which is the invariant `telemetry.betterstack.test.js` asserts.
     *
     * Every value below has already been through this module: `message` and
     * `kind` are redacted, `route` is a pattern or `'unknown'`, `stack` is
     * redacted and trimmed, `userHash` is a digest. Nothing raw from `event` is
     * forwarded, and `context` is not forwarded at all — its allowlist admits
     * ids this module has no need to send onward.
     */
    emitErrorTelemetry({
      source, kind, message, route, fingerprint: fp,
      stack: redactStack(event.stack),
      method: typeof event.method === 'string' ? event.method.slice(0, 10) : undefined,
      statusCode: Number.isInteger(event.statusCode) ? event.statusCode : undefined,
      userHash: typeof event.userHash === 'string' ? event.userHash : undefined,
      role: typeof event.role === 'string' ? event.role : undefined,
      release: typeof event.release === 'string' ? event.release : undefined,
      requestId: event.context?.requestId,
    });

    return { ok: true, fingerprint: fp };
  } catch (err) {
    // The whole point. Never rethrow, never let a reporting failure become the
    // user's problem.
    try { console.error('[errorReporter] failed to record an error:', err?.message ?? err); } catch { /* nothing left to try */ }
    return { ok: false, reason: 'record_failed' };
  }
}

/* ── Retention ─────────────────────────────────────────────────────────── */

/** Evidence is kept a month. Long enough to investigate, short enough to forget. */
export const EVENT_RETENTION_DAYS = 30;

/** A problem someone has already dealt with. */
export const CLOSED_GROUP_RETENTION_DAYS = 30;

/** A problem nobody has dealt with. Kept far longer, because it is still true. */
export const OPEN_GROUP_RETENTION_DAYS = 180;

/**
 * A client group seen exactly once.
 *
 * This is the rule that drains a flood. Every fingerprint an attacker forges is
 * single-occurrence by construction — they send a distinct message and never
 * repeat it — so 500 forged groups would otherwise sit in the table for the full
 * 180 days, having been created in a few seconds.
 *
 * The cost is stated rather than hidden: a GENUINE client bug seen exactly once
 * is also deleted after a week. That is the trade the plan made deliberately —
 * "a real client bug recurs; a forged one does not" — and it is the right way
 * round, because the alternative is letting a minute of hostile traffic decide
 * six months of table contents.
 */
export const SINGLE_CLIENT_GROUP_RETENTION_DAYS = 7;

/**
 * Deletes error data whose retention window has closed. Never throws.
 *
 * ── Where this runs ──
 *
 * From `runNotificationSweep` in `utils.js`, beside `sweepExpiredChallenges`.
 * No new interval, no new worker, no new process, and nothing added to
 * `shutdown.js` — the existing 15-minute timer is already registered there, and
 * a second one would be a second thing to drain.
 *
 * ── Why it cannot throw ──
 *
 * `runNotificationSweep` wraps its ENTIRE body in one try/catch, so an
 * exception here would abandon every sweep task registered after it, not just
 * this one. Catching internally keeps the failure local: this sweep does
 * nothing that run, the others still happen, and the next tick tries again.
 *
 * ── What it will not do ──
 *
 * Only DELETE. It creates no row, so it cannot resurrect the `client-overflow`
 * counter or anything else; and it updates no `status`, so it cannot reopen a
 * group somebody closed. Groups are the source of truth: none is deleted for
 * having no retained events, and no group's fate is decided by evidence that
 * may already have expired.
 */
export async function sweepErrors(db, now = new Date()) {
  const empty = { groups: 0, events: 0 };
  try {
    if (!db || typeof db.prepare !== 'function') return { ...empty, failed: true };

    const cutoff = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();

    // Groups first: each delete cascades to its own evidence, so the event pass
    // below is left with only the rows whose group is still alive.
    const closed = (await db.prepare(`
      DELETE FROM error_groups
       WHERE status IN ('resolved', 'ignored') AND last_seen_at < ?
    `).run(cutoff(CLOSED_GROUP_RETENTION_DAYS))).changes;

    // `<= 1` rather than `= 1`: a group written by a partially-failed record
    // could hold 0, and leaving it forever would be the one row this rule exists
    // to remove.
    const singles = (await db.prepare(`
      DELETE FROM error_groups
       WHERE source = 'client' AND occurrences <= 1 AND last_seen_at < ?
    `).run(cutoff(SINGLE_CLIENT_GROUP_RETENTION_DAYS))).changes;

    const stale = (await db.prepare(`
      DELETE FROM error_groups
       WHERE status = 'open' AND last_seen_at < ?
    `).run(cutoff(OPEN_GROUP_RETENTION_DAYS))).changes;

    // Evidence older than its window, for groups that survived above. The
    // group keeps its counter: "this happened 4,000 times" outlives the
    // stacks, which is the whole reason the two tables are separate.
    const events = (await db.prepare(
      'DELETE FROM error_events WHERE occurred_at < ?'
    ).run(cutoff(EVENT_RETENTION_DAYS))).changes;

    return { groups: closed + singles + stale, events };
  } catch (err) {
    try { console.error('[errorReporter] retention sweep failed:', err?.message ?? err); } catch { /* nothing left to try */ }
    return { ...empty, failed: true };
  }
}

/** The reserved counter row. Best-effort by the same rule as everything here. */
async function recordOverflow(db, now) {
  try {
    const exists = await db.prepare('SELECT 1 FROM error_groups WHERE fingerprint = ?').get(OVERFLOW_FINGERPRINT);
    if (exists) {
      await db.prepare(
        'UPDATE error_groups SET occurrences = occurrences + 1, last_seen_at = ? WHERE fingerprint = ?'
      ).run(now, OVERFLOW_FINGERPRINT);
    } else {
      await db.prepare(`
        INSERT INTO error_groups
          (fingerprint, source, kind, message, route, status, occurrences, users_seen, first_seen_at, last_seen_at)
        VALUES (?, 'client', 'ClientGroupCeiling', 'client error group ceiling reached', NULL, 'open', 1, 0, ?, ?)
      `).run(OVERFLOW_FINGERPRINT, now, now);
    }
  } catch { /* the ceiling still held, which is what mattered */ }
}
