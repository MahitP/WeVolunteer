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

## Carry-forward findings (not in this plan — for the P1 plan / final review)
- ReportModal.jsx:15 calls api.post('/reports', ...) which does not exist on the
  api object. Report/moderation submission is dead at runtime. Found by Task 1 reviewer.
