import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';

import { ROLES } from './authz.js';

/**
 * Two regression guards for the authorization spine (v1.2a, Tasks 7a-7e):
 *
 *   1. No server module that makes authorization decisions may compare a role
 *      string directly, in ANY spelling.
 *   2. Every authenticated route sits behind either a capability gate, or a
 *      reviewed, categorised, one-line-justified reason it doesn't need one.
 *
 * Neither guard touches production code. Every declaration is a decision
 * verified by reading the handler, not a bulk-pasted allowlist — see
 * task-8-report.md for the full audit trail.
 */

let srv;
beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
}, 60000);
afterAll(async () => { await srv?.close(); });

describe('authorization hygiene', () => {
  // ── Guard 1 ──────────────────────────────────────────────────────────────
  it('has no role-string comparison in any server module that makes authorization decisions', () => {
    /**
     * The bug this guards against: Task 7b initially replaced a role check
     * with `req.principal.effectiveRole !== 'organizer'` — still a
     * role-string comparison, just spelled differently, and it sailed
     * straight past a guard that only knew `req.user.role`. A separate,
     * bigger instance of the same class of bug was found living in
     * server/messaging.js — outside server/routes/, where the original
     * version of this guard did not look — and denied super_admin/partner
     * outright. Both are why this guard now scans widely and knows four
     * spellings, not one:
     *
     *   1. req.user.role compared with === / !==
     *   2. req.principal.effectiveRole / .actualRole compared with === / !==
     *   3. any `.role` property compared against a role-name string literal
     *      (covers a renamed/aliased read of the same thing, e.g.
     *      `actor.role === 'admin'`, or a fresh
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

    /**
     * Comments are not code. `server/messaging.js`'s own fix for the bug this
     * guard exists to catch explains the OLD pattern in prose
     * (`actor.role === 'student'`, quoted verbatim as the thing that was
     * removed) — and without stripping comments first, the detector matches
     * its own changelog. Block comments are blanked to spaces (preserving
     * line numbers and column positions for anything after them on the same
     * line); a line whose only content is a `//` comment is blanked entirely.
     */
    function stripComments(src) {
      const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
      return noBlockComments
        .split('\n')
        .map((line) => (/^\s*\/\//.test(line) ? '' : line))
        .join('\n');
    }

    // A destructured `role` local, e.g. `const { role } = req.user`.
    const DESTRUCTURE_RE = new RegExp(`\\{[^}]*\\brole\\b[^}]*\\}\\s*=\\s*req\\.(?:user|principal)\\b`);
    const BARE_ROLE_PATTERNS = [
      { label: 'destructured `role` compared against a role-name literal', re: new RegExp(`(?<![.\\w$])role\\s*${CMP}\\s*${QUOTED_ROLE}`) },
      { label: 'role-name literal compared against a destructured `role`', re: new RegExp(`${QUOTED_ROLE}\\s*${CMP}\\s*(?<![.\\w$])role\\b`) },
    ];

    /**
     * Scope: every server module that can plausibly make an authorization
     * decision, not just server/routes/. `server/authz.js` is excluded — its
     * `req.user.role` appears only inside a comment explaining the historical
     * pattern this whole effort replaced, and must not be deleted. `*.test.js`
     * files are excluded — tests legitimately set up role fixtures
     * (`db.prepare(...).run(role, ...)` etc.), which is not an authorization
     * decision at all.
     */
    const SCAN_DIRS = ['./', './routes/', './services/', './workers/'];
    const EXCLUDED_TOP_LEVEL_FILES = new Set(['authz.js']);

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
      './routes/authRoutes.js:223',
      './routes/oauthRoutes.js:379',
    ]);
    const consumedExceptions = new Set();

    const offenders = [];
    for (const dir of SCAN_DIRS) {
      const dirUrl = new URL(dir, import.meta.url);
      for (const file of readdirSync(dirUrl)) {
        if (!file.endsWith('.js') || file.endsWith('.test.js')) continue;
        if (dir === './' && EXCLUDED_TOP_LEVEL_FILES.has(file)) continue;

        const fileKey = `${dir}${file}`;
        const src = stripComments(readFileSync(new URL(file, dirUrl), 'utf8'));
        const lines = src.split('\n');
        const destructured = DESTRUCTURE_RE.test(src);

        lines.forEach((line, i) => {
          const lineNo = i + 1;
          const key = `${fileKey}:${lineNo}`;
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
            + '    Use requireCap()/requireCapAny() (or can() directly) for "may this '
            + 'kind of actor do X", or compare ids (e.g. resource.ownerId !== '
            + 'req.principal.userId) for "may this actor act on this row." Import role '
            + 'names from authz.js\'s ROLES rather than hardcoding them.'
          );
        });
      }
    }

    // A stale exception (no longer matching anything) is worth knowing about:
    // either the line moved and the entry needs updating, or the check it was
    // covering for was removed and the entry should go with it.
    const staleExceptions = [...REVIEWED_NON_AUTH_EXCEPTIONS].filter((e) => !consumedExceptions.has(e));

    expect(staleExceptions, 'REVIEWED_NON_AUTH_EXCEPTIONS entries that no longer match anything — remove them').toEqual([]);
    expect(offenders, 'role-string comparison(s) found').toEqual([]);
  });

  // ── Guard 2 ──────────────────────────────────────────────────────────────
  it('every authenticated route sits behind a capability gate or a declared, categorised reason', async () => {
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

    const CATEGORY = Object.freeze({
      // Acts solely on the caller's own account — never another user's row,
      // never with a role-based bypass.
      SELF_ONLY: 'SELF_ONLY',
      // Genuinely gated in the handler body — an inline can()/ownership/
      // participant check the middleware-stack walk above cannot see.
      INLINE_GATED: 'INLINE_GATED',
      // Intentionally open to every authenticated role; no capability
      // distinction exists or is wanted.
      OPEN_TO_AUTHENTICATED: 'OPEN_TO_AUTHENTICATED',
    });

    /**
     * Every authenticated-but-not-middleware-gated route the walk above finds
     * MUST be declared here, with a category and a one-line reason naming
     * what actually protects it (or why nothing needs to). A new entry is a
     * decision, not a formality: read the handler before adding one. An
     * undeclared route fails the test below rather than being silently
     * treated as fine — see task-8-report.md for the read-through of every
     * entry.
     */
    const ROUTE_REGISTRY = {
      // ── SELF_ONLY (authRoutes.js, accountRoutes.js, userRoutes.js, attendanceRoutes.js, contentRoutes.js, oauthRoutes.js, privacyRoutes.js) ──
      'GET /api/auth/me': { category: CATEGORY.SELF_ONLY, reason: 'reads only the caller\'s own row (req.user.id)' },
      'POST /api/auth/logout': { category: CATEGORY.SELF_ONLY, reason: 'revokes only the caller\'s current session' },
      'POST /api/auth/sign-out-others': { category: CATEGORY.SELF_ONLY, reason: 'bumps only the caller\'s own token_version' },
      'DELETE /api/auth/account': { category: CATEGORY.SELF_ONLY, reason: 'deletes only the caller\'s own account (active-events check is scoped to organizer_id = caller)' },
      'POST /api/auth/change-password': { category: CATEGORY.SELF_ONLY, reason: 'updates only the caller\'s own password_hash' },
      'POST /api/auth/change-email': { category: CATEGORY.SELF_ONLY, reason: 'starts a pending change on the caller\'s own account only' },
      'POST /api/auth/cancel-email-change': { category: CATEGORY.SELF_ONLY, reason: 'deletes only the caller\'s own pending token' },
      'GET /api/auth/pending-email-change': { category: CATEGORY.SELF_ONLY, reason: 'reads only the caller\'s own pending token' },
      'POST /api/auth/change-username': { category: CATEGORY.SELF_ONLY, reason: 'updates only the caller\'s own username' },
      'POST /api/auth/resend-verification': { category: CATEGORY.SELF_ONLY, reason: 'resends only to the caller\'s own address' },
      'PATCH /api/auth/profile': { category: CATEGORY.SELF_ONLY, reason: 'updates only columns on the caller\'s own row' },
      'GET /api/user/preferences': { category: CATEGORY.SELF_ONLY, reason: 'WHERE user_id = caller' },
      'POST /api/user/preferences': { category: CATEGORY.SELF_ONLY, reason: 'insert/update scoped to caller\'s own id' },
      'GET /api/certificates': { category: CATEGORY.SELF_ONLY, reason: 'WHERE at.user_id = caller' },
      'GET /api/notifications': { category: CATEGORY.SELF_ONLY, reason: 'WHERE user_id = caller' },
      'PATCH /api/notifications': { category: CATEGORY.SELF_ONLY, reason: 'update scoped to caller\'s own id' },
      'GET /api/favorites': { category: CATEGORY.SELF_ONLY, reason: 'WHERE user_id = caller' },
      'POST /api/favorites/:eventId': { category: CATEGORY.SELF_ONLY, reason: 'insert/delete scoped to caller\'s own id' },
      'GET /api/oauth/accounts': { category: CATEGORY.SELF_ONLY, reason: 'WHERE user_id = caller' },
      'POST /api/oauth/disconnect': { category: CATEGORY.SELF_ONLY, reason: 'delete scoped to caller\'s own id' },
      'POST /api/privacy/export': { category: CATEGORY.SELF_ONLY, reason: 'insert scoped to caller\'s own id' },
      'GET /api/privacy/export/status': { category: CATEGORY.SELF_ONLY, reason: 'WHERE user_id = caller' },
      'GET /api/privacy/export/download/:id': { category: CATEGORY.SELF_ONLY, reason: 'job.user_id !== caller -> 404 (always the caller\'s own export job)' },

      // ── INLINE_GATED (userRoutes.js, eventRoutes.js, applicationRoutes.js, contentRoutes.js, messageRoutes.js) ──
      'GET /api/users/:id/profile': { category: CATEGORY.INLINE_GATED, reason: 'canSeeContact = isSelf || can(audit.read) || hostsApplicant gates PII fields (userRoutes.js:39); non-PII stats intentionally open to any authenticated caller' },
      'GET /api/events/:id': { category: CATEGORY.INLINE_GATED, reason: 'isStaff = can(event.moderate) || organizer_id === caller, else 403 (eventRoutes.js:392-394)' },
      'GET /api/applications': { category: CATEGORY.INLINE_GATED, reason: 'deny-by-default cascade can(audit.read) -> can(applicant.review) -> can(application.withdraw) -> [] (applicationRoutes.js:45-60); covered by authz.matrix.test.js' },
      'PATCH /api/applications/:id': { category: CATEGORY.INLINE_GATED, reason: 'can(applicant.review)+ownership OR can(application.withdraw)+ownership, explicit 403 else (applicationRoutes.js:396-550); covered by authz.matrix.test.js' },
      'DELETE /api/comments/:id': { category: CATEGORY.INLINE_GATED, reason: 'own comment (user_id === caller) OR can(event.moderate), else 403 (contentRoutes.js:135)' },
      'GET /api/events/:id/attendees': { category: CATEGORY.INLINE_GATED, reason: 'isStaff = can(event.moderate) || organizer_id === caller, else accepted-applicant-only visibility (contentRoutes.js:156)' },
      'GET /api/events/:id/announcements': { category: CATEGORY.INLINE_GATED, reason: 'isStaff = can(event.moderate) || organizer_id === caller, else accepted-applicant-only visibility (contentRoutes.js:201)' },
      'POST /api/events/:id/announcements': { category: CATEGORY.INLINE_GATED, reason: 'can(announcement.post) OR can(event.moderate), plus ownership check (contentRoutes.js:245,248)' },
      'PATCH /api/announcements/:id': { category: CATEGORY.INLINE_GATED, reason: 'can(announcement.post) OR can(event.moderate), plus ownership check (contentRoutes.js:295,298)' },
      'DELETE /api/announcements/:id': { category: CATEGORY.INLINE_GATED, reason: 'can(announcement.post) OR can(event.moderate), plus ownership check (contentRoutes.js:316,319)' },
      'GET /api/recommendations': { category: CATEGORY.INLINE_GATED, reason: 'can(event.apply) gates the feature; non-holders get [] instead of 403, documented in-file as deliberate existing behaviour (contentRoutes.js:499)' },
      'GET /api/messages/conversations': { category: CATEGORY.INLINE_GATED, reason: 'listConversationsForUser(req.user.id) — participant-scoped, never returns a conversation the caller is not in' },
      'POST /api/messages/conversations/resolve': { category: CATEGORY.INLINE_GATED, reason: 'gated by eligibleRelationship()\'s capability checks in server/messaging.js (event.moderate / applicant.review+ownership / event.apply); see the v1.2a messaging.js fix and its 5-role test' },
      'GET /api/messages/conversations/:id/messages': { category: CATEGORY.INLINE_GATED, reason: 'isConversationParticipant(conversation.id, caller), else 404 (messageRoutes.js:92)' },
      'POST /api/messages/conversations/:id/messages': { category: CATEGORY.INLINE_GATED, reason: 'isConversationParticipant check, else 404 (messageRoutes.js:139)' },
      'POST /api/messages/conversations/:id/read': { category: CATEGORY.INLINE_GATED, reason: 'isConversationParticipant check, else 404 (messageRoutes.js:210)' },
      'PATCH /api/messages/conversations/:id/preferences': { category: CATEGORY.INLINE_GATED, reason: 'isConversationParticipant check, else 404 (messageRoutes.js:247)' },
      'GET /api/messages/search': { category: CATEGORY.INLINE_GATED, reason: 'JOIN conversation_participants cp ON cp.user_id = caller — scoped to the caller\'s own conversations (messageRoutes.js:283)' },
      'POST /api/messages/conversations/:id/report': { category: CATEGORY.INLINE_GATED, reason: 'isConversationParticipant check, else 404 (messageRoutes.js:308)' },
      'GET /api/messages/users/search': { category: CATEGORY.INLINE_GATED, reason: 'can(applicant.review)||can(event.moderate) OR can(application.withdraw), else empty (messageRoutes.js:378-398); covered by authz.matrix.test.js and routes.messages.polish.test.js\'s dedicated scoping tests' },

      // ── OPEN_TO_AUTHENTICATED (eventRoutes.js, contentRoutes.js) ──
      'GET /api/events': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'public browse listing; every role\'s CAPABILITIES entry includes event.view, so no role is ever denied' },
      'GET /api/events/:eventId/slots/:slotId/ics': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'any signed-in user may download; title/description/location are no more sensitive than GET /api/events already returns to everyone' },
      'GET /api/events/:id/comments': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'any signed-in user may read any event\'s comments; no ownership/capability distinction by design' },
      'POST /api/events/:id/comments': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'any signed-in user may post a comment on any event; no ownership/capability distinction by design' },
      'GET /api/leaderboard': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'requires login only to prevent public scraping of opted-in student stats (in-file comment); no role distinction' },
      'POST /api/reports': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'any signed-in user may file a report against any event/comment; no capability distinction by design (abuse-reporting entry point)' },
    };

    const validCategories = new Set(Object.values(CATEGORY));
    const undeclared = [];
    for (const route of ungated) {
      const entry = ROUTE_REGISTRY[route];
      if (!entry || !validCategories.has(entry.category) || !entry.reason) {
        undeclared.push(route);
      }
    }

    /**
     * Anything in `undeclared` is a route this walk found authenticated,
     * without a capabilityGate middleware, and with NO reviewed category
     * declared for it. That is a real gap — no capability check, no
     * ownership check, not intentionally open — and must be reported, not
     * silently classified into whichever category makes the suite green.
     * See task-8-report.md if this list is ever non-empty.
     */
    expect(undeclared, 'ungated, UNDECLARED route(s) — read the handler and add a ROUTE_REGISTRY entry, or report a real gap').toEqual([]);

    // Registry hygiene: every declared route must still actually be ungated
    // (otherwise the entry is stale — the route got a capabilityGate and the
    // entry should be deleted) and every category must be one of the three
    // known values with a non-empty reason (checked above, per-route).
    const staleRegistryEntries = Object.keys(ROUTE_REGISTRY).filter((r) => !ungated.includes(r));
    expect(staleRegistryEntries, 'ROUTE_REGISTRY entries for routes that are no longer ungated — remove them').toEqual([]);
  });
});
