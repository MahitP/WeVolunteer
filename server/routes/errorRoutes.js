import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { JWT_SECRET, COOKIE_NAME } from '../config.js';
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

export default router;
