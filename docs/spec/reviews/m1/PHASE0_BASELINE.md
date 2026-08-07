# Phase 0 — Baseline

**Date:** 2026-08-06
**Commit:** `4f8b6d6`
**Working tree:** clean before and after. **No source file modified in Phase 0.**

---

## Gate results

| Gate | Result | Detail |
|---|---|---|
| `npm ci` | **PASS** | Installed from the root lockfile. 2 high-severity advisories (below) |
| `npm test` | **PASS** | **194 test files · 3,163 tests · 0 failures · 0 unhandled errors** |
| `npm run lint` | **PASS** | oxlint, exit 0, no warnings emitted |
| `npm run build` | **PASS** | exit 0, built in 492 ms |

Gates were run in the order Volume I §1.3.4 requires: `ci` → `test` → `build` → `lint`.
`npm ci` is first because it is the only gate that validates the lockfile; the others
measure an installed tree and are meaningless if the install is wrong.

## Bundle baseline

| Chunk | Raw | Gzip |
|---|---:|---:|
| `index` (main) | 373.32 kB | 117.00 kB |
| `LeafletMap` | 154.31 kB | 45.38 kB |
| `EventModal` | 68.87 kB | 17.34 kB |
| `Settings` | 46.52 kB | 12.62 kB |

Any M1 work that grows the main chunk materially should be questioned: the audit
explorer is a routed screen and must be lazily loaded like every other.

## Dependency advisories

**2 high severity.** Both are the known `react-router` RSC-mode advisory, previously
assessed and recorded as **not exploitable in this configuration**: the application is a
client-only SPA using `BrowserRouter`, imports no server-side router API anywhere, and the
server deliberately never loads the library. The only offered remedy is a breaking
downgrade. Recommendation unchanged: do not downgrade.

No new advisory has appeared since the last assessment.

## Known live defect carried into M1

**The `ACCOUNT_SUSPENDED` notification coverage regression is still present.** Re-verified
at Phase 0 rather than assumed, per Rule 1:

```
scanner sees: ORGANIZER_APPROVED, ACCOUNT_REINSTATED, ACCOUNT_WARNED
ACCOUNT_SUSPENDED visible? false
```

This is the notice a suspended minor receives, carrying the reason and the appeal link. It
is the first code task in the approved M1 plan.

## Baseline commit

No baseline commit was created. The working tree was already clean at `4f8b6d6`, so that
commit **is** the baseline. Creating an empty commit to mark it would add a commit that
records nothing.

## Comparison target

Any post-implementation report compares against:

- **194 test files**
- **3,163 tests**
- **0 failures**
- **373.32 kB / 117.00 kB gzip** main chunk
- **2 high advisories**, both assessed inapplicable
