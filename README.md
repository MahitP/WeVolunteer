# WeVolunteer

A volunteer scheduling and service-hour platform for schools and community organizations.

WeVolunteer replaces the paper sign-up sheet and the spreadsheet that usually follows it. Organizers publish an event with individual time slots, volunteers claim the shifts they can actually make, and once an organizer confirms who attended, the hours become part of a verifiable service record.

---

## Contents

- [The problem](#the-problem)
- [Who it is for](#who-it-is-for)
- [Features](#features)
- [Architecture](#architecture)
- [Technology](#technology)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Security](#security)
- [Testing](#testing)
- [Deployment](#deployment)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## The problem

Community service hours matter. In many districts they gate honor-society membership, scholarships, and graduation requirements. The systems that track them usually do not match that importance.

The common failure modes are familiar:

- A paper sign-up sheet is filled in, photographed, and retyped into a spreadsheet.
- Two students write down conflicting totals and nobody can say which is right.
- A student's certificate says forty hours and there is no way to check.
- The same handful of volunteers claim every popular shift because they refresh faster.
- Someone loses the sheet.

Each of these is a record-keeping problem, and record-keeping problems get worse the more the record matters.

WeVolunteer treats the service record as the primary artifact. Hours are never entered by hand and never stored as a number on a user account. They are derived, every time they are displayed, from confirmed attendance:

```sql
SUM(hours_awarded) WHERE present = 1
```

That single constraint is why the figure can be trusted everywhere it appears. An organizer cannot inflate it, a student cannot edit it, and a certificate cannot claim hours that no attendance record supports. Every change to credited hours is additionally written to an append-only ledger recording who changed it, when, and why.

## Who it is for

**Students and volunteers** who need a service record that will withstand scrutiny from a scholarship committee.

**Organizers** — teachers, coaches, librarians, parent volunteers — who run events alongside a full-time job and need the roster, the day-of check-in, and the hours confirmation to take minutes rather than an evening.

**Administrators** who approve organizers, moderate content, and need programme-level numbers without asking anyone to compile them.

The design assumptions follow from that audience: participants are frequently minors, organizers are not technical, and the day-of tooling is used one-handed on a phone, outdoors, while people are arriving.

---

## Features

### Volunteer experience

Browse and search events by category, location, date, and remaining capacity. Apply to individual time slots rather than whole events, so a volunteer commits only to hours they can actually work. Withdraw a pending application without penalty and re-apply while sign-ups remain open. A personal dashboard shows upcoming shifts, progress toward the district's service-hour target, a monthly breakdown, and the full service history.

### Organizer tools

Build a sign-up sheet across multiple dates and shift templates in one pass, with per-slot capacity. Review applicants with their volunteer history inline — total hours, events completed, when they last served — so selection decisions have context. Accept, waitlist, or decline individually or in bulk. Post announcements to confirmed volunteers. Export the roster as CSV. Duplicate a recurring event forward by a week.

### Fair selection

Popular shifts are contested, and first-come-first-served rewards whoever refreshes fastest. WeVolunteer offers **Auto Select**: a weighted random draw run after the application deadline, where a volunteer's weight decreases as their credited hours rise.

```
W(h) = 1.5 + 8.5 / (1 + 0.005h)
```

A volunteer with no hours carries a weight of 10.0; one with 500 hours carries roughly 1.7. Nobody is ever excluded, and newcomers are meaningfully advantaged without experienced volunteers being shut out.

The mechanism is built to be auditable rather than merely fair-sounding. Draws are seeded per event and slot so they are reproducible. Every draft is stored. Re-draws are capped and each one requires a written reason that is retained and visible to administrators. A fairness mechanism that can be quietly re-rolled is not a fairness mechanism.

### Attendance and hours

Check-in and hours confirmation are deliberately separate operations. Check-in is a working note taken during an event and credits nothing. Confirmation writes the permanent record and is only possible once a shift has ended.

Attendance only ever touches the volunteers named in a request, so a partial or stale submission cannot silently mark anyone absent. An existing credit keeps its original value permanently — hours are a snapshot, never re-priced when a slot is later edited. Correcting a confirmed record requires a typed reason and is attributed to the person making the change.

### Certificates

Each completed event produces a printable certificate carrying a `WEV-XXXX-XXXX` code generated with `crypto.randomBytes` and stored server-side. A public, unauthenticated endpoint verifies the code, so a school office can check a printout without an account.

The code is a bearer credential — possession of the printout is what it proves. It is not derivable from a user or event identifier, which means it cannot be forged offline. Verification deliberately returns only what the certificate itself already shows, and omits the student's grade.

### Notifications

In-app notifications cover selection results, waitlist promotions, hours credited, announcements, and cancellations. A sweep runs every fifteen minutes to generate time-based reminders — a shift starting within 24 hours, an application deadline approaching on a favorited event, and an organizer alert when a deadline has passed with applicants still undecided. All are deduplicated so a repeating sweep never produces a duplicate.

### Administration

Approve or deny organizer registrations. Moderate events and comments. Review a reports queue. Platform statistics cover attendance rate, completion rate, participation rate, monthly hours, and top organizers.

### Privacy

Participants are frequently minors, and the data model reflects that. Contact details, grade, and school are visible only to the student themselves, an administrator, or an organizer hosting an event that student applied to. Confirmed future shifts — which disclose a minor's location at a known time — are visible only to the student. The community leaderboard is opt-in and off by default.

---

## Architecture

WeVolunteer is a single Node.js process serving a React single-page application and a JSON API, backed by one SQLite file. There is no separate database server, cache, or queue. The deployment target is one modest virtual machine.

That is a deliberate choice rather than a limitation. The workload is a few hundred users in one district, almost entirely text, with strong consistency requirements around a single number per volunteer. A single-process design with a local database removes an entire class of distributed-systems failure from a system whose correctness matters more than its scale.

```
                          Browser (HTTPS)
                                 |
                    ┌────────────▼────────────┐
                    │  Reverse proxy (nginx)  │
                    │  TLS · X-Forwarded-For  │
                    └────────────┬────────────┘
                                 │ 127.0.0.1:5050
      ┌──────────────────────────▼──────────────────────────┐
      │  Node process — server/server.js                    │
      │  startup guards: JWT_SECRET · SMTP · APP_URL        │
      │                                                     │
      │  ┌──────────────── app.js ────────────────────┐     │
      │  │ helmet → CORS(/api) → json → rate limits   │     │
      │  │                                             │     │
      │  │   authRoutes         eventRoutes            │     │
      │  │   applicationRoutes  attendanceRoutes       │     │
      │  │   adminRoutes        contentRoutes          │     │
      │  │                                             │     │
      │  │   GET /health   ·   static dist/ + SPA      │     │
      │  │   error handler (registered last)           │     │
      │  └─────────────────────────────────────────────┘     │
      │                                                     │
      │  setInterval 15m → notification sweep               │
      └───────┬─────────────────────────────┬───────────────┘
              │                             │
      ┌───────▼────────┐          ┌─────────▼─────────┐
      │ SQLite (WAL)   │          │  SMTP relay       │
      │ 16 tables      │          │  verification +   │
      │ hours_ledger   │          │  password reset   │
      └────────────────┘          └───────────────────┘
```

**Frontend.** React 19 with `react-router-dom`. No state-management library — a single shell component owns session, events, and applications, and a refresh counter re-fetches on mutation. Styling is a hand-written CSS design system with no UI framework.

**Backend.** Express 4 across six route modules. Domain logic lives in dedicated modules (`attendance.js`, `hoursLedger.js`, `certificates.js`, `weighting.js`, `validation.js`) rather than inside route handlers. `config.js` holds all environment-derived values and has no side effects, which is what allows a route module to be imported by a test without booting a listener or opening the production database.

**Database.** SQLite through Node's built-in `node:sqlite`, in WAL mode with a five-second busy timeout. Sixteen tables. Migrations are additive and applied idempotently on every boot, so deploying new code and restarting is the whole upgrade procedure.

**Authentication.** Email and bcrypt, JWT with a seven-day expiry. Identity is re-read from the database on every request rather than trusted from the token payload, so a role change or account deletion takes effect immediately. A `token_version` column allows a password reset to invalidate every existing session.

**Deployment.** The process binds loopback only and sits behind a reverse proxy that terminates TLS. Three misconfigurations refuse to start rather than running in a degraded state.

---

## Technology

| Layer | Choice |
|---|---|
| Frontend | React 19, React Router 7, Vite 8, `lucide-react` |
| Styling | Hand-written CSS design system |
| Backend | Node.js 24, Express 4 |
| Database | SQLite via `node:sqlite` (WAL mode) |
| Authentication | JSON Web Tokens, bcrypt |
| Email | Nodemailer over SMTP |
| Security | Helmet, `express-rate-limit`, CORS allowlist |
| Testing | Vitest — 256 tests across 25 files |
| Linting | oxlint |
| Tooling | npm workspaces, nodemon, concurrently |
| Deployment | systemd, nginx, Let's Encrypt |

---

## Getting started

### Requirements

- **Node.js 24.x** — required, not merely recommended. The application uses `node:sqlite`, which is unavailable on Node 22 without a flag.
- npm 11.x

### Installation

```bash
git clone <repository-url>
cd wevolunteer
npm install
```

This is an npm workspace. A single install at the root covers both the client and the `server` workspace.

### Development

```bash
npm run dev
```

Starts Vite on port 5173 and the API on 5050 together. Vite proxies `/api/*` to the API. On first boot the API seeds a demo database with sample users, events, and applications, and the sign-in page offers one-click logins for exploring each role.

Demo mode is opt-in and gated behind `VITE_DEMO_MODE` and `DEMO_MODE`, which are set only by `npm run dev`. A production build cannot contain the demo affordances, and the server refuses to start if demo mode is enabled with `NODE_ENV=production`.

### Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Client and API together |
| `npm run dev:client` | Vite only |
| `npm run dev:server` | API only, with reload |
| `npm run build` | Production client build to `dist/` |
| `npm test` | Full test suite |
| `npm run test:watch` | Tests in watch mode |
| `npm run lint` | oxlint |
| `npm start` | Production API server |

### Environment

Two configuration files with different lifetimes, deliberately kept separate:

| File | Read by | Contains |
|---|---|---|
| `/etc/wevolunteer/wevolunteer.env` | systemd, at runtime | Server secrets — `JWT_SECRET`, `SMTP_*`, `APP_URL` |
| `.env.production` | `vite build`, at build time | `VITE_*` values baked into the bundle |

Templates for both are in the repository: [`deploy/wevolunteer.env.example`](deploy/wevolunteer.env.example) and [`.env.production.example`](.env.production.example). Full documentation of every variable is in the [deployment runbook](docs/operations/pilot-deployment-runbook.md).

`VITE_*` values are compiled into the bundle. Changing one requires a rebuild; setting it on a running server has no effect.

---

## Project structure

```
├── src/                      React application
│   ├── components/           Shared components (modals, charts, event UI)
│   ├── views/                Route-level screens per role
│   ├── utils/                API client, formatting helpers, hooks
│   ├── config.js             Build-time client configuration
│   └── index.css             Design system
│
├── server/                   Express API (npm workspace)
│   ├── routes/               Six route modules
│   ├── app.js                Middleware and route assembly
│   ├── server.js             Startup guards, listener, scheduler
│   ├── config.js             Environment configuration, no side effects
│   ├── db.js                 Schema, migrations, seed data
│   ├── attendance.js         Check-in and hours finalisation
│   ├── hoursLedger.js        Append-only audit of hours changes
│   ├── certificates.js       Certificate code generation and verification
│   ├── weighting.js          Auto Select weighting and draw
│   ├── validation.js         Server-side payload validation
│   └── *.test.js             Test suite
│
├── deploy/                   systemd units and environment templates
├── bin/                      Operational scripts (backup, admin promotion)
├── docs/
│   ├── operations/           Deployment runbook, readiness review
│   └── history/              Engineering history and design records
└── public/                   Static assets
```

---

## Security

**Authentication.** Passwords are hashed with bcrypt. Sessions are JWTs with a seven-day expiry. Authorization is never taken from the token payload — the user row is re-read on every request, so a deleted account or a changed role takes effect at once. A `token_version` column lets a password reset invalidate all existing sessions.

**Startup guards.** Three misconfigurations cause the process to exit rather than run in a degraded state, in this order:

1. `JWT_SECRET` missing — required in every environment. There is no fallback secret.
2. `SMTP_*` incomplete in production — the development console transport would otherwise print live password-reset tokens to the log and deliver nothing.
3. `APP_URL` missing in production — a wrong value would email single-use tokens to a domain the operator does not control.

Enabling demo mode with `NODE_ENV=production` is also refused.

**Rate limiting.** Four independent limiters: sign-in and sign-up (failures only), email-sending endpoints (every request, since `forgot-password` returns success regardless of whether the address exists), the public certificate-verify endpoint, and a global API limit. Limits are in-memory and per-process, which is one reason the deployment runs a single instance.

**Input handling.** Server-side validation of every event and slot payload, independent of the client. JSON bodies are capped. Malformed input returns a 400 rather than surfacing driver internals in a 500.

**Data protection.** Personally identifying information is scoped server-side, not hidden in the client. Certificate codes are random and stored rather than derived. The public verification endpoint returns only what a printed certificate already discloses.

**Transport.** The process binds `127.0.0.1` and is unreachable except through the reverse proxy. Helmet sets baseline security headers; CORS is scoped to `/api` with a same-origin fallback.

### Dependency advisories

`npm audit` currently reports one high-severity advisory against `react-router`
([GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) — CSRF
bypass in RSC mode). It has been assessed and **does not apply to this
application**:

- The advisory is scoped to React Router's **RSC (React Server Components)
  mode**. This is a client-rendered SPA with no server components.
- The only router API used is `BrowserRouter`. There are no route `loader` or
  `action` handlers, no `createBrowserRouter`, and no `RouterProvider` — the
  attack surface the advisory describes is not instantiated.

`npm audit fix --force` resolves it by **downgrading** to `react-router-dom@7.11.0`.
That is a step backwards: 7.18.1 is the current release, and the downgrade is
flagged by npm as a breaking change. The dependency is deliberately left at the
latest version rather than moved to an older one to silence a finding that does
not apply.

This will be revisited when a patched release above 7.18.1 is published.

---

## Testing

256 tests across 25 files, run with Vitest.

```bash
npm test
```

The suite is weighted toward the invariants that matter rather than toward coverage percentage:

- **Data integrity** — a migration rehearsal against a copy of a real database, verifying that no volunteer's total moves; hours-ledger parity against attendance; idempotency and reversibility of the ledger backfill.
- **Privacy** — that student contact details, grade, and school are visible only to the student, administrators, and hosting organizers, and that upcoming shifts are self-only.
- **Workflow correctness** — attendance finalisation, check-in separation, Auto Select deadline enforcement and re-draw capping, waitlist promotion, bulk application handling.
- **Production posture** — that the process refuses to boot without `JWT_SECRET`, SMTP, or `APP_URL`; that `/health` returns JSON rather than the SPA; that CORS cannot blank the application.
- **Regression guards** — case-insensitive email uniqueness, malformed-input handling, SQLite pragmas, rate-limit response shape.

Test isolation is pinned explicitly in `vitest.config.js`. Several suites set process-wide state before importing the app, and without a fresh module registry per file the suite becomes order-dependently flaky rather than obviously broken.

A separate `npm run verify:hours --workspace=server` script checks ledger parity and exits non-zero on a mismatch — intended for CI and for operators after a migration.

---

## Deployment

Target is a single Linux host running the Node process behind nginx with TLS, and SQLite on a backed-up volume.

The repository ships the deployment artifacts rather than documenting them in prose:

| Artifact | Purpose |
|---|---|
| [`deploy/wevolunteer.service`](deploy/wevolunteer.service) | systemd unit for the application |
| [`deploy/wevolunteer-backup.service`](deploy/wevolunteer-backup.service) | One backup run |
| [`deploy/wevolunteer-backup.timer`](deploy/wevolunteer-backup.timer) | Nightly schedule |
| [`bin/backup.sh`](bin/backup.sh) | WAL-safe online backup, integrity-checked before it is kept |

Backups use SQLite's online backup API rather than a file copy. In WAL mode a plain `cp` of the database file produces a copy that opens without error and is missing recent writes.

Complete procedures — provisioning, environment setup, database initialisation, TLS, monitoring, incident response, and rollback — are in the [deployment runbook](docs/operations/pilot-deployment-runbook.md). It is written for an engineer who has not seen this project before.

---

## Roadmap

WeVolunteer is feature-complete for its first release. The following are known gaps rather than aspirations, listed roughly in the order they would be worth doing.

**Email notifications.** Selection results, waitlist promotions, and cancellations are currently in-app only. A student who does not open the application does not learn they were selected. This is the most significant functional gap.

**Offline-tolerant check-in.** The day-of screen assumes connectivity. Events happen in parks and basements. A local queue with retry would make it dependable where it is most needed.

**Accessibility completion.** Keyboard and screen-reader support is in place for dialogs, navigation, tab panels, progress meters, and charts. A full audit against WCAG 2.1 AA has not been carried out.

**Operational visibility.** No request logging and no metrics endpoint. Both are proxy-level or small additions, and both would materially improve incident response.

**Horizontal scale.** Rate limiting is in-memory and per-process, so the current design runs one instance. A shared store is a prerequisite for running more than one.

**Multi-organization support.** The data model assumes a single district. Supporting several tenants means scoping events, users, and administration by organization.

**Richer scheduling.** Recurring events, shift dependencies, and volunteer availability windows.

---

## Contributing

The repository is private, so this section is for anyone given access — and for
the possibility that it is opened up later. Either way, the setup is intended to
let someone new be productive quickly.

1. Create a branch from `main`.
2. `npm install`, then `npm run dev`.
3. Make the change, with tests where behavior changes.
4. Run `npm test` and `npm run lint`.
5. Open a pull request describing what changed and why.

**Conventions used throughout this codebase:**

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- Comments explain *why*, not *what*. Several modules carry a header explaining the invariant they protect; those are worth reading before changing them.
- Behavioral changes need a test that fails without the fix.
- `attendance` is the single source of truth for credited hours. Nothing may write a volunteer's total directly.

Three areas deserve particular caution, and the code says so at the point of change: the hours ledger, certificate generation, and the privacy scoping on user profiles.

---

## License

This is a private project. All rights reserved.

No open-source license is granted. The source is not published for reuse,
redistribution, or derivative work. If that changes, a `LICENSE` file will be
added here and this section will say so explicitly — the absence of one is
deliberate rather than an oversight.

---

## Acknowledgements

Built for South Brunswick, New Jersey. The interaction model — claiming individual time slots rather than registering for an event — is drawn from how paper sign-up sheets already work, on the view that a digital system should not require volunteers to learn a new mental model.
