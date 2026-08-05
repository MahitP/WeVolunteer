import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';

import { ROLES } from './authz.js';
import { SENSITIVE_ACTIONS } from './sensitiveActions.js';

/**
 * Five regression guards for the authorization spine (v1.2a Tasks 7a-7e/17,
 * v1.2b Tasks 5-6):
 *
 *   1. No server module that makes authorization decisions may compare a role
 *      string directly, in ANY spelling.
 *   2. Every authenticated route sits behind either a capability gate, or a
 *      reviewed, categorised, one-line-justified reason it doesn't need one.
 *   3. The same rule as (1), for the client: no module under src/ may compare a
 *      role string without a reviewed, categorised declaration.
 *   4. Every `requireAAL2(...)` argument in server/ is a registered sensitive
 *      action, spelled as a literal.
 *   5. Every `requireAAL2` gate is paired with a `spendChallenge` for the same
 *      action, and every registered action has a gate. The gate is an early
 *      refusal; the spend is what makes a grant single-use.
 *   6. Every direct `consumeChallenge` call is declared. Guard 5 only recognises
 *      the `spendChallenge(db, req, …)` shape, which the OAuth callback cannot
 *      use — it is reached mid-redirect with no session on the request — so its
 *      spend was invisible to Guard 5 (TD-16). Direct calls are enumerated
 *      rather than banned, so adding one is the moment it has to be justified.
 *
 * This header listed five for a while after the sixth was added, which is the
 * defect the branch's own audit kept finding in other files: the code was right
 * and the prose describing it was not. A guard that exists but is undocumented
 * is the inverse of a comment claiming a check that is missing, and it fails the
 * same way — the next reader trusts the list.
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

/**
 * Call sites of `requireAAL2` in one source file.
 *
 * Kept as a function taking a string, not a path, so the self-tests can drive it
 * with a synthetic module containing the exact bug. Reading a regex and
 * believing it is how three role checks got past Guard 1 on this branch.
 *
 * Hoisted to module scope — with `collectServerJsFiles` below — because Guards 4
 * and 5 both scan for the same call sites and ask different questions about
 * them. Two copies of this regex would let the two guards disagree about what a
 * gate is, which is the same failure the shared Guard 1/3 primitives above exist
 * to prevent.
 */
function findRequireAAL2CallSites(src) {
  const found = [];
  stripComments(src).split('\n').forEach((line, i) => {
    // The declaration is not a call site. `export function requireAAL2(action)`
    // is the one place the identifier legitimately appears with a
    // non-literal argument.
    if (/\bfunction\s+requireAAL2\s*\(/.test(line)) return;
    for (const m of line.matchAll(/\brequireAAL2\s*\(([^)]*)\)/g)) {
      const raw = m[1].trim();
      const quoted = raw.match(/^(['"`])(.*)\1$/);
      found.push({ line: i + 1, raw, action: quoted ? quoted[2] : null, isLiteral: Boolean(quoted) });
    }
  });
  return found;
}

/** Every non-test module under server/, at any depth. */
function collectServerJsFiles() {
  const files = [];
  const walk = (dirUrl, relDir) => {
    for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dirUrl), `${relDir}${entry.name}/`);
      } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        files.push({ url: new URL(entry.name, dirUrl), key: `server/${relDir}${entry.name}` });
      }
    }
  };
  walk(new URL('./', import.meta.url), '');
  return files;
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
      // `fields.role === 'organizer' ? 0 : 1` — chooses the initial `verified`
      // value for a brand-new account, i.e. whether staff must approve it. Not
      // an authorization decision about a caller: there is no principal yet.
      // Moved from :223 when the signup handler gained its server-side consent
      // gate (recordAcceptances / assertConsent), then :257 -> :258 when
      // `withheldCapabilitiesFor` was imported for the /api/auth/me payload.
      // Re-read at both positions: unchanged, and still not an authorization
      // decision.
      './routes/authRoutes.js:258',
      // Moved from :379 in v1.2b Task 5 when `resolveProvider` gained an
      // export and the docstring above it explaining why; to :405 in Task 6
      // (the local `issueSession` became an import with a docstring explaining
      // that too); to :521 in Task 6b, which added the step-up gate to the
      // auto-link branch above it; and to :525 when that branch's comment was
      // corrected — `/api/oauth/link` serves the caller who is not signed in as
      // the account, which is a difference of SESSION, not of address, and the
      // original comment said otherwise. The line itself is unchanged in every
      // case; re-read and re-confirmed each time as the same new-signup
      // `verified` decision described above. That it keeps moving is the guard
      // working as designed — a pinned line is what forces the re-read.
      //
      // Moved to :526 by the v1.2b audit round, which corrected the
      // `issueSession` note further up the file (it claimed the shared helper
      // minted no `jti`, describing a copy Task 6 had already deleted) and
      // widened the same block's "all five sensitive actions" to name the two
      // the audit added. Re-read once more: unchanged, and still not an
      // authorization decision — it sets a new signup's initial approval state,
      // which is a fact about the row being written, not about what its holder
      // may then do.
      './routes/oauthRoutes.js:554',
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
      // Moved 662 -> 671 by v1.2c Task 8, 671 -> 713 by Task 9.5, 713 -> 730 when
      // the offline experience changed from REPLACING the routed view to covering
      // it (the shell is now wrapped in `OfflineOverlay`, and the offline ternary
      // that used to sit directly above this line is gone), then 730 -> 720 when
      // the two boundaries' identical chunk-vs-crash closures were extracted to a
      // shared `crashFallback`, then 720 -> 821 across the rest of v1.2c,
      // 821 -> 826 when the public-route branch above it stopped hardcoding
      // `/verify/` and started deriving the test from PUBLIC_ROUTES, and
      // 826 -> 827 when `/organizer-agreement` was added to the route prop map,
      // and 827 -> 849 when `personaFor` gained the comment explaining why it
      // ignores the withheld set. Re-read at each of those positions: unchanged
      // every time, and still not an authorization check. `viewingProfile.type`
      // is set from the ?type= query parameter and decides which overlay to draw;
      // nothing about the viewer. That the pin keeps moving is the guard working
      // — it forces the re-read.
      'src/App.jsx:849': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'compares `viewingProfile.type`, the ?type=organizer|volunteer query parameter that picks which profile overlay to render — a view discriminator, not anybody\'s role' },
      'src/components/EventComments.jsx:83': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'renders a "Host" tag beside a comment author — labels a THIRD PARTY\'s role for the reader; grants the viewer nothing' },
      'src/components/EventComments.jsx:84': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'renders a "Staff" tag beside a comment author — same: labelling, not gating' },
      'src/components/account/ProfileMenu.jsx:48': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'picks the display string "Pending approval" over the ROLE_LABEL entry; labelling a role is the one thing a role name is legitimately for' },
      /**
       * Re-anchored in v1.2c. All four still describe the same thing — the shape
       * of a form being filled in by somebody who has no account yet, so there is
       * no session and no principal for any of them to be an authorization
       * decision about.
       *
       * The old `:96` entry is gone rather than moved: it guarded a comparison
       * that defaulted the `grade` field from the selected role, and the grade
       * field itself no longer exists in this form. `:255` below is its
       * replacement and asks a different question (which class year to submit).
       */
      'src/views/Signup.jsx:230': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'toast tone for the account just requested (organizers await approval); form state, not an actor' },
      'src/views/Signup.jsx:255': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'whether to submit a class year at all — organizers have no graduation year; form state, not an actor, and the server recomputes the grade from it regardless' },
      'src/views/Signup.jsx:281': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'which school value to submit for the account being created; form state, not an actor' },
      'src/views/Signup.jsx:323': { category: CLIENT_CATEGORY.NOT_AUTHORIZATION, reason: 'which fields the signup form shows for the selected account type; form state, not an actor' },

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
      'GET /api/blocks': { category: CATEGORY.SELF_ONLY, reason: 'WHERE blocker_id = caller — reads only the caller\'s own block list' },
      'POST /api/favorites/:eventId': { category: CATEGORY.SELF_ONLY, reason: 'insert/delete scoped to caller\'s own id' },
      'GET /api/oauth/accounts': { category: CATEGORY.SELF_ONLY, reason: 'WHERE user_id = caller' },
      'POST /api/oauth/disconnect': { category: CATEGORY.SELF_ONLY, reason: 'delete scoped to caller\'s own id; behind requireAAL2(\'oauth.unlink\') with the provider bound, mirroring /api/oauth/link — removing a credential is a credential change (v1.2b audit F-2). The last-credential guard is checked BEFORE the grant is spent' },
      /**
       * Newly authenticated in v1.2b Task 6 — it was an UNauthenticated route
       * whose only tie to an account was a 15-minute link token naming a
       * `userId`, proved by that account's password. The password is gone, so the
       * session is what ties the two together: the handler refuses with 403
       * unless `decoded.userId === req.user.id`, and the insert is written
       * against `req.user.id`. Without that comparison the grant of one account
       * would attach a provider identity to another's.
       */
      'POST /api/oauth/link': { category: CATEGORY.SELF_ONLY, reason: 'link token must name the caller (403 otherwise, oauthRoutes.js); the oauth_accounts insert is scoped to req.user.id, and the route is behind requireAAL2(\'oauth.link\') with the provider bound' },
      'POST /api/privacy/export': { category: CATEGORY.SELF_ONLY, reason: 'insert scoped to caller\'s own id' },
      'GET /api/privacy/export/status': { category: CATEGORY.SELF_ONLY, reason: 'WHERE user_id = caller' },

      /**
       * ── The Organizer Agreement (v1.2c) ──
       *
       * Both read and write only the caller's own acceptance rows, and both are
       * deliberately reachable by an organizer who currently holds NO capability
       * that touches a student — that withheld state is precisely what these two
       * routes exist to let them escape. Gating them on a capability would gate
       * them on the thing the agreement grants, which is a lockout: the only
       * action that restores the account would be unreachable from it.
       *
       * The status route is open to every authenticated role rather than
       * organizer-only, because the client asks it on load to decide whether to
       * show the interstitial. A student gets `required: false`; answering 403
       * would make "no agreement needed" indistinguishable from "the request
       * failed".
       */
      'GET /api/legal/organizer-agreement': { category: CATEGORY.OPEN_TO_AUTHENTICATED, reason: 'reads only the caller\'s own acceptance state (organizerAgreementStatus scoped to req.user.id); every role may ask, and a non-organizer gets required:false rather than a refusal' },
      'POST /api/legal/organizer-agreement/accept': { category: CATEGORY.SELF_ONLY, reason: 'writes acceptance rows for req.user.id only; refuses a non-organizer with 400 rather than recording a false acceptance, and must stay reachable while the organizer\'s student-facing capabilities are withheld (accountRoutes.js)' },
      'GET /api/privacy/export/download/:id': { category: CATEGORY.SELF_ONLY, reason: 'job.user_id !== caller -> 404 (always the caller\'s own export job); behind requireAAL2(\'data.download\') with the jobId bound — this is where the archive actually leaves, and gating only the request left a completed one behind a bare session for seven days (v1.2b audit F-1)' },

      /**
       * ── The four step-up endpoints (v1.2b Task 5) ──
       *
       * Read against their handlers one at a time, not declared as a block.
       * Every one of them takes its user from `req.user.id` and never from the
       * request, and every reauth.js entry point they call is scoped by
       * `user_id` inside the module (see `load()` there), so another user's
       * challenge id is indistinguishable from one that does not exist.
       *
       * None of them can carry a capabilityGate, and that is not an omission:
       * these are the routes that MINT assurance. A capability answers "may
       * this kind of actor ever do X"; the action being verified for is a
       * parameter here, and its capability gate belongs on the endpoint that
       * performs the action (Task 6), before its own `requireAAL2`. Gating
       * these on a capability would mean either inventing one every role holds
       * — a gate that discriminates against nobody, which
       * GET /api/organizers/:id/profile below records as the wrong answer — or
       * denying some role the ability to re-prove its own identity.
       */
      'POST /api/auth/reauth/challenge': { category: CATEGORY.SELF_ONLY, reason: 'opens a challenge for req.user.id only; openChallenge binds user_id, and the caller cannot name another account' },
      'POST /api/auth/reauth/password': { category: CATEGORY.SELF_ONLY, reason: 'grantByPassword is scoped to (challengeId, req.user.id) and re-checks the caller\'s own password_hash; a stranger\'s challenge id reads as not_found' },
      'GET /api/auth/reauth/oauth/:provider': { category: CATEGORY.SELF_ONLY, reason: 'peeks the caller\'s own challenge (scoped by user_id) and signs a state bound to req.user.id and this session; writes nothing' },
      'POST /api/auth/reauth/oauth/:provider/callback': { category: CATEGORY.SELF_ONLY, reason: 'requires a state minted for req.user.id and this session\'s jti, then grantByOAuth matches the provider sub against the caller\'s own oauth_accounts row' },

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

  // ── Guard 4 ──────────────────────────────────────────────────────────────
  describe('every requireAAL2 argument is a registered sensitive action', () => {
    /**
     * Why this guard exists at all.
     *
     * `requireAAL2` cannot validate its own argument. Doing so would mean
     * importing `sensitiveActions.js` into `authz.js`, which would cost that
     * module the zero-imports property `authz.test.js` asserts and which is
     * what lets `src/authz.js` mirror the capability table into the client
     * bundle. So the check moved out here, and the plan (Task 4, Step 3) says
     * so explicitly: "validate `action` against the registry at the CALL SITE
     * in route files rather than importing sensitiveActions.js here".
     *
     * The failure it catches is silent and permanent. `requireAAL2` compares
     * its action against `principal.aalAction`, which `authenticateToken`
     * resolves from a stored challenge — and a challenge can only ever hold a
     * registered action, because `openChallenge` refuses anything else. So a
     * misspelled gate (`requireAAL2('acount.delete')`) can never match any
     * grant: the route 403s with `reauth_required` for every caller, for ever,
     * and the client loops round the verification modal it was just told to
     * open. No unit test of the route sees it unless that test drives a real
     * grant through, and no type system here would catch it.
     *
     * Non-literal arguments are refused for the same reason. `requireAAL2(x)`
     * is unverifiable from source, and the whole value of this guard is that
     * the answer is knowable at build time rather than at 403 time.
     */

    /**
     * The detector (hoisted to module scope, shared with Guard 5), proved
     * against injected bugs.
     *
     * This runs first and deliberately does not touch the repository. When it
     * was written there were ZERO `requireAAL2` call sites in server/ — the
     * gates arrived with Task 6 — so the scan below would have passed over an
     * empty set and reported success while checking nothing. A guard that cannot
     * be shown to fire is not a guard; these fixtures are what made the next
     * test meaningful before its subject existed, and what keep it honest now
     * that the subject could be deleted.
     */
    it('fires on a misspelled action, a non-literal argument, and nothing else', () => {
      const good = findRequireAAL2CallSites(
        "router.delete('/api/auth/account', authenticateToken, requireAAL2('account.delete'), handler);"
      );
      expect(good).toHaveLength(1);
      expect(good[0].action).toBe('account.delete');
      expect(good[0].isLiteral).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, good[0].action)).toBe(true);

      // One character off. This is the bug.
      const typo = findRequireAAL2CallSites("router.post('/x', requireAAL2('acount.delete'), h);");
      expect(typo[0].isLiteral).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, typo[0].action)).toBe(false);

      // Unverifiable from source.
      const variable = findRequireAAL2CallSites('router.post("/x", requireAAL2(action), h);');
      expect(variable[0].isLiteral).toBe(false);
      expect(variable[0].raw).toBe('action');

      // The declaration in authz.js is not a call site…
      expect(findRequireAAL2CallSites('export function requireAAL2(action) {')).toEqual([]);
      // …and neither is a comment mentioning one.
      expect(findRequireAAL2CallSites(" * gated by requireAAL2('made.up.action')")).toEqual([]);
      // Double quotes and backticks count exactly the same as single ones.
      expect(findRequireAAL2CallSites('requireAAL2("email.change")')[0].action).toBe('email.change');
      expect(findRequireAAL2CallSites('requireAAL2(`email.change`)')[0].action).toBe('email.change');
    });

    it('finds no unregistered or non-literal action anywhere in server/', () => {
      const files = collectServerJsFiles();
      expect(files.length, 'the server/ walk found no modules to scan').toBeGreaterThan(0);

      const offenders = [];
      for (const { url, key } of files) {
        for (const site of findRequireAAL2CallSites(readFileSync(url, 'utf8'))) {
          if (!site.isLiteral) {
            offenders.push(
              `${key}:${site.line}: requireAAL2(${site.raw}) — the action must be a string literal, `
              + 'so that it can be checked against SENSITIVE_ACTIONS here rather than 403ing for ever in production.'
            );
          } else if (!Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, site.action)) {
            offenders.push(
              `${key}:${site.line}: requireAAL2('${site.action}') is not a key of SENSITIVE_ACTIONS. `
              + `Known actions: ${Object.keys(SENSITIVE_ACTIONS).sort().join(', ')}. `
              + 'An unregistered action can never match a stored grant, so this route would 403 every caller for ever.'
            );
          }
        }
      }

      expect(offenders, 'requireAAL2 gate(s) naming an action the registry does not know').toEqual([]);
    });
  });

  // ── Guard 5 ──────────────────────────────────────────────────────────────
  describe('every requireAAL2 gate is paired with a spendChallenge for the same action', () => {
    /**
     * Why this guard exists.
     *
     * `requireAAL2` is an early refusal, NOT the check. It asks `peekChallenge`
     * whether the presented grant is live and reads `principal.aalAction`; it
     * changes nothing. The property that makes step-up worth having — a grant is
     * spendable ONCE, for THESE arguments — comes from `consumeChallenge` running
     * inside the handler's transaction. A route that gates and never spends
     * leaves the grant live for its remaining five minutes: the same challenge id
     * re-presented performs the action again, and again, which is precisely the
     * replay the single-use rule exists to stop.
     *
     * That omission is invisible. Every functional test of such a route passes —
     * the happy path works, the gate refuses an unverified caller, the action
     * happens. Only a test that deliberately replays the same id notices, and a
     * test nobody wrote is a test nobody misses. So the pairing is checked
     * statically, per file and per action, in the same place the gate's argument
     * is checked.
     *
     * Per-file rather than per-handler is a deliberate limit, named here so it is
     * not mistaken for completeness: this proves that a file gating on
     * `email.change` also spends `email.change` somewhere in itself. Two routes
     * in one file gating the same action, one of which spends, would satisfy it.
     * No such case exists (each of the five actions has exactly one performing
     * endpoint) and a per-handler walk would need a real parser; the honest scope
     * is "the gate and the spend live together", which is what catches the
     * mistake this is about — adding a gate and forgetting the spend entirely.
     */

    /** `spendChallenge(db, req, '<action>', …)` call sites in one source file. */
    function findSpendCallSites(src) {
      const found = [];
      stripComments(src).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/\bspendChallenge\s*\(\s*db\s*,\s*req\s*,\s*(['"`])([^'"`]*)\1/g)) {
          found.push({ line: i + 1, action: m[2] });
        }
      });
      return found;
    }

    /**
     * The detector, proved against the bug rather than read.
     *
     * Three role checks got past Guard 1 on this branch by being spelled
     * differently, which is the argument for driving every detector in this file
     * with fixtures containing the exact defect.
     */
    it('recognises a spend, ignores comments, and does not match a different shape', () => {
      expect(findSpendCallSites("      spendChallenge(db, req, 'account.delete', {});")[0].action)
        .toBe('account.delete');
      // Whitespace and quote style must not matter.
      expect(findSpendCallSites('spendChallenge( db , req , "email.change" , { newEmail } )')[0].action)
        .toBe('email.change');
      expect(findSpendCallSites('spendChallenge(db, req, `oauth.link`, { provider })')[0].action)
        .toBe('oauth.link');
      // Prose about spending is not spending.
      expect(findSpendCallSites(" * calls spendChallenge(db, req, 'data.export', {}) below")).toEqual([]);
      // A call that does not pass the request cannot carry the three bindings,
      // so it must not be counted as one.
      expect(findSpendCallSites("spendChallenge(db, { id: 'x' }, 'data.export', {})")).toEqual([]);
    });

    it('finds no gated action left unspent anywhere in server/', () => {
      const files = collectServerJsFiles();
      expect(files.length, 'the server/ walk found no modules to scan').toBeGreaterThan(0);

      const offenders = [];
      const gatedActions = new Set();
      for (const { url, key } of files) {
        const src = readFileSync(url, 'utf8');
        const gates = findRequireAAL2CallSites(src);
        if (gates.length === 0) continue;

        const spent = new Set(findSpendCallSites(src).map(s => s.action));
        for (const gate of gates) {
          if (!gate.isLiteral) continue; // Guard 4's complaint, not this one's.
          gatedActions.add(gate.action);
          if (!spent.has(gate.action)) {
            offenders.push(
              `${key}:${gate.line}: requireAAL2('${gate.action}') with no `
              + `spendChallenge(db, req, '${gate.action}', …) in the same file. `
              + 'The gate is an early refusal, not the check — without the spend the grant '
              + 'stays live for its full five minutes and the action can be replayed with '
              + 'the same challenge id. Spend it inside the handler\'s own transaction.'
            );
          }
        }
      }

      expect(offenders, 'requireAAL2 gate(s) that never spend the grant they check').toEqual([]);

      /**
       * And every registered action is gated somewhere.
       *
       * The registry is the enumeration of what step-up protects, so an entry
       * with no gate is an action the table claims to cover and nothing enforces
       * — the silent-omission failure `sensitiveActions.js` exists to prevent,
       * reappearing one row at a time. It also stops this whole guard from
       * passing over an empty set, which is how a scan reports success while
       * checking nothing.
       */
      expect(
        [...Object.keys(SENSITIVE_ACTIONS)].filter(a => !gatedActions.has(a)),
        'registered sensitive action(s) with no requireAAL2 gate on any route'
      ).toEqual([]);
    });
  });

  // ── Guard 6 ──────────────────────────────────────────────────────────────
  describe('every direct consumeChallenge call is declared', () => {
    /**
     * Why Guard 5 is not enough on its own.
     *
     * Guard 5 pairs a `requireAAL2` gate with a `spendChallenge(db, req, …)` in
     * the same file, and `spendChallenge` is the only shape it knows. That shape
     * requires an authenticated `req` carrying the challenge id, the user and the
     * session jti — which is right for the five gated routes and wrong for one
     * place: the `auto_linked` branch of the OAuth callback (v1.2b Task 6b). That
     * handler is reached mid-redirect with no session on the request at all; its
     * bindings arrive inside the signed OAuth state, so it calls
     * `consumeChallenge` directly.
     *
     * The consequence, recorded as TD-16 before this guard existed: that spend
     * was invisible to Guard 5, and `oauthRoutes.js` passed only because
     * `/api/oauth/link` separately contained a conforming one. Deleting the
     * auto-link spend would have left the grant replayable with the suite green.
     *
     * So direct calls are enumerated rather than banned. Banning them would
     * force the one legitimate case into a contortion; allowing them silently is
     * what TD-16 was. A new direct call has to be added here, which is the
     * moment someone has to justify it — the same mechanism `ROUTE_REGISTRY`
     * uses for a route with no capability gate.
     */
    const DECLARED_DIRECT_CONSUMERS = Object.freeze({
      'server/reauthResponses.js': {
        reason: 'the implementation of spendChallenge itself — the shape every '
          + 'other caller is supposed to use',
      },
      'server/routes/oauthRoutes.js': {
        reason: "the auto_linked branch of POST /api/oauth/:provider/callback. The "
          + 'callback is unauthenticated (it also serves login and signup), so there '
          + 'is no req.reauthChallengeId or req.sessionJti to read — the challenge id '
          + 'and jti come from the signed state that /url folded them into. Covered '
          + 'functionally by routes.oauth.test.js, "spends the grant, so the same '
          + 'verification cannot link twice".',
      },
    });

    /** `consumeChallenge(` call sites, excluding its own declaration. */
    function findDirectConsumeCallSites(src) {
      const found = [];
      stripComments(src).split('\n').forEach((line, i) => {
        // `export function consumeChallenge(` in reauth.js is the definition.
        if (/\bfunction\s+consumeChallenge\s*\(/.test(line)) return;
        for (const _m of line.matchAll(/\bconsumeChallenge\s*\(/g)) {
          found.push({ line: i + 1 });
        }
      });
      return found;
    }

    it('fires on an undeclared direct call, and ignores the definition and prose', () => {
      expect(findDirectConsumeCallSites('  const spent = consumeChallenge({')).toHaveLength(1);
      expect(findDirectConsumeCallSites('export function consumeChallenge({ db, challengeId })')).toEqual([]);
      expect(findDirectConsumeCallSites(' * calls consumeChallenge() inside the transaction')).toEqual([]);
      expect(findDirectConsumeCallSites('// consumeChallenge(x) would be wrong here')).toEqual([]);
    });

    it('finds no undeclared direct consumeChallenge anywhere in server/', () => {
      const files = collectServerJsFiles();
      expect(files.length, 'the server/ walk found no modules to scan').toBeGreaterThan(0);

      const offenders = [];
      const seen = new Set();

      for (const { url, key } of files) {
        // reauth.js defines the function and legitimately references it in its
        // own module; the definition is filtered by the detector, and it has no
        // call of its own.
        if (key === 'server/reauth.js') continue;

        const sites = findDirectConsumeCallSites(readFileSync(url, 'utf8'));
        if (sites.length === 0) continue;

        if (Object.prototype.hasOwnProperty.call(DECLARED_DIRECT_CONSUMERS, key)) {
          seen.add(key);
          continue;
        }
        offenders.push(
          `${key}:${sites[0].line}: calls consumeChallenge() directly. Prefer `
          + 'spendChallenge(db, req, action, params), which reads the three bindings off the '
          + 'request so a caller cannot pick up two of three — and which Guard 5 can see. '
          + 'If this call site genuinely has no authenticated request (the OAuth callback is '
          + 'the only such case today), add it to DECLARED_DIRECT_CONSUMERS with the reason '
          + 'and a note on what covers it functionally.'
        );
      }

      expect(offenders, 'undeclared direct consumeChallenge call(s)').toEqual([]);

      // Stale declarations fail too, exactly as ROUTE_REGISTRY's do: an entry for
      // a file that no longer consumes directly is a justification for something
      // that is not happening, and reading it later would mislead.
      expect(
        Object.keys(DECLARED_DIRECT_CONSUMERS).filter(k => !seen.has(k)),
        'DECLARED_DIRECT_CONSUMERS entries that no longer match anything — remove them'
      ).toEqual([]);
    });
  });
});
