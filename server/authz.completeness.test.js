import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';

import { ROLES } from './authz.js';

/**
 * Three regression guards for the authorization spine (v1.2a, Tasks 7a-7e, 17):
 *
 *   1. No server module that makes authorization decisions may compare a role
 *      string directly, in ANY spelling.
 *   2. Every authenticated route sits behind either a capability gate, or a
 *      reviewed, categorised, one-line-justified reason it doesn't need one.
 *   3. The same rule as (1), for the client: no module under src/ may compare a
 *      role string without a reviewed, categorised declaration.
 *
 * No guard touches production code. Every declaration is a decision verified by
 * reading the code, not a bulk-pasted allowlist — see task-8-report.md and
 * task-17-report.md for the full audit trails.
 */

/* ── Shared detector primitives ─────────────────────────────────────────────
 *
 * Hoisted so Guards 1 and 3 cannot drift apart: the client guard exists because
 * the server one was not watching src/, and two independently-maintained copies
 * of the same regexes would recreate that gap one edit at a time.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Loose equality included: oxlint runs without an eqeqeq rule, so
// `req.user.role == 'admin'` is legal JS here and just as much a role-string
// comparison as `===`.
const CMP = '(?:===|!==|==|!=)';
const QUOTE = `(['"\`])`;
const QUOTED_ROLE = `${QUOTE}(?:${ROLES.map(escapeRe).join('|')})\\1`;

/**
 * Comments are not code. `server/messaging.js`'s own fix for the bug Guard 1
 * exists to catch explains the OLD pattern in prose (`actor.role === 'student'`,
 * quoted verbatim as the thing that was removed) — and without stripping
 * comments first, the detector matches its own changelog.
 *
 * A previous version of this function stripped `/* ... *\/` with a multi-line,
 * non-string-aware regex — which is exactly as unsafe as it sounds.
 * `server/app.js` contains the string literal
 * `'https://*.tile.openstreetmap.org'`, whose `/*` (the `//` immediately
 * followed by `*`) opened a "comment" that swallowed 26 real lines, including
 * the entire CORS origin-checking block, before the next close-comment marker
 * happened to appear. `server/testServer.js` contains `'routes/*, ...'`, with
 * the same effect over 19 lines. Both spans were clean today, so nothing was
 * hidden — but the size of the blind spot depended entirely on where an
 * unrelated string literal's `/*` happened to close, which is not a bound
 * anyone could reason about.
 *
 * This version never looks inside a line for a comment opener at all: it blanks
 * a line ONLY if the line, once trimmed, itself BEGINS with `//`, `/*`, or `*`
 * — the shape of a `//` line comment, a JSDoc block's opening `/**`, or one of
 * its continuation lines starting with `*`. That is precisely what motivated
 * stripping in the first place, it can never blank a line that starts with real
 * code — no matter what string literal a later line contains — and line numbers
 * stay exact since every line still occupies one array slot. The trade-off: a
 * trailing `/* ... *\/` after real code on the same line is not stripped (none
 * exist in this codebase's style, which favours full-line comments and JSDoc
 * blocks); handling that would mean detecting whether a `/*` sits inside a
 * quote, which this does not attempt.
 */
function stripComments(src) {
  return src
    .split('\n')
    .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n');
}

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
     *   1. req.user.role compared with === / !== / == / !=
     *   2. req.principal.effectiveRole / .actualRole compared with
     *      === / !== / == / !=
     *   3. ANY `.effectiveRole` / `.actualRole` property (unpinned prefix,
     *      unlike #2) compared the same way — covers an aliased/local
     *      principal, e.g. `const p = principal || principalFor(actor)` in
     *      server/messaging.js followed by `p.effectiveRole === 'admin'`,
     *      which is the single most natural way to reintroduce the exact
     *      defect that file was just fixed for
     *   4. any `.role` property compared against a role-name string literal
     *      (covers a renamed/aliased read of the same thing, e.g.
     *      `actor.role === 'admin'`, or a fresh
     *      `db.prepare(...).get(req.user.id)` row's `.role`)
     *   5. a destructured `role` (`const { role } = req.user`) later compared
     *      against one of those literals
     *
     * Role names come from `ROLES` in authz.js, not a hardcoded list, so a
     * future role is covered automatically.
     *
     * Deliberately NOT flagged: ownership comparisons such as
     * `event.organizer_id !== req.principal.userId` — those compare ids, not
     * role names, and are the correct pattern for "may this actor act on this
     * row" (as opposed to "may this kind of actor act at all").
     *
     * Known, deliberately uncovered spellings (not gold-plating this
     * detector further): `switch (u.role) { case 'admin': ... }` and
     * `['admin', 'super_admin'].includes(u.role)`. Both are real role-string
     * patterns this guard cannot see today.
     */
    const DIRECT_PATTERNS = [
      { label: 'req.user.role compared with (in)equality', re: new RegExp(`req\\.user\\.role\\s*${CMP}`) },
      { label: 'req.principal.effectiveRole/.actualRole compared with (in)equality', re: new RegExp(`req\\.principal\\.(?:effectiveRole|actualRole)\\s*${CMP}`) },
      // Unpinned prefix, deliberately broader than the row above: catches an
      // aliased/local principal (`p.effectiveRole`, `principal.actualRole`),
      // not just one reached through `req.principal` directly.
      { label: '.effectiveRole/.actualRole property (any prefix) compared with (in)equality', re: new RegExp(`\\.(?:effectiveRole|actualRole)\\s*${CMP}`) },
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
     * Scope: every server module that can plausibly make an authorization
     * decision — a recursive walk of the whole server/ tree, not a
     * hand-maintained list of directories. A fixed list of directories
     * (server/, server/routes/, server/services/, server/workers/) was tried
     * first and missed 9 of 53 non-test server modules, notably
     * server/realtime/socketServer.js and server/realtime/events.js — a
     * long-lived socket connection is exactly the kind of place authority
     * can leak, and there is no principled reason to have excluded it.
     *
     * `node_modules` is skipped at any depth. `server/authz.js` is excluded
     * (top-level only — nothing else is named authz.js) — its
     * `req.user.role` appears only inside a comment explaining the
     * historical pattern this whole effort replaced, and must not be
     * deleted. `*.test.js` files are excluded everywhere — tests
     * legitimately set up role fixtures (`db.prepare(...).run(role, ...)`
     * etc.), which is not an authorization decision at all.
     */
    function collectServerJsFiles() {
      const files = [];
      const walk = (dirUrl, relDir) => {
        for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue;
          if (entry.isDirectory()) {
            walk(new URL(`${entry.name}/`, dirUrl), `${relDir}${entry.name}/`);
          } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
            if (relDir === '' && entry.name === 'authz.js') continue;
            files.push({ url: new URL(entry.name, dirUrl), key: `./${relDir}${entry.name}` });
          }
        }
      };
      walk(new URL('./', import.meta.url), '');
      return files;
    }

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
    for (const { url, key: fileKey } of collectServerJsFiles()) {
      const src = stripComments(readFileSync(url, 'utf8'));
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

    // A stale exception (no longer matching anything) is worth knowing about:
    // either the line moved and the entry needs updating, or the check it was
    // covering for was removed and the entry should go with it.
    const staleExceptions = [...REVIEWED_NON_AUTH_EXCEPTIONS].filter((e) => !consumedExceptions.has(e));

    expect(staleExceptions, 'REVIEWED_NON_AUTH_EXCEPTIONS entries that no longer match anything — remove them').toEqual([]);
    expect(offenders, 'role-string comparison(s) found').toEqual([]);
  });

  // ── Guard 3 ──────────────────────────────────────────────────────────────
  it('has no undeclared role-string comparison in any client module under src/', () => {
    /**
     * Guard 1 for the client.
     *
     * The server side needed ~54 conversions precisely because nothing was
     * watching, and Guard 1 walked `server/` only — so while the API was being
     * converted, `src/App.jsx` and `src/session/SessionProvider.jsx` kept
     * branching on role strings in every place a new role needed one, with an
     * unscoped `else` at the end of each cascade. Introducing super_admin
     * produced an empty navigation rail, no profile page, a "Volunteer" label
     * on the platform owner, and — through the `/` ternary's bare `else` —
     * OrganizerDashboard for both new roles. Task 17 converted those; this
     * guard is what stops the clock from resetting.
     *
     * The client is UX only: every capability is re-checked server-side, so a
     * hit here is never a security hole. It is a "role added tomorrow renders
     * the wrong screen" hole, which is the defect class this whole branch
     * exists to close.
     *
     * ── Patterns ──
     *
     * The first four mirror Guard 1 (shared primitives, hoisted above, so the
     * two cannot drift), with `req.user.role` swapped for the client's own
     * idiom — the object from /api/auth/me, which the client calls
     * `currentUser` or `user`. The fifth has no server counterpart and is
     * DELIBERATELY BROADER than anything Guard 1 does:
     *
     *   5. ANY (in)equality against a role-name string literal, whatever is on
     *      the other side.
     *
     * That row is not gold-plating. `src/session/SessionProvider.jsx:92` read
     *
     *     params: (role ?? currentUser?.role) === 'admin' ? {} : { mine: 'true' }
     *
     * — a role-string comparison that all four Guard-1-shaped patterns miss,
     * because the `)` between `.role` and `===` breaks every one of them. It
     * was found by reading the file, which is exactly the failure mode the
     * server side hit three times on this branch. Row 5 catches it, and
     * catches an aliased local (`const r = user.role; … r === 'admin'`) too.
     *
     * The cost of row 5 is false positives on non-role values that happen to
     * be spelled like a role name — a `?type=organizer` query parameter, a
     * signup form's own `<select>` value. Those are declared below with a
     * reason, which is the correct price. Narrowing the pattern to make them
     * disappear would reintroduce the blind spot it exists to close.
     *
     * Known, deliberately uncovered (same as Guard 1):
     * `switch (u.role) { case 'admin': … }` and
     * `['admin','super_admin'].includes(u.role)`.
     */
    const CLIENT_PATTERNS = [
      { label: 'currentUser.role / user.role compared with (in)equality', re: new RegExp(`\\b(?:currentUser|user)\\??\\.role\\s*${CMP}`) },
      { label: '.effectiveRole/.actualRole property (any prefix) compared with (in)equality', re: new RegExp(`\\.(?:effectiveRole|actualRole)\\s*${CMP}`) },
      { label: '.role property compared against a role-name literal', re: new RegExp(`\\.role\\b\\s*${CMP}\\s*${QUOTED_ROLE}`) },
      { label: 'role-name literal compared against a .role property', re: new RegExp(`${QUOTED_ROLE}\\s*${CMP}\\s*[\\w$?]*(?:\\.[\\w$]+)*\\.role\\b`) },
      { label: '(in)equality involving a role-name literal', re: new RegExp(`(?:${CMP}\\s*${QUOTED_ROLE}|${QUOTED_ROLE}\\s*${CMP})`) },
    ];

    /**
     * Scope: every non-test module under src/.
     *
     * A recursive walk rather than a list of directories, for the reason Guard
     * 1 documents: a fixed list is a list of the places someone remembered.
     * `*.test.js`/`*.test.jsx` are excluded everywhere (a test legitimately
     * builds role fixtures), and `src/setupTests.js` is excluded as test
     * infrastructure. Nothing else is exempt — including `src/authz.js`, which
     * contains no role literal and must not start containing one.
     */
    function collectClientFiles() {
      const files = [];
      const walk = (dirUrl, relDir) => {
        for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue;
          if (entry.isDirectory()) {
            walk(new URL(`${entry.name}/`, dirUrl), `${relDir}${entry.name}/`);
            continue;
          }
          if (!entry.isFile() || !/\.jsx?$/.test(entry.name)) continue;
          if (/\.test\.jsx?$/.test(entry.name)) continue;
          if (relDir === '' && entry.name === 'setupTests.js') continue;
          files.push({ url: new URL(entry.name, dirUrl), key: `src/${relDir}${entry.name}` });
        }
      };
      walk(new URL('../src/', import.meta.url), '');
      return files;
    }

    const CLIENT_CATEGORY = Object.freeze({
      // Not an authorization decision at all: the compared value is a view
      // type, a form field, or the role of somebody OTHER than the actor,
      // being rendered as a label.
      NOT_AUTHORIZATION: 'NOT_AUTHORIZATION',
      // A real client-side role branch that should become a capability check,
      // recorded rather than silently exempted. Every one is UX-only and
      // re-checked server-side; each entry names what would need to change.
      UNCONVERTED_UX: 'UNCONVERTED_UX',
    });

    /**
     * Every role-string comparison under src/, pinned to an exact file:line
     * with a category and a one-line reason. Pinned, not blanket: moving the
     * line makes the entry stale (caught below) and forces re-review.
     *
     * NOT_AUTHORIZATION entries are the ones that are fine as they are.
     * UNCONVERTED_UX entries are NOT fine — they are the remainder of the same
     * defect this branch exists to close, listed here so they are visible and
     * countable instead of invisible. Task 17's brief scoped the conversion to
     * App.jsx and SessionProvider and said to report the rest rather than
     * expand scope unilaterally; task-17-report.md is that report.
     *
     * Adding a NEW entry to either list is a decision, not a formality: prefer
     * converting the check to `can()`.
     */
    const CLIENT_DECLARATIONS = {
      // ── NOT_AUTHORIZATION ──
      'src/App.jsx:646': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'compares `viewingProfile.type`, the ?type=organizer|volunteer query parameter that picks which profile overlay to render — a view discriminator, not anybody\'s role' },
      'src/components/EventComments.jsx:83': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'renders a "Host" tag beside a comment author — labels a THIRD PARTY\'s role for the reader; grants the viewer nothing' },
      'src/components/EventComments.jsx:84': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'renders a "Staff" tag beside a comment author — same: labelling, not gating' },
      'src/components/account/ProfileMenu.jsx:48': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'picks the display string "Pending approval" over the ROLE_LABEL entry; labelling a role is the one thing a role name is legitimately for' },
      'src/views/Signup.jsx:94': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'the signup form\'s own role <select> value, defaulting the grade field — there is no session and no principal at this point' },
      'src/views/Signup.jsx:183': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'toast tone for the account just requested (organizers await approval); form state, not an actor' },
      'src/views/Signup.jsx:203': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'which school value to submit for the account being created; form state, not an actor' },
      'src/views/Signup.jsx:244': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'which fields the signup form shows for the selected account type; form state, not an actor' },

      // ── UNCONVERTED_UX — real role branches, out of Task 17's scope ──
      'src/components/EventActionPanel.jsx:14': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: '`isStudent` gates the apply/withdraw panel; wants can(event.apply)' },
      'src/components/EventCard.jsx:70': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: 'favourite button shown to students only; wants can(event.apply) — no favourite.* capability exists yet' },
      'src/components/EventComments.jsx:75': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: '`canDelete` is own-comment OR admin; wants can(event.moderate), which is what DELETE /api/comments/:id already enforces' },
      'src/components/EventDetailsExperience.jsx:74': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: '`isStudent` gates the apply affordances; wants can(event.apply)' },
      'src/components/EventDetailsExperience.jsx:249': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: 'favourite button shown to students only; wants can(event.apply)' },
      'src/components/EventModal.jsx:67': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: '`isOwner` is role AND id; the id half is the correct ownership test, the role half wants can(event.edit.own)' },
      'src/components/EventModal.jsx:68': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: '`isAdmin` gates the moderation surface; wants can(event.moderate)' },
      'src/components/EventModal.jsx:90': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: '`isStudent` gates apply/withdraw inside the modal; wants can(event.apply)' },
      'src/components/EventModal.jsx:337': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: 'favourite button shown to students only; wants can(event.apply)' },
      'src/views/BrowseEvents.jsx:44': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: '`isStudent` gates favourites and apply CTAs on the browse list; wants can(event.apply)' },
      'src/views/CalendarView.jsx:55': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: '`isOrganizer` picks hosted-events entries over applied-shift entries; wants a can(event.create) cascade, most-privileged-first' },
      'src/views/Messages.jsx:95': { category: CLIENT_CATEGORY.UNCONVERTED_UX, reason: 'decides which side of a conversation is the student when resolving it; wants can(event.apply), and the server re-derives it anyway' },
    };

    const validCategories = new Set(Object.values(CLIENT_CATEGORY));
    const consumed = new Set();
    const offenders = [];

    for (const { url, key: fileKey } of collectClientFiles()) {
      const lines = stripComments(readFileSync(url, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        const key = `${fileKey}:${i + 1}`;
        const hits = CLIENT_PATTERNS.filter(({ re }) => re.test(line)).map(({ label }) => label);
        if (hits.length === 0) return;

        const declared = CLIENT_DECLARATIONS[key];
        if (declared && validCategories.has(declared.category) && declared.reason) {
          consumed.add(key);
          return;
        }
        offenders.push(
          `${key}: ${hits.join(', ')} — "${line.trim()}"\n`
          + '    Use can(user, cap) from src/authz.js (or <Can user cap fallback>) for '
          + '"may this kind of actor see X", and compare ids for "is this the actor\'s own row". '
          + 'Order any cascade most-privileged-first and end it explicitly — can() is true for '
          + 'EVERY capability when the role is super_admin. If the comparison genuinely is not '
          + 'an authorization decision, add a categorised CLIENT_DECLARATIONS entry with a reason.'
        );
      });
    }

    // A file with zero matches everywhere would mean the walk found nothing —
    // a scan that reports success over an empty file list is worse than no
    // scan, and this is the cheapest way to notice.
    expect(collectClientFiles().length, 'the src/ walk found no modules to scan').toBeGreaterThan(0);

    const stale = Object.keys(CLIENT_DECLARATIONS).filter((k) => !consumed.has(k));
    expect(stale, 'CLIENT_DECLARATIONS entries that no longer match anything — the line moved or the check was removed; re-review and update or delete').toEqual([]);
    expect(offenders, 'undeclared role-string comparison(s) found under src/').toEqual([]);
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
      // ── SELF_ONLY — acts solely on the caller's own account. File
      // attribution lives in each entry's reason (and/or its file:line),
      // not in this heading: several files (e.g. userRoutes.js) contribute
      // routes to more than one category below, so a per-heading file list
      // drifts the moment that's true and was a source of confusion in
      // review — read the per-route reason for exactly what protects it. ──
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

      // ── INLINE_GATED — genuinely gated in the handler body (an inline
      // can()/ownership/participant check the middleware-stack walk cannot
      // see). See each entry's reason for the actual check and file:line. ──
      'GET /api/users/:id/profile': { category: CATEGORY.INLINE_GATED, reason: 'canSeeContact = isSelf || can(audit.read) || hostsApplicant gates PII fields (userRoutes.js:39); non-PII stats intentionally open to any authenticated caller' },
      'GET /api/events/:id': { category: CATEGORY.INLINE_GATED, reason: 'isStaff = can(event.moderate) || organizer_id === caller, else 403 (eventRoutes.js:392-394)' },
      'GET /api/applications': { category: CATEGORY.INLINE_GATED, reason: 'deny-by-default cascade can(audit.read) -> can(applicant.review) -> can(application.withdraw) -> [] (applicationRoutes.js:45-60); covered by authz.matrix.test.js' },
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

      // ── OPEN_TO_AUTHENTICATED — intentionally open to every authenticated
      // role; no capability distinction exists or is wanted. ──
      'GET /api/events': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'public browse listing; every role\'s CAPABILITIES entry includes event.view, so no role is ever denied' },
      'GET /api/organizers/:id/profile': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'an organizer\'s public-facing hosting record (events hosted, volunteers helped, hours awarded) — no PII beyond what the profile already publishes, and no role has ever been denied it; previously carried requireCap(\'event.view\'), a capability all five roles hold, which read as a gate while discriminating against nobody' },
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
