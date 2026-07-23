# SBVolunteers

A full-stack volunteer sign-up platform for South Brunswick, NJ — a SignUpGenius-style app where organizers post events with time slots, students apply for shifts, and confirmed attendance turns into certified community-service hours.

## Stack

- **Frontend:** React 19 + Vite, `lucide-react` icons, hand-rolled CSS (no UI framework)
- **Backend:** Express 4, `node:sqlite` (built-in SQLite), JWT auth, bcryptjs
- **Dev tooling:** oxlint, nodemon, concurrently

## Getting started

```bash
npm install
npm install --prefix server
npm run dev          # starts Vite (5173) + API server (5050) together
```

The Vite dev server proxies `/api/*` to the Express server. On first boot the API seeds `server/sbvolunteers.db` with demo users, events, and applications.

**Demo accounts** (password `password123`, or use the one-click login buttons):

| Role      | Email                        | Notes                        |
|-----------|------------------------------|------------------------------|
| Student   | leo.chen28@gmail.com         |                              |
| Student   | priya.patel.nhs@outlook.com  | has seeded history + pending |
| Organizer | jkatzenback@vikings.org      | verified, hosts seed events  |
| Organizer | rmiller@sbpl.info            | pending admin approval       |
| Admin     | admin@sbvolunteers.gov       |                              |

The "Reset DB" button in the demo bar (or `POST /api/auth/reset`) restores the seed data at any time. Both the demo bar and that endpoint exist **only** when demo mode is enabled — see Configuration below.

## Features

- **Students:** browse/search events, sign up for individual time slots, withdraw pending applications, hours dashboard with monthly/category charts, community leaderboard, printable hours certificate, skill-based event recommendations, event discussion threads, in-app notifications, profile editing.
- **Organizers:** multi-date/multi-slot sign-up sheet builder, application queue (accept/waitlist/reject), **Equalizer** (auto-fill open spots prioritizing students with the fewest credited hours), attendance ledger that awards hours (re-editable), CSV roster export, event duplication (+7 days), open/close toggling.
- **Admins:** organizer verification queue, event moderation, platform-wide stats.

## Configuration

### Server (`server/`)

| Env var        | Default                                        | Purpose |
|----------------|------------------------------------------------|---------|
| `API_PORT`     | `5050`                                         | Express server port |
| `NODE_ENV`     | unset                                          | Set to `production` for a real deployment; enables the startup guards below |
| `JWT_SECRET`   | dev fallback                                   | Token signing secret. **Required when `NODE_ENV=production` — the server refuses to start without it.** |
| `DEMO_MODE`    | `false`                                        | Registers the database reset endpoint. Opt-in only, and refused outright when `NODE_ENV=production`. `npm run dev` sets it. |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:4173`  | Comma-separated allowlist of browser origins. Requests with no `Origin` header (curl, same-origin) always pass. |
| `TRUST_PROXY`  | unset                                          | Set to the number of reverse proxies in front of the app (e.g. `1`) so rate limiting sees the real client IP. Leave unset when not behind a proxy — trusting `X-Forwarded-For` blindly lets clients bypass the limiter. |
| `SBV_DB_PATH`  | `server/sbvolunteers.db`                       | Absolute path to the SQLite file. Used by tests; override in production to place the database on a backed-up volume. |
| `REQUIRE_EMAIL_VERIFICATION` | `false`                          | When `true`, a new account must click a confirmation link before using the app. **Only turn this on once `SMTP_*` is configured** — without a working transport it locks every new user out. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | unset | Transactional mail transport. With any of these unset, mail is printed to the server console instead of being sent. |
| `APP_URL`      | `https://sbvolunteers.org` in production | Base URL used to build confirmation and password-reset links. |

A minimal production start:

```bash
NODE_ENV=production \
JWT_SECRET="$(openssl rand -hex 32)" \
CORS_ORIGINS="https://sbvolunteers.example.org" \
npm start --prefix server
```

#### First admin on a fresh deployment

A production database starts **empty** — demo accounts are only seeded when
`DEMO_MODE=true`. To create the first administrator:

1. Have that person sign up through the normal form (they will be a `student`).
2. Promote them:

```bash
node bin/make-admin.mjs person@district.example.org
```

#### Upgrading an existing database

`initDatabase()` runs on every boot and applies additive column and table
migrations automatically (`addColumnIfMissing`, plus the `applications` and
hours-ledger rebuilds), so simply deploying the new code and restarting picks
them up. Existing volunteer records, applications, and credited hours are
preserved, and users added before email verification existed are backfilled as
verified so nobody is locked out.

One migration is **not** automatic. Usernames were added after the first
release, so accounts created before that have no username. Backfill them once,
after upgrading:

```bash
node server/migrate_usernames.js
```

It derives a unique username per user from their name/email and skips anyone
who already has one, so it is safe to re-run. New sign-ups collect a username
at registration and do not need it.

**Back up the database before the first boot on new code.** Boot applies the
migrations above automatically, and the case-insensitive email dedupe
(introduced with the `idx_users_email_nocase` index) may rewrite the email of a
duplicate account on a database that predates case-insensitive uniqueness. It is
non-destructive — it never deletes a user or touches attendance/hours, only
renames the lower-hours account of a duplicate pair to `local+dup-<rowid>@domain`
and logs every change — and it is a no-op on data with no case-collisions. Still,
take a copy of the SQLite file (and its `-wal`/`-shm` sidecars if present) before
deploying, so any dedupe rename can be reviewed and reversed by hand:

```bash
cp server/sbvolunteers.db "sbvolunteers.$(date +%F).bak.db"
```

### Client

| Env var           | Default | Purpose |
|-------------------|---------|---------|
| `VITE_DEMO_MODE`  | unset   | Shows the demo account switcher and the seeded sign-in buttons. Set in `.env.development`, which `vite build` does not read — so a production bundle never contains them. |

### Security posture

- `helmet` sets baseline response headers. Content-Security-Policy is deliberately **not** set here: this server returns JSON only. A policy belongs wherever the HTML is served, which is still Vite (see roadmap item 1.18).
- Rate limiting is in-memory and per-process: 10 attempts / 15 min on `/api/auth/login` and `/api/auth/signup` (failures only), 600 / 15 min across `/api`. Limits are relaxed in `DEMO_MODE`. Running more than one instance would need a shared store.

## Scripts

```bash
npm run dev          # client + server concurrently
npm run dev:client   # Vite only
npm run dev:server   # nodemon on server/server.js
npm run build        # production client build
npm run lint         # oxlint
```

## Notes

- `node:sqlite` is experimental — requires a recent Node (20.6+/22+); the warning on boot is expected.
- Volunteer hours are always **derived from attendance records** (`present = 1`), never stored on the user row, so totals stay consistent.
- Self-signup is limited to `student` and `organizer` roles; organizers must be verified by an admin before posting events.
