import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';

import { ROLES } from './authz.js';

/**
 * Two regression guards for the authorization spine (v1.2a, Tasks 7a-7e):
 *
 *   1. No route file may compare a role string directly, in ANY spelling.
 *   2. Every authenticated route sits behind a capability gate, unless it is a
 *      reviewed exception because it only ever acts on the caller's own
 *      account.
 *
 * Neither guard touches production code. Where a route does not cleanly fit
 * "capability-gated" or "genuinely self-only", it is reported here rather than
 * silently allowlisted — see task-8-report.md for the full audit.
 */

let srv;
beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
}, 60000);
afterAll(async () => { await srv?.close(); });

const routesDir = new URL('./routes/', import.meta.url);

describe('authorization hygiene', () => {
  // ── Guard 1 ──────────────────────────────────────────────────────────────
  it('has no role-string comparison in route files, in any spelling', () => {
    /**
     * The bug this guards against: Task 7b initially replaced a role check
     * with `req.principal.effectiveRole !== 'organizer'` — still a
     * role-string comparison, just spelled differently, and it sailed
     * straight past a guard that only knew `req.user.role`. A guard that
     * knows one spelling of the thing it forbids is not a guard, so this one
     * knows four:
     *
     *   1. req.user.role compared with === / !==
     *   2. req.principal.effectiveRole / .actualRole compared with === / !==
     *   3. any `.role` property compared against a role-name string literal
     *      (covers a renamed/aliased read of the same thing, e.g. a fresh
     *      `db.prepare(...).get(req.user.id)` row's `.role`)
     *   4. a destructured `role` (`const { role } = req.user`) later compared
     *      against one of those literals
     *
     * Role names come from `ROLES` in authz.js, not a hardcoded list, so a
     * future role is covered automatically.
     *
     * Deliberately NOT flagged: ownership comparisons such as
     * `event.organizer_id !== req.principal.userId` — those compare ids, not
     * role names, and are the correct pattern for "may this actor act on this
     * row" (as opposed to "may this kind of actor act at all").
     */
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const CMP = '(?:===|!==)';
    const roleAlt = ROLES.map(escapeRe).join('|');
    const QUOTE = `(['"\`])`;
    const QUOTED_ROLE = `${QUOTE}(?:${roleAlt})\\1`;

    const DIRECT_PATTERNS = [
      { label: 'req.user.role compared with === / !==', re: new RegExp(`req\\.user\\.role\\s*${CMP}`) },
      { label: 'req.principal.effectiveRole/.actualRole compared with === / !==', re: new RegExp(`req\\.principal\\.(?:effectiveRole|actualRole)\\s*${CMP}`) },
      { label: '.role property compared against a role-name literal', re: new RegExp(`\\.role\\b\\s*${CMP}\\s*${QUOTED_ROLE}`) },
      { label: 'role-name literal compared against a .role property', re: new RegExp(`${QUOTED_ROLE}\\s*${CMP}\\s*[\\w$]*(?:\\.[\\w$]+)*\\.role\\b`) },
    ];

    // A destructured `role` local, e.g. `const { role } = req.user`.
    const DESTRUCTURE_RE = new RegExp(`\\{[^}]*\\brole\\b[^}]*\\}\\s*=\\s*req\\.(?:user|principal)\\b`);
    const BARE_ROLE_PATTERNS = [
      { label: 'destructured `role` compared against a role-name literal', re: new RegExp(`(?<![.\\w$])role\\s*${CMP}\\s*${QUOTED_ROLE}`) },
      { label: 'role-name literal compared against a destructured `role`', re: new RegExp(`${QUOTED_ROLE}\\s*${CMP}\\s*(?<![.\\w$])role\\b`) },
    ];

    /**
     * Reviewed, non-authorization uses of `.role` compared to a role-name
     * literal. Pinned to an exact file:line, not a blanket exemption — moving
     * the line forces this list to go stale (caught below) and requires
     * re-review. Every entry here is a decision, not a formality:
     *
     * Both lines decide the `verified` flag for a BRAND NEW signup (an
     * organizer needs staff approval before they can host events; every
     * other role does not). `fields` is the caller-submitted signup payload
     * for the account being CREATED — there is no req.user/req.principal at
     * this point in the request, and neither line decides whether the
     * request itself may proceed. This is the same category of thing
     * route-inventory.md documents at accountRoutes.js:53 ("business logic
     * about what deletion does... not an authorization gate"), not the
     * "may this kind of actor do X" pattern Guard 1 exists to ban.
     */
    const REVIEWED_NON_AUTH_EXCEPTIONS = new Set([
      'authRoutes.js:223',
      'oauthRoutes.js:379',
    ]);
    const consumedExceptions = new Set();

    const offenders = [];
    for (const file of readdirSync(routesDir)) {
      if (!file.endsWith('.js')) continue;
      const src = readFileSync(new URL(file, routesDir), 'utf8');
      const lines = src.split('\n');
      const destructured = DESTRUCTURE_RE.test(src);

      lines.forEach((line, i) => {
        const lineNo = i + 1;
        const key = `${file}:${lineNo}`;
        const hits = [];
        for (const { label, re } of DIRECT_PATTERNS) if (re.test(line)) hits.push(label);
        if (destructured) {
          for (const { label, re } of BARE_ROLE_PATTERNS) if (re.test(line)) hits.push(label);
        }
        if (hits.length === 0) return;

        if (REVIEWED_NON_AUTH_EXCEPTIONS.has(key)) {
          consumedExceptions.add(key);
          return;
        }
        offenders.push(
          `${key}: ${hits.join(', ')} — "${line.trim()}"\n`
          + '    Use requireCap()/requireCapAny() for "may this kind of actor do X", '
          + 'or compare ids (e.g. resource.ownerId !== req.principal.userId) for '
          + '"may this actor act on this row." Import role names from authz.js\'s '
          + 'ROLES rather than hardcoding them.'
        );
      });
    }

    // A stale exception (no longer matching anything) is worth knowing about:
    // either the line moved and the entry needs updating, or the check it was
    // covering for was removed and the entry should go with it.
    const staleExceptions = [...REVIEWED_NON_AUTH_EXCEPTIONS].filter((e) => !consumedExceptions.has(e));

    expect(staleExceptions, 'REVIEWED_NON_AUTH_EXCEPTIONS entries that no longer match anything — remove them').toEqual([]);
    expect(offenders, 'role-string comparison(s) found in server/routes/').toEqual([]);
  });

  // ── Guard 2 ──────────────────────────────────────────────────────────────
  it('every authenticated route sits behind a capability gate', async () => {
    const { app } = await import('./app.js');

    /**
     * Express 5 keeps mounted layers on `app.router.stack`; Express 4 (what
     * this app runs) instead keeps them on `app._router.stack` and, worse,
     * `app.router` is a GETTER that THROWS ("'app.router' is deprecated!")
     * rather than returning undefined — so a bare `app.router?.stack` still
     * blows up the whole test file on this Express version. Both are
     * attempted, in order, with the throw swallowed.
     */
    function getRouterStack(expressApp) {
      try {
        if (expressApp.router?.stack) return expressApp.router.stack;
      } catch {
        // Express 4: accessing `.router` itself throws. Fall through to `._router`.
      }
      if (expressApp._router?.stack) return expressApp._router.stack;
      return null;
    }

    const stack = getRouterStack(app);
    if (!stack) {
      throw new Error(
        'Could not find the Express router stack on `app` via either '
        + '`app.router.stack` (Express 5) or `app._router.stack` (Express 4). '
        + 'This usually means an Express upgrade changed internals again. '
        + 'A coverage test that walks an empty stack and reports success is '
        + 'worse than no test at all — fix the walk, do not let this pass silently.'
      );
    }

    const ungated = [];
    let routeCount = 0;
    const walk = (layers) => {
      for (const layer of layers) {
        if (layer.route) {
          routeCount += 1;
          const names = layer.route.stack.map((s) => s.name);
          const authed = names.includes('authenticateToken');
          // Both requireCap() and requireCapAny() return a middleware named
          // `capabilityGate` (deliberately, per authz.js), so this one check
          // recognises either.
          const gated = names.includes('capabilityGate');
          if (authed && !gated) {
            for (const method of Object.keys(layer.route.methods)) {
              ungated.push(`${method.toUpperCase()} ${layer.route.path}`);
            }
          }
        } else if (layer.handle?.stack) {
          walk(layer.handle.stack);
        }
      }
    };
    walk(stack);

    expect(routeCount, 'the router-stack walk found zero routes — treat this as a failure, not a pass').toBeGreaterThan(0);

    /**
     * Routes that are authenticated but legitimately need no capability,
     * because they act ONLY on the caller's own account — never another
     * user's row, never with a role-based bypass. Each entry below was
     * verified by reading its handler, not bulk-pasted from a test failure.
     * Every entry is a decision, not a formality — see task-8-report.md for
     * the read-through of each one.
     */
    const SELF_ONLY_ALLOWLIST = [
      // authRoutes.js
      'GET /api/auth/me',                    // reads only the caller's own row (req.user.id)
      'POST /api/auth/logout',                // revokes only the caller's current session
      'POST /api/auth/sign-out-others',       // bumps only the caller's own token_version

      // accountRoutes.js
      'DELETE /api/auth/account',             // deletes only the caller's own account
      'POST /api/auth/change-password',       // updates only the caller's own password_hash
      'POST /api/auth/change-email',          // starts a pending change on the caller's own account
      'POST /api/auth/cancel-email-change',   // deletes only the caller's own pending token
      'GET /api/auth/pending-email-change',   // reads only the caller's own pending token
      'POST /api/auth/change-username',       // updates only the caller's own username
      'POST /api/auth/resend-verification',   // resends only to the caller's own address

      // userRoutes.js
      'PATCH /api/auth/profile',              // updates only columns on the caller's own row
      'GET /api/user/preferences',            // WHERE user_id = caller
      'POST /api/user/preferences',           // INSERT/UPDATE scoped to caller's own id

      // attendanceRoutes.js
      'GET /api/certificates',                // WHERE at.user_id = caller

      // contentRoutes.js
      'GET /api/notifications',               // WHERE user_id = caller
      'PATCH /api/notifications',             // UPDATE scoped to caller's own id
      'GET /api/favorites',                   // WHERE user_id = caller
      'POST /api/favorites/:eventId',         // INSERT/DELETE scoped to caller's own id

      // oauthRoutes.js
      'GET /api/oauth/accounts',              // WHERE user_id = caller
      'POST /api/oauth/disconnect',           // DELETE scoped to caller's own id

      // privacyRoutes.js
      'POST /api/privacy/export',             // INSERT scoped to caller's own id
      'GET /api/privacy/export/status',       // WHERE user_id = caller
      'GET /api/privacy/export/download/:id', // job.user_id !== caller -> 404 (always the caller's own export job)
    ];

    const unexpected = ungated.filter((r) => !SELF_ONLY_ALLOWLIST.includes(r));

    /**
     * Everything in `unexpected` is a route this walk found authenticated but
     * not middleware-gated, and NOT verified as acting only on the caller's
     * own account. Per the audit in task-8-report.md, most of these are not
     * insecure — they authorize inline with `can()` plus an ownership or
     * participant check (e.g. `applications`, `events/:id`, `messages/*`,
     * `announcements`, `comments`), which this walk cannot see because it
     * only recognises the `requireCap`/`requireCapAny` middleware pattern. A
     * few are intentionally open to every authenticated role with no
     * capability distinction to make (`GET /api/events`, `GET
     * /api/leaderboard`, event comments, the ICS download). None of that
     * makes them "self-only" as defined above, and bulk-allowlisting them
     * here would misrepresent them as such — so they are reported, not
     * allowlisted. See task-8-report.md for the full route-by-route
     * breakdown and the actual protection (if any) each one has.
     */
    expect(unexpected, 'ungated route(s) — see task-8-report.md for the reviewed disposition of each').toEqual([]);
  });
});
