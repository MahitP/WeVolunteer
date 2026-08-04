import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { JWT_SECRET, COOKIE_NAME } from '../config.js';
import { authenticateToken, inTransaction } from '../utils.js';
import { requireCap } from '../authz.js';
import { recordAudit } from '../auditLog.js';
import { recordError, hashUserId } from '../errorReporter.js';

const router = express.Router();

/**
 * The one endpoint in this application that accepts a write without a session.
 *
 * ── Why it is unauthenticated, and why that is not an oversight ──
 *
 * An error can happen before a session exists — the login screen, a failed
 * `getMe`, a bundle that will not boot — and those are precisely the failures
 * that lock people out and that nobody can report by other means. Requiring
 * auth would hide exactly the class of bug this release exists to see. Say it
 * here, in the code, because the next person to read this route will reasonably
 * assume the missing `authenticateToken` is a bug and "fix" it, blinding the
 * login screen.
 *
 * It deliberately has **no `ROUTE_REGISTRY` entry**. Guard 2 in
 * `authz.completeness.test.js` only examines routes carrying
 * `authenticateToken`; this one does not, so the guard never looks at it, and
 * adding a defensive entry fails the build as stale.
 *
 * ── What protects it instead ──
 *
 *   - a dedicated rate limiter (app.js), 20 per IP per fifteen minutes
 *   - an 8 kB body cap, mounted path-scoped BEFORE the global 100 kB parser —
 *     see the note at that mount, because the obvious placement does nothing
 *   - the 500-group client ceiling in `errorReporter.js`, which bounds STORAGE
 *     regardless of how many addresses the traffic comes from
 *   - server-side route normalisation, so no client string reaches the table
 *   - `recordError`, which never throws
 *
 * The limiter and the ceiling are not redundant. The limiter bounds requests per
 * IP and does nothing about a thousand addresses; the ceiling bounds rows and
 * does nothing about request volume. Each covers the other's blind spot.
 */

/**
 * The running version, for `error_groups.release`.
 *
 * Read here rather than imported from `app.js`, which computes the same value:
 * `app.js` imports this router, so importing back would make the pair a cycle
 * whose behaviour depended on which one loaded first. Three lines of duplication
 * is the cheaper of the two problems, and `/health` already reads this same file
 * for the same reason.
 */
const VERSION = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
).version;

/**
 * Who is reporting, if anyone — and never an error if nobody is.
 *
 * A report may arrive with a valid session, an expired one, a forged one or none
 * at all, and all four are ordinary. A malformed cookie must not produce a 4xx:
 * that would make this endpoint a way to test whether a token is still valid,
 * and it would drop the reports from exactly the broken-session states worth
 * hearing about.
 *
 * Deliberately NOT `authenticateToken`. That middleware re-reads the user from
 * the database, enforces `token_version`, checks revocation and the email gate,
 * and answers 401/403 on failure — every one of which is the wrong behaviour
 * here. This reads one claim to attribute a report and gives up silently.
 *
 * The id is hashed immediately and the raw value never leaves this function.
 */
function optionalReporter(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return { userHash: null, role: null };
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return {
      userHash: hashUserId(decoded?.id),
      role: typeof decoded?.role === 'string' ? decoded.role.slice(0, 40) : null,
    };
  } catch {
    return { userHash: null, role: null };
  }
}

/**
 * Accepts a client error report. Always answers 202.
 *
 * ── Why the answer is always the same ──
 *
 * `202` is returned whether the report was stored, collapsed into an existing
 * group, dropped because the client-group ceiling was reached, or lost because
 * recording failed. That uniformity is a security property, not laziness:
 *
 *   - A distinct answer for "ceiling reached" tells an attacker exactly when
 *     their flood took effect, which is a progress meter for the attack.
 *   - A distinct answer for "stored" tells them which fingerprints are new,
 *     which is an oracle over the contents of the table.
 *   - A failure status invites a client to retry, and a client that retries on
 *     failure amplifies the flood that caused the failure.
 *
 * The client can do nothing useful with any of that information. Its report is
 * fire-and-forget by design.
 *
 * ── Every field is hostile ──
 *
 * `source`, `release`, `occurred_at`, `status`, `fingerprint` and `user_hash`
 * are assigned here or inside `recordError`, and are never read from the body —
 * a client that sends them is ignored rather than refused, because refusing
 * would be another oracle. `route` is the one string the client MUST supply,
 * since the server cannot know which screen crashed, and it is normalised
 * server-side before storage. `message`, `stack` and `kind` go through
 * redaction. `context` is filtered to an allowlist.
 */
router.post('/api/errors/report', (req, res) => {
  // Answer first, unconditionally. Nothing below can change what the client
  // receives, which is what stops a reporting failure becoming a client-visible
  // failure on a path with no session to recover.
  res.status(202).json({ accepted: true });

  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { userHash, role } = optionalReporter(req);

    recordError(db, {
      // Assigned, never read from the body. A report claiming to be a server
      // error would otherwise escape the client ceiling entirely.
      source: 'client',
      release: VERSION,
      userHash,
      role,

      // Client-supplied, and all of it untrusted: `route` is normalised against
      // the approved pattern list, `message`/`stack`/`kind` are redacted, and
      // `context` is reduced to allowlisted keys. `occurred_at`, `status` and
      // the fingerprint are decided inside recordError.
      kind: body.kind,
      message: body.message,
      stack: body.stack,
      route: body.route,
      context: body.context,
    });
  } catch (err) {
    // `recordError` does not throw, so this is for everything around it — a
    // hostile getter on the body, say. The response has already gone.
    try { console.error('[errorRoutes] failed to accept a client report:', err?.message ?? err); } catch { /* nothing left */ }
  }
});

/* ── The triage API ────────────────────────────────────────────────────────
 *
 * Everything below is `super_admin` only, through `requireCap` on capabilities
 * that live in `SUPER_ONLY`. That is not a convention here, it is the access
 * control: these endpoints return redacted stack traces, file paths and internal
 * structure, and `can()` refuses a SUPER_ONLY capability BEFORE it consults
 * per-user grants — so no `user_capabilities` row can reach them and
 * `capability.grant` is not a path to the dashboard.
 *
 * No `else if (can(...))` cascade appears anywhere below. `super_admin` holds
 * `'*'`, so such a chain is not mutually exclusive; on the v1.2a branch that
 * exact shape produced a real data leak. There is one gate per route and no
 * branching on identity at all.
 *
 * None of these needs a `ROUTE_REGISTRY` entry: each carries a `capabilityGate`,
 * which is what Guard 2 looks for.
 */

const GROUP_STATUSES = Object.freeze(['open', 'resolved', 'ignored']);
const SOURCES = Object.freeze(['server', 'client', 'worker']);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Query parameters are hostile even here.
 *
 * The caller is the platform owner, so this is not about them — it is about the
 * fact that `?limit=1e9` or `?limit[]=x` reaching SQLite unclamped is a
 * self-inflicted denial of service on the largest tables in the schema, and an
 * authenticated foot-gun is still a foot-gun. Express gives an ARRAY for a
 * repeated parameter, so a bare `Number()` on it would yield NaN or, worse for
 * a single-element array, a number — both are refused here in favour of the
 * default.
 */
function boundedInt(raw, { fallback, min, max }) {
  if (Array.isArray(raw) || raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;                 // NaN, Infinity, '12abc'
  const floored = Math.floor(n);
  if (max === undefined) return Math.max(min, floored);
  return Math.min(max, Math.max(min, floored));
}

/** An unrecognised filter value is ignored rather than refused: a filter is a
 *  view, and answering 400 for one would make the dashboard brittle for no gain. */
const oneOf = (raw, allowed) => (typeof raw === 'string' && allowed.includes(raw) ? raw : null);

/* 1 ── GET /api/errors ─────────────────────────────────────────────────── */

router.get('/api/errors', authenticateToken, requireCap('error.read'), (req, res) => {
  try {
    const limit = boundedInt(req.query.limit, { fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
    const offset = boundedInt(req.query.offset, { fallback: 0, min: 0 });
    const status = oneOf(req.query.status, GROUP_STATUSES);
    const source = oneOf(req.query.source, SOURCES);

    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (source) { where.push('source = ?'); params.push(source); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM error_groups ${clause}`).get(...params);

    // last_seen_at DESC is what the triage index is built for, and the order the
    // dashboard reads in: the thing that broke most recently is the thing most
    // likely to still be broken.
    const groups = db.prepare(`
      SELECT * FROM error_groups ${clause}
       ORDER BY last_seen_at DESC, fingerprint ASC
       LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return res.json({ groups, total, limit, offset });
  } catch (err) {
    console.error('Failed to list error groups:', err);
    return res.status(500).json({ error: 'Could not load error groups.' });
  }
});

/* 2 ── GET /api/errors/summary ─────────────────────────────────────────────
 *
 * REGISTERED BEFORE `/:fingerprint`, AND THAT ORDERING IS THE CORRECTNESS.
 *
 * Express matches in registration order and `summary` is a perfectly legal
 * value for `:fingerprint`. The other way round, this route never runs: the
 * parameterised handler looks up a group called "summary", finds none, and
 * answers 404. The endpoint would "exist", every gate would be right, the
 * authorization suite would stay green, and the dashboard chart would simply be
 * empty for ever — a routing bug wearing a not-found's clothes, most likely
 * diagnosed as a broken chart.
 *
 * The rule for anything added later: every literal path goes above every
 * parameterised one that could swallow it.
 */
router.get('/api/errors/summary', authenticateToken, requireCap('error.read'), (req, res) => {
  try {
    /**
     * Occurrences by day come from EVENTS, not groups.
     *
     * A group carries one `last_seen_at`, so counting groups by day would draw
     * "problems whose most recent sighting was Tuesday" and call it Tuesday's
     * error volume. Events are the occurrences. They are capped at 50 per group
     * and swept at 30 days, so this chart is explicitly a 30-day window over
     * retained evidence — not an all-time total, and the dashboard must not
     * imply otherwise.
     */
    const byDay = db.prepare(`
      SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS count
        FROM error_events
       GROUP BY day
       ORDER BY day ASC
    `).all();

    // By source, from GROUPS: how many distinct problems, and how many times
    // they have happened in total — the counter survives its evidence.
    const bySource = db.prepare(`
      SELECT source,
             COUNT(*) AS groups,
             COALESCE(SUM(occurrences), 0) AS occurrences
        FROM error_groups
       GROUP BY source
       ORDER BY source ASC
    `).all();

    const byStatus = db.prepare(`
      SELECT status, COUNT(*) AS groups FROM error_groups GROUP BY status ORDER BY status ASC
    `).all();

    return res.json({ byDay, bySource, byStatus });
  } catch (err) {
    console.error('Failed to summarise errors:', err);
    return res.status(500).json({ error: 'Could not load the error summary.' });
  }
});

/* 3 ── GET /api/errors/:fingerprint ────────────────────────────────────── */

router.get('/api/errors/:fingerprint', authenticateToken, requireCap('error.read'), (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM error_groups WHERE fingerprint = ?').get(req.params.fingerprint);
    if (!group) return res.status(404).json({ error: 'No such error group.' });

    /**
     * No pagination here, deliberately.
     *
     * The storage layer already caps evidence at 50 rows per fingerprint on
     * insert, so this result set is bounded by construction. Adding a second,
     * independent bound would be a number that could drift from the real one and
     * a knob that suggests there is more to fetch when there is not.
     */
    const events = db.prepare(`
      SELECT * FROM error_events WHERE fingerprint = ? ORDER BY occurred_at DESC, id DESC
    `).all(req.params.fingerprint);

    return res.json({ group, events });
  } catch (err) {
    console.error('Failed to load an error group:', err);
    return res.status(500).json({ error: 'Could not load that error group.' });
  }
});

/* 4 ── PATCH /api/errors/:fingerprint ──────────────────────────────────── */

/**
 * Resolve, ignore, or reopen a group.
 *
 * ── Why the write and the audit row are one transaction ──
 *
 * `recordAudit` throws rather than returning, so wrapping both makes them atomic
 * in each direction: no status change without a record of who made it, and no
 * audit row describing a change that rolled back. "Who closed this" is a
 * question a district will ask about a moderation-adjacent surface, and a
 * silently-lost audit row looks exactly like nobody having done it.
 *
 * Reads are deliberately NOT audited. The plan asks for it on the state change
 * only, and `admin_audit_logs` has no retention sweep at all — auditing every
 * dashboard poll would create an unbounded write path in a table nothing
 * expires, and bury eight genuinely consequential actions under thousands of
 * "the owner looked at a list".
 */
router.patch('/api/errors/:fingerprint', authenticateToken, requireCap('error.write'), (req, res) => {
  const { fingerprint } = req.params;
  const status = req.body?.status;

  if (!GROUP_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${GROUP_STATUSES.join(', ')}.`,
      field: 'status'
    });
  }

  try {
    const existing = db.prepare('SELECT status FROM error_groups WHERE fingerprint = ?').get(fingerprint);
    if (!existing) return res.status(404).json({ error: 'No such error group.' });

    const now = new Date().toISOString();
    const resolving = status === 'resolved';

    inTransaction(() => {
      db.prepare(`
        UPDATE error_groups
           SET status = ?, resolved_at = ?, resolved_by = ?
         WHERE fingerprint = ?
      `).run(status, resolving ? now : null, resolving ? req.user.id : null, fingerprint);

      recordAudit(db, {
        adminId: req.user.id,
        action: 'ERROR_GROUP_STATUS_CHANGED',
        // An error group is not a user, and the column is nullable — inventing
        // a target here would put an unrelated person\'s id on the row.
        targetUserId: null,
        details: `Error group ${fingerprint}: ${existing.status} -> ${status}`
      });
    });

    return res.json({ fingerprint, status, previousStatus: existing.status });
  } catch (err) {
    console.error('Failed to update an error group:', err);
    return res.status(500).json({ error: 'Could not update that error group.' });
  }
});

export default router;
