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

The "Reset DB" button in the demo bar (or `POST /api/auth/reset`) restores the seed data at any time.

## Features

- **Students:** browse/search events, sign up for individual time slots, withdraw pending applications, hours dashboard with monthly/category charts, community leaderboard, printable hours certificate, skill-based event recommendations, event discussion threads, in-app notifications, profile editing.
- **Organizers:** multi-date/multi-slot sign-up sheet builder, application queue (accept/waitlist/reject), **Equalizer** (auto-fill open spots prioritizing students with the fewest credited hours), attendance ledger that awards hours (re-editable), CSV roster export, event duplication (+7 days), open/close toggling.
- **Admins:** organizer verification queue, event moderation, platform-wide stats.

## Configuration

| Env var      | Default                       | Purpose                 |
|--------------|-------------------------------|-------------------------|
| `API_PORT`   | `5050`                        | Express server port     |
| `JWT_SECRET` | dev fallback (change in prod) | Token signing secret    |

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
