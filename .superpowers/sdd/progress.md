# SDD Progress — P0 Launch Blockers

Plan: docs/superpowers/plans/2026-07-21-p0-launch-blockers.md
Branch: p0-launch-blockers
Base: 0d26da2

Task 1: complete (commits 0e7af78..d7a191b, review clean)
  - Build repaired. Also fixed ReportModal.jsx imports (react-feather -> lucide-react,
    ../api -> ../utils/api); reviewer empirically confirmed build-blocking.

Task 2: complete (commits d7a191b..965c920, review clean)
  - config.js/app.js/testServer.js split out; routes now testable. Both preserved
    P1 bugs (/health shadowing, error-handler order) verified intact.
  - Minor: harness mutates process.env; safe under Vitest per-file isolation.

Task 3: complete (commits 965c920..dace29d, review clean)
  - Seeding gated on DEMO_MODE; make-admin.mjs repaired. Deliberate-break test confirmed.

Task 4: complete (commits dace29d..7e28587, review clean)
  - emailVerified surfaced; app reachable. PLAN BUG FIXED: backfill moved to run
    after seedDatabase() (brief placed it before, so seeded users stayed 0).

Task 5: complete (commits 7e28587..ff0559b, review clean)
  - Password reset live. PLAN BUG FIXED: authLimiter cannot be imported into a
    router (circular); mounted by path in app.js instead. Plan updated for Task 6.
  - NOTE: commit 49f1710 is mislabelled docs: it swept in WIP code; net state reviewed OK.

Task 6: complete (commits b00afa8..7d153b3, review clean)
  - Email verification live behind REQUIRE_EMAIL_VERIFICATION (default off).
  - Interrupted mid-flight by session limit; finished in a second pass.

Task 7: complete (commits c2fc0e3..eebf6a0, review clean)
  - Withdraw stores withdrawn; re-application revives the row. Status audit also
    fixed CalendarView.jsx and EventModal.jsx mine-lookup (UI still blocked re-apply).

Task 8: complete (commits 2887966..a5846ea, review clean)
  - Username persisted + case-insensitive uniqueness. Breaking signup change; both
    callers verified. migrate_usernames.js backfilled 31 users.

## Carry-forward findings (not in this plan — for the P1 plan / final review)
- Test isolation relies on Vitest default isolate:true (no vitest.config.* exists).
  routes.verification.test.js runs flag-ON, routes.auth.test.js flag-OFF. Consider
  pinning isolate:true explicitly so a future config cannot silently break both.
- ReportModal.jsx:15 calls api.post('/reports', ...) which does not exist on the
  api object. Report/moderation submission is dead at runtime. Found by Task 1 reviewer.
