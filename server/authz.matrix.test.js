import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Routes x roles, generated.
 *
 * The bug this exists to catch: authorization used to be ~54 copies of
 * `req.user.role !== 'admin'` (or similar single-role compares) spread across
 * 9 route files, so adding a role silently DENIED it everywhere
 * ('super_admin' !== 'admin' is true) and no test noticed. A hand-written test
 * per route would have the same blind spot, because nobody writes the case they
 * did not think of. Generating the cross product removes the choice.
 *
 * EXPECTED is the authorization contract AS IT EXISTS TODAY, on commit 1883858,
 * before Tasks 7a-7d convert every route to `requireCap`. Some rows deliberately
 * record known-wrong behaviour (see BUG() below) so the conversion that fixes
 * them turns a red `it.fails()` green, which is the signal that row's TODO is
 * done. Changing a value here that is NOT wrapped in BUG() is a deliberate
 * decision that must be justified in the PR description — it means today's
 * behaviour is changing, not just being recorded.
 *
 * ── Conventions used below ──
 *
 * 'allow' means "not 401/403" — the request reached the handler. Using the
 * real status would make this table a test of business logic (404s for
 * missing fixture ids, 400s for missing request bodies) instead of a test of
 * authorization.
 *
 * BUG(expected, task) marks a cell where today's status is wrong and Task
 * `task` (7a/7b/7c/7d, per capability-mapping.md) is expected to fix it. The
 * test for that cell is registered with `it.fails()`, so the suite is green
 * today and turns red — loudly, as a regression — the moment the fix lands,
 * which is exactly the cue to delete the wrapper.
 *
 * Route parameters: most rows use a REAL seeded id (event-softball, owned by
 * user-org-1 / the organizer fixture; cmt-1 and ann-1, also on event-softball)
 * so an ownership-style gate is actually exercised rather than short-circuited
 * by a 404 before authorization ever runs. Rows where the top-level check is a
 * plain role compare that happens BEFORE any db lookup use a FAKE id
 * ('event-fake-000' etc.) instead, since a 404 there still proves the role
 * gate was reached and is cheaper than seeding more fixtures. Each row is
 * commented with which convention it uses when it is not obvious.
 *
 * Mutating routes that use event-softball / cmt-1 / ann-1 are read-only in
 * effect for the roles expected to be denied, but the roles expected to
 * succeed DO mutate the fixture (e.g. DELETE actually deletes it). Three rows
 * — the two content deletes and the final event delete — have a real ordering
 * hazard from this: if the deleting role's request runs BEFORE a
 * denied-role's request in the same row, the resource disappears and the
 * denied role would see 404 (still 'allow'!) instead of the true 403,
 * corrupting the very bug this file exists to record. Those three rows
 * deliberately list roles in a non-canonical order (denied roles first) to
 * avoid it; every other row uses the canonical ROLES order for readability.
 * DELETE /api/events/:id is additionally kept as the LAST row in the whole
 * table, because deleting it cascades to event-softball's comments and
 * announcements, which earlier rows (cmt-1, ann-1) depend on existing.
 */

function BUG(expected, task) {
  return { __bug: true, expected, task };
}

let srv;
const tokens = {};
let originalFetch;

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();

  tokens.student   = await srv.login('leo.chen@example.com');
  tokens.organizer = await srv.login('jordan.whitfield@example.org');
  tokens.admin     = await srv.login('admin@example.gov');

  // super_admin and partner have no seeded fixture: promote a throwaway account
  // for each, then log in. Identity is re-derived per request from the users
  // row (see utils.js authenticateToken), so the role the database holds at
  // request time is the one that counts — no re-login needed after the UPDATE.
  const db = (await import('./db.js')).db;
  for (const [role, email] of [['super_admin', 'super@test.local'], ['partner', 'partner@test.local']]) {
    const signed = await srv.signupConfirmed({
      name: role, username: `matrix_${role}`, email, password: 'Password123', grade: 'Adult', role: 'student'
    });
    db.prepare('UPDATE users SET role = ?, verified = 1 WHERE email = ?').run(role, email);
    /* An administrator without a second factor is refused by `requireCap` before
       any capability is consulted, so a promoted fixture has to be enrolled or
       every row in the matrix reads 403 for reasons that have nothing to do with
       the capability under test. */
    const { enrolTwoFactor } = await import('./testServer.js');
    await enrolTwoFactor(db, email);
    tokens[role] = signed.cookie;
  }

  // GET /api/geocode proxies to Nominatim over the real network. Mocked here
  // exactly the way routes.geocode.test.js does it, so this file never depends
  // on internet access or eats the 5s upstream timeout for every denied role.
  originalFetch = global.fetch;
  global.fetch = vi.fn(async (url, init) => {
    if (typeof url === 'string' && url.includes('nominatim')) {
      return {
        ok: true,
        json: () => Promise.resolve([{
          name: 'Library', display_name: 'Library, Main Street, Springfield',
          lat: '40.0', lon: '-74.0',
          address: { road: 'Main Street', city: 'Springfield', state: 'IL' }
        }])
      };
    }
    return originalFetch(url, init);
  });
}, 120000);

afterAll(async () => {
  global.fetch = originalFetch;
  await srv?.close();
});

/**
 * [method, path, { role: expectedStatus }, options?]
 *
 * options.body   — request body for routes whose authorization check runs
 *                   AFTER a body-presence check, so an empty body would 400
 *                   every role identically and the row would test nothing.
 * options.public — true for the one route with no authenticateToken at all;
 *                  excluded from the blanket "401 when unauthenticated" test.
 */
const EXPECTED = [
  // ── adminRoutes.js (8 routes, all admin-gated; Task 7a converts 2-8) ──

  // Already converted in Task 5 via requireCap('organizer.approve') — the one
  // row where super_admin is NOT a bug, because the fix already shipped.
  ['GET', '/api/admin/organizers/pending',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],

  // Real fixture id (user-org-pending: organizer, unverified) so the approve/
  // deny logic actually runs for the roles allowed to reach it.
  ['POST', '/api/admin/organizers/user-org-pending/approve',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],
  ['POST', '/api/admin/organizers/user-org-pending/deny',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],

  ['GET', '/api/admin/stats',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],
  ['GET', '/api/admin/reports',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],
  // Fake report id: role gate runs before the body-shape check, which runs
  // before any db lookup, so no real report is needed to reach either gate.
  ['PATCH', '/api/admin/reports/rep-fake-000',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],
  ['GET', '/api/admin/reports/export',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],
  ['GET', '/api/admin/system/status',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],

  // ── attendanceRoutes.js (Task 7b) ──

  // Fake event id: `role !== organizer && role !== admin` is checked before any
  // db lookup, so the role gate is fully exercised without touching a fixture.
  ['POST', '/api/events/event-fake-000/checkin',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  // Real event-softball id: converted to `attendance.view` (Task 7b), which
  // corrects the pre-existing "a partner would pass" inconsistency — student
  // and partner are now both denied; organizer (via ownership) and admin
  // (via the capability) are unaffected.
  ['GET', '/api/events/event-softball/checkin',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  // Fake event id: role gate (`role !== organizer`) runs before the body
  // check and before any db lookup. Task 7b's deliberate correction widens
  // `attendance.mark` to admin as a conscious choice — admin now reaches the
  // handler and 400s on the missing body, same as organizer.
  ['POST', '/api/events/event-fake-000/attendance',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  ['GET', '/api/events/event-fake-000/roster.csv',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  // Self-scoped, no role check of any kind today — every authenticated role
  // gets its own (possibly empty) certificate list.
  ['GET', '/api/certificates',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  // Explicitly public: no authenticateToken at all. A fake code 404s, which is
  // fine — the point of this row is that it must never become 401/403.
  ['GET', '/api/certificates/verify/ZZZZZZ',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' },
    { public: true }],

  // ── applicationRoutes.js (Task 7b) ──

  // Result scoping, not a gate (inventory: "student sees own, organizer sees
  // own events'"): admin/super_admin/partner all fall through to the
  // unscoped branch and get 200. Brief's original guess (partner: 403) was
  // wrong; corrected here to match reality.
  ['GET', '/api/applications',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  ['POST', '/api/events/event-fake-000/apply',
    { student: 'allow', organizer: 403, admin: 403, super_admin: 'allow', partner: 403 }],

  // Real seeded application (app-sb-10, pending, on event-softball which the
  // organizer fixture hosts) AND a real body. Both are required: with no body
  // this 400s on the applicationIds check before the per-row ownership check
  // ever runs, and with a fake id it 404s — either way the row would record
  // 'allow' for a role that a real request might deny, which is precisely the
  // masking that hid the admin lockout on the sibling route below.
  //
  // admin is 'allow' as of the v1.2a ownership-bypass fix: it holds
  // `event.moderate`, not `applicant.review`, so before that fix it was denied
  // outright. See CHANGELOG.md — deliberate behaviour change.
  ['PATCH', '/api/applications/bulk',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 },
    { body: { applicationIds: ['app-sb-10'], status: 'waitlisted' } }],

  // Real seeded application id + body, for the same reason.
  //
  // This row used to read `PATCH /api/applications/app-fake-000` with no body
  // and record super_admin: 'allow' — and it PASSED, because the missing
  // `status` field 400s at the top of the management branch before the db read
  // and before the ownership check. The fake id and absent body together hid a
  // real lockout: super_admin satisfied `applicant.review` through the wildcard,
  // entered the organizer branch, and was then denied on any application whose
  // event it did not host. admin, holding neither `applicant.review` nor
  // `application.withdraw`, fell through to the final explicit 403. Neither
  // admin-tier role could accept, waitlist or reject an application anywhere.
  //
  // Now exercised against a real row: `student` 403s (may only withdraw its
  // own), `partner` 403s at the middleware gate, and both admin tiers reach
  // the handler through `event.moderate`.
  ['PATCH', '/api/applications/app-sb-10',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 },
    { body: { status: 'waitlisted' } }],

  // ── eventRoutes.js (Task 7c) ──

  // No role check anywhere in this handler — scoping only (canSeeInstructions
  // only affects one field's content). Brief's guess (partner: 403) was
  // wrong; corrected here.
  ['GET', '/api/events',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  // Real event-softball id (owned by the organizer fixture) so `isStaff`
  // actually discriminates instead of always 404ing.
  ['GET', '/api/events/event-softball',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  ['POST', '/api/events',
    // admin has no `event.create` in the target table either — 403 is
    // permanent, not a bug.
    { student: 403, organizer: 'allow', admin: 403, super_admin: 'allow', partner: 403 }],

  ['PUT', '/api/events/event-fake-000',
    { student: 403, organizer: 'allow', admin: 403, super_admin: 'allow', partner: 403 }],

  ['POST', '/api/events/event-fake-000/auto-approve',
    { student: 403, organizer: 'allow', admin: 403, super_admin: 'allow', partner: 403 }],

  ['PATCH', '/api/events/event-fake-000',
    { student: 403, organizer: 'allow', admin: 403, super_admin: 'allow', partner: 403 }],

  // Body supplies a valid `status` so the check inside this handler that
  // already allows organizer-or-admin (unlike most of its siblings, which are
  // organizer-only) is genuinely exercised rather than short-circuited.
  ['PATCH', '/api/events/event-fake-000/status',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 },
    { body: { status: 'closed' } }],

  ['POST', '/api/events/event-fake-000/duplicate',
    { student: 403, organizer: 'allow', admin: 403, super_admin: 'allow', partner: 403 }],

  // Real event-softball id: no top-level role gate at all in this handler —
  // existence is checked first, then `role !== 'admin' && !owner`, so a fake
  // id would 404 every role identically and prove nothing.
  ['GET', '/api/events/event-softball/auto-select/runs',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  ['POST', '/api/events/event-fake-000/auto-select/run',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  ['POST', '/api/events/event-fake-000/auto-select/confirm',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  // Real event-softball id AND a body: this handler validates `subject`/
  // `message` BEFORE checking ownership, so an empty body would 400 every
  // role identically and the row would test nothing about authorization.
  ['POST', '/api/events/event-softball/broadcast',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 },
    { body: { subject: 'Update', message: 'Heads up about the event.' } }],

  // No role or ownership check of any kind today (confirmed by reading the
  // handler) — authenticated only. capability-mapping.md's own Task 7c notes
  // flag this exact route for verification; recorded here as fully open so a
  // future partner-lockout (event.view, once added) shows up as a diff.
  ['GET', '/api/events/event-fake-000/slots/slot-fake-000/ics',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  // ── contentRoutes.js (Task 7d) ──

  // Real cmt-1 (authored by the organizer fixture on event-softball). Roles
  // ordered denied-first: whichever of organizer/admin runs would actually
  // DELETE the comment, and a later 404 still reads as 'allow' — but if that
  // happened before student/partner/super_admin ran, their true 403 would be
  // masked as a 404 (also 'allow'), silently erasing the super_admin bug this
  // file exists to catch. Denied roles first avoids that entirely.
  ['DELETE', '/api/comments/cmt-1',
    { student: 403, partner: 403, super_admin: 'allow', organizer: 'allow', admin: 'allow' }],

  // Real event-softball id + body: ownership check happens after the
  // body-presence check, so a real body is required to reach it.
  ['POST', '/api/events/event-softball/announcements',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 },
    { body: { body: 'Reminder: arrive 15 minutes early.' } }],

  // Real ann-1 (authored by the organizer fixture) + body. PATCH does not
  // delete the row, so no reordering hazard here.
  ['PATCH', '/api/announcements/ann-1',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 },
    { body: { body: 'Updated: arrive 20 minutes early.' } }],

  // Same reordering hazard and same fix as the comment delete above.
  ['DELETE', '/api/announcements/ann-1',
    { student: 403, partner: 403, super_admin: 'allow', organizer: 'allow', admin: 'allow' }],

  ['GET', '/api/stats/volunteer',
    // organizer is genuinely unreachable today (role !== 'student' blocks it
    // too) — 403 is correct now and, per capability-mapping.md's own
    // instruction to "check before assuming", stays correct after conversion.
    { student: 'allow', organizer: 403, admin: 403, super_admin: 'allow', partner: 403 }],

  ['GET', '/api/stats/organizer',
    // admin was denied before Task 7d; capability-mapping.md's new
    // `analytics.own_events` capability deliberately grants it to admin too —
    // a considered widening (like attendanceRoutes.js:62's attendance.mark
    // correction), not a bug. Recorded as its POST-conversion value directly,
    // per this file's own docstring on editing non-BUG() cells for a
    // deliberate behaviour change; see CHANGELOG.md.
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  // ── messageRoutes.js (Task 7d) ──
  //
  // Result scoping, not a gate: `student` gets one query, `organizer`/`admin`
  // get another, and anything else (super_admin, partner) falls through both
  // branches to the default `rows = []` — still a 200, never a 403. Confirmed
  // by reading the handler (server/routes/messageRoutes.js:352-386): there is
  // no `else` branch and no denial of any kind. Recorded as all-'allow',
  // which is still a real baseline — Task 7d converts these role branches to
  // `can(p, 'applicant.review')`-style checks, and if that conversion ever
  // turns this into an actual gate for some role, this row is what would
  // catch it as a diff.
  ['GET', '/api/messages/users/search?q=le',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  // ── userRoutes.js (Task 7d) ──

  // `canSeeContact` only toggles which FIELDS are visible; the request itself is
  // now denied to a role without `directory.read`, which is partner and only
  // partner. That capability is withheld from partner deliberately (authz.js: a
  // partner is an EXTERNAL organization and this is a list of schoolchildren),
  // and every v1.3 directory route enforced it while this older route — name,
  // avatar, skills, credited hours, milestones, service counts — did not.
  // Real id so the response isn't a trivial 404 for everyone.
  ['GET', '/api/users/user-student-1/profile',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 403 }],

  ['GET', '/api/organizers/user-org-1/profile',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  ['PATCH', '/api/auth/profile',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  ['GET', '/api/user/preferences',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  ['POST', '/api/user/preferences',
    { student: 'allow', organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' },
    { body: { category: 'test_category', channel: 'email', enabled: true } }],

  // ── geocodeRoutes.js (Task 7d) ──

  ['GET', '/api/geocode?q=main+st',
    { student: 403, organizer: 'allow', admin: 'allow', super_admin: 'allow', partner: 'allow' }],

  // ── errorRoutes.js (v1.2c Task 7) ──
  //
  // `error.read` and `error.write` are SUPER_ONLY, so `admin` is denied here
  // alongside every other role — the one place in this table where a school
  // admin is refused something. That is the design: these endpoints return
  // redacted stack traces and internal structure, and `can()` refuses a
  // SUPER_ONLY capability before it consults per-user grants, so no
  // `user_capabilities` row can reach them either.
  //
  // The unauthenticated intake (`POST /api/errors/report`) is deliberately NOT
  // in this table: it carries no authenticateToken, so the blanket
  // "401 when unauthenticated" assertion below does not apply to it.
  ['GET', '/api/errors',
    { student: 403, organizer: 403, admin: 403, super_admin: 'allow', partner: 403 }],
  ['GET', '/api/errors/summary',
    { student: 403, organizer: 403, admin: 403, super_admin: 'allow', partner: 403 }],
  // A fingerprint that does not exist: every gate runs before the lookup, so
  // the denied roles get 403 and super_admin reaches a 404 — which counts as
  // 'allow' here, because the row is testing the gate and not the lookup.
  ['GET', '/api/errors/no-such-fingerprint',
    { student: 403, organizer: 403, admin: 403, super_admin: 404, partner: 403 }],
  ['PATCH', '/api/errors/no-such-fingerprint',
    { student: 403, organizer: 403, admin: 403, super_admin: 404, partner: 403 },
    { body: { status: 'resolved' } }],

  // ── impactRoutes.js ──
  //
  // `analytics.impact` was held by student, organizer, admin AND partner, so this
  // row read all-'allow' for every signed-in role. It is now an administrative
  // capability: the community figures are an internal view of how the programme
  // is doing (the reason `/api/public/impact` was deleted rather than re-gated),
  // and "how much did this school's children do" is a management question. The
  // three 403s are the policy, asserted at the layer that enforces it — the nav
  // entry and the client route are hidden by the same word, and neither is a
  // boundary.
  ['GET', '/api/impact',
    { student: 403, organizer: 403, admin: 'allow', super_admin: 'allow', partner: 403 }],

  // ── eventRoutes.js, continued: kept LAST in the whole table ──
  //
  // Real event-softball id, denied-roles-first ordering (same hazard as the
  // content deletes above) — AND placed after every other row in this file,
  // because a successful delete cascades to event-softball's comments and
  // announcements, which the two content-delete rows above (cmt-1, ann-1)
  // depend on still existing.
  ['DELETE', '/api/events/event-softball',
    { student: 403, partner: 403, super_admin: 'allow', organizer: 'allow', admin: 'allow' }]
];

describe('authorization matrix', () => {
  it('rejects every listed route with 401 when unauthenticated', async () => {
    for (const [method, path, , opts] of EXPECTED) {
      if (opts?.public) continue;
      const res = await srv.call(method, path);
      expect(res.status, `${method} ${path} unauthenticated`).toBe(401);
    }
  });

  for (const [method, path, expectations, opts] of EXPECTED) {
    describe(`${method} ${path}`, () => {
      for (const [role, cell] of Object.entries(expectations)) {
        const isBug = cell !== null && typeof cell === 'object' && cell.__bug;
        const expected = isBug ? cell.expected : cell;
        const label = isBug
          ? `${role} -> ${expected} (TODO Task ${cell.task}: currently denied)`
          : `${role} -> ${expected}`;
        const runner = isBug ? it.fails : it;

        runner(label, async () => {
          const res = await srv.call(method, path, opts?.body, tokens[role]);
          if (expected === 'allow') {
            expect([401, 403], `${role} was denied ${method} ${path} (status ${res.status})`).not.toContain(res.status);
          } else {
            expect(res.status, `${role} on ${method} ${path}`).toBe(expected);
          }
        });
      }
    });
  }
});
