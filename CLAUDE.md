# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WeVolunteer — volunteer scheduling and service-hour tracking for schools. A single Node process serves a React SPA and a JSON API from one SQLite file. `README.md` covers the product; `docs/ENGINEERING_GUIDE.md` is the authoritative process document (git workflow, PR gates, release process, security rules, testing philosophy, technical-debt register) and **every rule in it is annotated with the incident that produced it** — read the reasoning there before overriding anything.

## Commands

```bash
npm run dev            # Vite (5173) + API (5050) together; seeds a demo DB on first boot
npm test               # full vitest suite (client + server projects)
npm run build          # production client build to dist/
npm run lint           # oxlint
```

Node 24.x is required, not recommended — the server uses `node:sqlite`. Both manifests pin `>=24.0.0 <25`.

Running a subset:

```bash
npx vitest run server/authz.test.js
```

```bash
npx vitest run --project=server
```

Other useful entry points:

```bash
npm run db:reset:dev -- --yes                      # destructive: deletes the dev DB file, re-seeds
npm run verify:hours --workspace=server            # ledger/attendance parity check, non-zero on mismatch
node bin/migration-checksums.mjs                   # prints checksums + ready-made UPDATE statements
bin/install-hooks.sh                               # required after clone — installs the pre-commit secret scan
```

`tests/e2e/` holds a Playwright spec, but `@playwright/test` is not in `package.json` and there is no npm script for it. It is not part of the normal loop.

### Dependency rules

**Always `npm install` from the repository root, never from inside `server/`.** `server` is an npm workspace: `/package-lock.json` is the only lockfile, and a nested one is invisible to root `npm ci` while looking authoritative. That exact mistake made `main` uninstallable for four days (ENGINEERING_GUIDE §5.4); CI now fails on any lockfile outside the root.

`npm ci` is the first of the four PR gates (`npm ci`, `npm test`, `npm run build`, `npm run lint`) and is the only one that validates the lockfile. Run it first — the other three measure nothing if the install is wrong.

## Architecture

### Backend (`server/`)

`server.js` (startup guards, listener, scheduler) → `app.js` (middleware order: compression → helmet → CORS on `/api` → json → rate limiters → 14 route modules → `/health` → static `dist/` + SPA fallback → error handler last).

Domain logic lives in modules, not route handlers: `attendance.js`, `hoursLedger.js`, `certificates.js`, `weighting.js` (Auto Select draw), `validation.js`, `eventQuery.js`. `config.js` is side-effect-free by design — that is what lets a route module be imported by a test without booting a listener or touching the production database.

In-process background work: `workers/notificationWorker.js`, `workers/exportWorker.js`, `services/autoSelectScheduler.js`, `realtime/socketServer.js`. `shutdown.js` drains all of them before closing the DB; `instanceLock.js` enforces one process per database.

### Authorization spine (`server/authz.js` + `src/authz.js`)

This is the most load-bearing module in the repo and it has strict rules:

- **Route files never compare a role string.** They ask for a named capability via `requireCap` / `requireCapAny`, or call `can(req.principal, '<cap>')`. `server/authz.completeness.test.js` enforces this with **six** build-failing guards: (1) no server-side role-string comparison in any spelling, (2) every authenticated route is behind a capability gate or a reviewed one-line justification, (3) the same scan over `src/`, (4) every `requireAAL2` argument is a registered sensitive action spelled as a literal, (5) every `requireAAL2` gate is paired with a `spendChallenge` for the same action and every registered action has a gate, (6) every direct `consumeChallenge` call is declared. Adding a route without a gate fails the build.
- **`super_admin` holds `'*'`,** so `can()` returns true for everything. A chain of `else if (can(...))` is therefore *not* mutually exclusive. Order branches **most-privileged-first**, and end every cascade in an **explicit deny**, never a bare `else`.
- `server/authz.js` imports nothing at all — no db, no config. Keep it that way; `src/authz.js` re-exports it into the client bundle so the two tables cannot drift. Client-side `can()` is UX only; every capability is re-checked server-side.
- Identity is re-read from the DB on every request (`buildPrincipal` in `server/utils.js`), never trusted from the JWT payload. `users.token_version` invalidates all sessions.

### Step-up re-authentication (`server/reauth.js` + `server/sensitiveActions.js`)

Added v1.2b. Seven actions cannot be performed on the strength of a session alone — `account.delete`, `password.change`, `email.change`, `oauth.link`, `oauth.unlink`, `data.export`, `data.download`. A grant is bound to one action, with its arguments, from one sign-in, for five minutes, once.

- **`requireAAL2('<action>')` is an early refusal, NOT the check.** The handler must also spend the grant with `spendChallenge(db, req, '<action>', params)` **inside its own transaction**, as the first statement, so the work and the spend are atomic in both directions. A gate with no spend leaves the grant replayable — and every functional test still passes. Guard 5 fails the build on it.
- **Params must be exactly the keys the registry binds** — no more (they are ignored) and no fewer (a missing key hashes as absent and will not match). Bind the value the handler is about to **write**, never the one the client claimed.
- **Answer every refusal before spending.** A request that delivers nothing must not cost a verification the user then has to repeat — least of all a provider-only account, which completes a full re-consent round trip to obtain one.
- **Gate the operation that does the thing, not the one that announces it.** v1.2b's own audit found two endpoints reaching a gated effect by an ungated route: the export *download* (the request was gated, the disclosure was not) and provider *disconnect* (adding a credential was gated, removing one was not). Ask where the effect lands and whether a second endpoint reaches it.
- **Never add an inline `bcrypt.compare` to a route.** Sign-in is the only place in this application that compares a password to decide who someone is; policy rules that need a hash live in `accountValidation.js`.
- Every session carries a `jti`. `openChallenge` refuses to bind a grant to a session without one, so all session minting goes through `authRoutes.js`'s `issueSession`.

### Frontend (`src/`)

React 19 + `react-router-dom` 7, no state-management library. `src/session/SessionProvider.jsx` owns session and page data; `src/routes/index.jsx` holds the lazy route table. `App.jsx` keeps the shell eager (nav, bell, theme toggle, error boundary, LoadingSkeleton).

Two ordering constraints in `App.jsx` are load-bearing and commented as such:

- `AUTH_FLOW_PATHS` (`/oauth/callback`, `/reset-password`) is checked **above** the `isCheckingSession` gate. Moving it back below reintroduces TD-9's one-in-four flaky test.
- `SessionProvider` deliberately does **not** gate its children on `isCheckingSession`. Do not add an early return there.

Navigation is one `NAV` array filtered by capability. Every entry must declare `requiredCap` or a non-empty `requiredCapAny` — a boot-time loop throws otherwise, because an entry with no capability would be silently hidden from everyone.

### Data invariants

- **Credited hours are never stored on a user.** They are derived on every read as `SUM(hours_awarded) WHERE present = 1`. Nothing may write a volunteer's total directly. Every change is additionally appended to `hours_ledger`.
- Check-in and hours confirmation are separate operations; check-in credits nothing. An existing credit keeps its original value permanently — hours are a snapshot, never re-priced when a slot is edited later.
- Attendance writes only touch volunteers named in the request, so a partial submission cannot silently mark anyone absent.
- Certificate codes are random (`crypto.randomBytes`) and stored, never derived from a user or event id.

### Migrations

Two paths, and picking the wrong one matters:

- **Additive guards** (`addColumnIfMissing` in `db.js`) — idempotent, run at init. Still correct for almost everything.
- **The versioned registry** (`server/migrations/`, added v1.2a) — for anything structural. Numbered modules exporting `{ version, name, up, fileUrl }`, ordered in `index.js`, recorded in `schema_migrations` with a source checksum re-verified on every boot. Each runs in its own transaction; set `ownTransaction: true` when the migration must manage its own (table rebuilds do, because `PRAGMA foreign_keys` is a silent no-op inside an open transaction).

Migrations are additive. The one sanctioned destructive rebuild is `001_authz_roles.js`, and it is permitted only because it carries all six guards listed in ENGINEERING_GUIDE §8.3 — backup first, pragma-took-effect assertion, explicit column list (never `SELECT *`; column order differs between databases), unknown/missing-column guard, schema-derived child-row count comparison, and `foreign_key_check` before commit. Copy that structure or don't write the rebuild.

Checksum failure on boot has three distinct causes with three different fixes — see ENGINEERING_GUIDE §8.5 before deleting any `schema_migrations` row.

## Testing

Two vitest projects with different environments (`client` = jsdom + `src/setupTests.js`, `server` = node). Both pin `isolate: true` and exclude `**/scratch/**`, and both pins are measured, documented, load-bearing decisions in `vitest.config.js` — do not "simplify" either. `scratch/` holds full project copies whose ~101 test files vitest will otherwise walk into.

Server tests boot the real app in-process against a throwaway SQLite file via `server/testServer.js`. **Never statically import anything that reaches `db.js` at the top of a server test file** — `db.js` opens its database at module scope, so the first import decides the path, and a static import evaluated before the hook binds the suite to the repo-local database. `testServer.js` asserts the opened path via `PRAGMA database_list` for exactly this reason.

Coverage is proportional to consequence, not a percentage. Required tests: any bug fix (failing first), any new endpoint, any auth/authz change, anything touching credited hours, any new boot guard, any migration (assert idempotency), any security fix.

The client suite carries three static guards over `src/` that fail the build rather than degrading silently: `tokens.test.js` (every `var(--x)` must be defined in `index.css`, no allowlist), `noHardcodedColors.test.js` (no colour literal or colour function outside `index.css`), `noDanglingClasses.test.js` (no class name without a rule, and no rule without a reference).

Flakiness is a defect, not a re-run. Known exception: TD-11, the vitest fork pool crashes with `Worker exited unexpectedly` on roughly one run in three — infrastructure, reproduced on unmodified baselines, always green on retry.

## Gotchas

- The API port is **`API_PORT`** (default 5050). Setting `PORT` does nothing for the server; `PORT` is Vite's.
- Production boot **fails closed** on missing `JWT_SECRET` (also on placeholders and weak values), incomplete `SMTP_*`, missing `APP_URL`, or `DEMO_MODE` with `NODE_ENV=production`. These guards are deliberate; weakening one is a merge blocker.
- `VITE_*` values are compiled into the bundle. Changing one requires a rebuild — setting it on a running server has no effect.
- `/health` reads its version from **`server/package.json`**, not the root. A version bump must touch both (`npm version <x.y.z> --no-git-tag-version --workspaces --include-workspace-root`).
- Responses under ~1 KB are not compressed (threshold 1024), which is why `/health` comes back uncompressed.
- Demo mode is gated behind `DEMO_MODE` / `VITE_DEMO_MODE`, set only by `npm run dev`.
- `.gitignore` is deny-by-default for env files (`.env`, `.env.*`, with `!` allowlist entries). Never weaken those patterns — a live `GOOGLE_CLIENT_SECRET` was committed once because the rule named a file instead of a class.

## Conventions

- Conventional Commits. Branches are `feature/*`, `fix/*`, `chore/*`, `docs/*`, `archive/*`, named for the area of work — never a person or ticket. Branch from current `main`, one concern per branch, squash-merge, delete at merge.
- Never rewrite pushed history. Fix forward with a commit that explains what happened.
- Comments explain *why*. Many modules in this repo open with a header describing the invariant they protect and the incident behind it — those headers are the primary documentation for `authz.js`, `vitest.config.js`, `testServer.js`, `reset-dev-db.mjs`, `routes/index.jsx`, and the three `src/` guard tests. Read them before changing the file, and keep them current.
- Any diff touching authentication, authorization, or secret handling needs explicit security review regardless of size.

## Docs map

- `docs/ENGINEERING_GUIDE.md` — process, security rules, testing philosophy, technical-debt register (TD-*)
- `docs/operations/` — deployment runbook, release checklist, demo reset
- `docs/plans/`, `docs/specs/` — design and audit records per release
- `docs/history/` — engineering history
- `CHANGELOG.md` — Keep a Changelog format; behaviour changes are described with their reasoning
