# SBVolunteers P0 Launch Blockers — Implementation Plan

**Goal:** Take SBVolunteers from "does not compile" to "a student, an organizer, and an admin can each complete their full journey end to end, and a forgotten password is recoverable."

**Architecture:** Nine sequenced tasks. Task 1 repairs the build (nothing else is verifiable until it does). Task 2 makes the Express routes testable by splitting boot-time side effects out of `server.js` — this is the prerequisite for TDD on every subsequent task, because today importing any router calls `app.listen()`. Tasks 3–9 each fix one P0 defect, test-first, against the harness Task 2 builds.

**Tech Stack:** React 19 + Vite 8 (client), Express 4 + `node:sqlite` `DatabaseSync` (server), Vitest 4, bcryptjs, jsonwebtoken, nodemailer.

## Global Constraints

- **Do not change the hours pipeline.** `server/attendance.js` and `server/hoursLedger.js` are audited-correct and covered by 82 passing tests. No task here modifies them.
- **Hours are always derived** from `attendance` rows where `present = 1`. Never store a total on `users`.
- **`node:sqlite`'s `DatabaseSync` has NO `.transaction()` method.** Use the `inTransaction(fn)` helper in `server/utils.js` for multi-statement writes.
- **All existing tests must keep passing.** Run `npm test` before every commit; 82 tests pass at the start of this plan.
- **Terminology:** applications *open* and *close*; volunteers *apply*; organizers *accept / waitlist / reject*; students *withdraw*. Never "sign up" for the act of applying.
- **Design system is "Field Notes":** paper `#F7F7F5`, service green `#0F6B45` for actions, amber `#B45309` **only** for hours/credit. Do not introduce new colors or a second capacity widget.
- **No new product features.** Every task here completes something already half-built or repairs something broken.
- **Commit after every task.** Conventional commit messages (`fix:`, `feat:`, `refactor:`, `test:`).

## Scope

This plan covers **P0 launch blockers only** — the defects that make the app unusable. P1 items from the audit (data-scoping, Auto Select fairness, server-side validation, rate limits, `/health` shadowing) get a **separate plan** written after this one lands and is verified, because several of them change code these tasks touch.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/views/VolunteerDashboard.jsx` | Repair spliced import | 1 |
| `src/views/VolunteerPortfolio.jsx` | Repair unclosed `<footer>` | 1 |
| `src/components/EventComments.jsx` | Repair orphaned `<textarea>` attributes | 1 |
| `server/config.js` | **Create.** All env-derived config. No side effects. | 2 |
| `server/app.js` | **Create.** Express app assembly + routers. No `listen`. | 2 |
| `server/server.js` | Shrinks to boot only: guards, `initDatabase`, `listen`, sweep | 2 |
| `server/db.js` | Honour `SBV_DB_PATH`; gate seeding on `DEMO_MODE`; verified backfill | 2, 3, 4 |
| `server/testServer.js` | **Create.** In-process route-test harness. | 2 |
| `server/routes.auth.test.js` | **Create.** Auth journey tests. | 4, 5, 6, 8 |
| `server/routes.applications.test.js` | **Create.** Withdraw / re-apply tests. | 7 |
| `server/routes.checkin.test.js` | **Create.** Check-in contract tests. | 9 |
| `server/utils.js` | Add `emailVerified` to `formatUserResponse` | 4 |
| `server/routes/authRoutes.js` | Password reset + verification + username | 5, 6, 8 |
| `server/routes/applicationRoutes.js` | Withdraw status + re-application | 7 |
| `server/routes/eventRoutes.js` | Add `GET /api/events/:id` | 9 |
| `bin/make-admin.mjs` | Repair: use `node:sqlite`, not `better-sqlite3` | 3 |
| `src/utils/api.js` | Add `fetchEventDetails`; fix check-in payload keys | 9 |
| `src/views/CheckInView.jsx` | Fix payload keys; surface `marked` count | 9 |
| `src/App.jsx` | Verification gate reads a real field | 4 |
| `README.md` | Document new env vars | 3, 6 |

---

## Task 1: Repair the build

Three files committed at `0d26da2` contain JSX parse errors from a bad automated "config extraction" edit. `npm run build` and `npm run dev` both fail. Nothing else in this plan is verifiable until this is fixed.

**Files:**
- Modify: `src/views/VolunteerDashboard.jsx:1-6`
- Modify: `src/views/VolunteerPortfolio.jsx:138-141`
- Modify: `src/components/EventComments.jsx:114-131`

**Interfaces:**
- Consumes: nothing.
- Produces: a compiling client. Every later task's manual verification depends on this.

- [ ] **Step 1: Confirm the build currently fails**

Run: `npm run build`

Expected: FAIL. Errors naming `src/views/VolunteerPortfolio.jsx:154:7`, `src/views/VolunteerDashboard.jsx:3:1`, `src/components/EventComments.jsx:122:12`.

- [ ] **Step 2: Fix the spliced import in VolunteerDashboard**

An `import` was inserted into the middle of another `import`. Replace lines 1–6 of `src/views/VolunteerDashboard.jsx`:

```jsx
import React, { useState, useMemo, useEffect } from 'react';
import {
import { APP_NAME } from '../config';
  FileText, ArrowRight, Printer, X, Ban, Trophy, MapPin, CalendarCheck, History, ShieldCheck
} from 'lucide-react';
import { formatHours, formatDay, formatTimeRange, countdown } from '../utils/helpers';
```

with:

```jsx
import React, { useState, useMemo, useEffect } from 'react';
import {
  FileText, ArrowRight, Printer, X, Ban, Trophy, MapPin, CalendarCheck, History, ShieldCheck
} from 'lucide-react';
import { APP_NAME } from '../config';
import { formatHours, formatDay, formatTimeRange, countdown } from '../utils/helpers';
```

`APP_NAME` is genuinely used at line 108 (`<h2>Welcome to {APP_NAME}! 🎉</h2>`), so the import is kept — just moved out of the `lucide-react` specifier list.

- [ ] **Step 3: Fix the unclosed `<footer>` in VolunteerPortfolio**

A `<footer>` and a `<div className="row">` were opened and never closed; unrelated content was pasted over the footer body. Delete lines 138–140 of `src/views/VolunteerPortfolio.jsx`:

```jsx
        {/* Footer */}
        <footer style={{ marginTop: 'var(--s8)', paddingTop: 'var(--s4)', borderTop: '1px solid #ccc', color: '#666', fontSize: '0.85rem', textAlign: 'center' }}>
          <div className="row" style={{ justifyContent: 'center', gap: 6, marginBottom: 4 }}>
```

The region must read:

```jsx
          )}
        </section>

        {/* Official Note & Signature */}
        <div style={{ marginTop: 'var(--s8)', paddingTop: 'var(--s6)', borderTop: '1px solid #ccc', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
```

This rebalances the tree: the signature `<div>` is self-contained, and the two trailing `</div>`s close the printable area (line 69) and the root (line 55).

- [ ] **Step 4: Restore the deleted `<textarea>` in EventComments**

The `<textarea>` opening tag was deleted, orphaning its attributes, and its wrapper `<div>` was lost while its `</div>` remained. Replace lines 114–131 of `src/components/EventComments.jsx`:

```jsx
      <form onSubmit={handlePost} className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
            onChange={e => setBody(e.target.value)}
```

...through the closing `</form>`, with:

```jsx
      <form onSubmit={handlePost} className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
        <div style={{ flex: 1 }}>
          <textarea
            className="textarea"
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Ask a question or share an update…"
            maxLength={1000}
            disabled={posting}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handlePost(e);
            }}
          />
          <div className="row-between" style={{ marginTop: 6 }}>
            <span className="small dim">⌘ + Enter to post</span>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!body.trim() || posting}>
              {posting ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
              {posting ? 'Posting…' : 'Post'}
            </button>
          </div>
        </div>
      </form>
```

`body`/`setBody`/`posting` are existing state in this component (lines 9–11) — no new state is introduced.

- [ ] **Step 5: Verify the build succeeds**

Run: `npm run build`

Expected: PASS. Output ends with `✓ built in …` and writes to `dist/`.

- [ ] **Step 6: Verify existing tests still pass**

Run: `npm test`

Expected: `Test Files 5 passed (5)`, `Tests 82 passed (82)`.

- [ ] **Step 7: Commit**

```bash
git add src/views/VolunteerDashboard.jsx src/views/VolunteerPortfolio.jsx src/components/EventComments.jsx
git commit -m "fix: repair JSX parse errors that broke the build

Three files were corrupted by an automated config-extraction edit:
- VolunteerDashboard: import spliced into another import
- VolunteerPortfolio: unclosed <footer> and <div>
- EventComments: <textarea> opening tag deleted, attributes orphaned

npm run build and npm run dev both failed at HEAD."
```

---

## Task 2: Make the Express routes testable

Every router does `import { JWT_SECRET } from '../server.js'`, and `server.js` calls `initDatabase()`, `setInterval(...)` and `app.listen()` at module scope. Importing a router therefore boots a real server on port 5050 against the real database file — so no route can be unit-tested. Every remaining task in this plan fixes a route.

This is a structural refactor, justified by testability: the audit found seven P0 defects in route code, and **not one of them was covered by a test** because writing one was impossible.

**Files:**
- Create: `server/config.js`
- Create: `server/app.js`
- Create: `server/testServer.js`
- Modify: `server/server.js` (replace whole file)
- Modify: `server/db.js:10` (DB path from env)
- Modify: `server/utils.js:3` (import from config)
- Modify: `server/routes/authRoutes.js:6`, `applicationRoutes.js:5`, `attendanceRoutes.js:5`, `adminRoutes.js:5`, `contentRoutes.js:5`, `eventRoutes.js:5`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `server/config.js` exports `DEMO_MODE, IS_PRODUCTION, JWT_SECRET, VALID_GRADES, VALID_CATEGORIES, APP_NAME, SCHOOL_NAME, PORT, ALLOWED_ORIGINS, MAX_AUTO_SELECT_APPLICANTS, DEFAULT_EMAIL_FROM` (all plain values, no side effects).
  - `server/app.js` exports `app` (a configured Express app, **not** listening) and `authLimiter`, `apiLimiter`.
  - `server/testServer.js` exports `async function startTestServer(): Promise<{ base: string, call: Function, close: Function }>` where `call(method, path, body?, token?) => Promise<{ status: number, body: any }>`.

- [ ] **Step 1: Create `server/config.js`**

```js
/**
 * All environment-derived configuration, in one place with no side effects.
 *
 * Routers import from here rather than from server.js, so that importing a
 * router does not boot a listener, open the production database, or start the
 * notification sweep. That is what makes route tests possible.
 */

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEMO_MODE = process.env.DEMO_MODE === 'true';
export const PORT = Number(process.env.API_PORT) || 5050;

export const JWT_SECRET = process.env.JWT_SECRET || 'sbvolunteers_secret_key_12345';

export const VALID_GRADES = ['9', '10', '11', '12', 'Adult', 'N/A'];
export const VALID_CATEGORIES = ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];

export const APP_NAME = process.env.APP_NAME || 'SBVolunteers';
export const SCHOOL_NAME = process.env.SCHOOL_NAME || 'South Brunswick, NJ';
export const MAX_AUTO_SELECT_APPLICANTS = Number(process.env.MAX_AUTO_SELECT_APPLICANTS) || 100;
export const DEFAULT_EMAIL_FROM = `"${APP_NAME}" <noreply@sbvolunteers.org>`;

export const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);
```

- [ ] **Step 2: Create `server/app.js`**

This is the middleware and router assembly lifted verbatim out of `server.js`, with two ordering bugs left **unfixed on purpose** — the `/health` shadowing and error-handler placement are P1 items and belong in the next plan, where they get their own tests. Only the `listen`/`initDatabase`/`setInterval` side effects move out.

```js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEMO_MODE, IS_PRODUCTION, ALLOWED_ORIGINS } from './config.js';
import { db } from './db.js';

import authRoutes from './routes/authRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import applicationRoutes from './routes/applicationRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import contentRoutes from './routes/contentRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

if (process.env.TRUST_PROXY) {
  const value = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(value) ? process.env.TRUST_PROXY : value);
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 10000 : 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api', apiLimiter);

app.use(authRoutes);
app.use(eventRoutes);
app.use(applicationRoutes);
app.use(attendanceRoutes);
app.use(adminRoutes);
app.use(contentRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  if (String(err.message).startsWith('Origin not allowed by CORS')) {
    console.warn(err.message);
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  console.error('Unhandled error:', err);
  const status = err.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: status === 400 ? 'Invalid JSON' : 'Internal server error' });
});

if (IS_PRODUCTION) {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(distPath, 'index.html'));
    } else {
      res.status(404).json({ error: 'Endpoint not found' });
    }
  });
}

app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'connected', version: '2.0.0' });
  } catch (err) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});
```

- [ ] **Step 3: Replace `server/server.js` with boot-only code**

```js
import { app } from './app.js';
import { PORT, IS_PRODUCTION, DEMO_MODE } from './config.js';
import { initDatabase } from './db.js';
import { runNotificationSweep } from './utils.js';

if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production.');
  process.exit(1);
}
if (IS_PRODUCTION && DEMO_MODE) {
  console.error('FATAL: DEMO_MODE cannot be enabled in production.');
  process.exit(1);
}

initDatabase();

runNotificationSweep();
setInterval(runNotificationSweep, 15 * 60 * 1000);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SBVolunteers API Server listening on port ${PORT}`);
});
```

- [ ] **Step 4: Point `db.js` at a configurable path**

In `server/db.js`, replace line 10:

```js
const dbPath = path.join(__dirname, 'sbvolunteers.db');
```

with:

```js
// SBV_DB_PATH lets tests point at a throwaway file. Unset in normal operation.
const dbPath = process.env.SBV_DB_PATH || path.join(__dirname, 'sbvolunteers.db');
```

- [ ] **Step 5: Repoint every `server.js` import to `config.js`**

Change the import source in these seven files — the named imports stay identical, only the path changes from `'../server.js'` / `'./server.js'` to `'../config.js'` / `'./config.js'`:

| File | Line | New import |
|---|---|---|
| `server/utils.js` | 3 | `import { JWT_SECRET } from './config.js';` |
| `server/routes/authRoutes.js` | 6 | `import { VALID_GRADES, JWT_SECRET } from '../config.js';` |
| `server/routes/eventRoutes.js` | 5 | `import { VALID_GRADES, VALID_CATEGORIES } from '../config.js';` |
| `server/routes/applicationRoutes.js` | 5 | `import { VALID_GRADES } from '../config.js';` |
| `server/routes/attendanceRoutes.js` | 5 | `import { VALID_GRADES } from '../config.js';` |
| `server/routes/adminRoutes.js` | 5 | `import { VALID_GRADES } from '../config.js';` |
| `server/routes/contentRoutes.js` | 5 | `import { VALID_GRADES } from '../config.js';` |

Also in `server/routes/authRoutes.js`, replace the local line 106 `const DEMO_MODE = process.env.DEMO_MODE === 'true';` with an import from config — add `DEMO_MODE` to the line-6 import and delete line 106.

- [ ] **Step 6: Create the test harness `server/testServer.js`**

```js
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Boots the real Express app in-process against a throwaway SQLite file.
 *
 * DEMO_MODE is on so the database seeds its demo users (tests assert against
 * them) and the rate limiters stay out of the way. The env vars must be set
 * before db.js and app.js are first imported, which is why the imports here
 * are dynamic.
 */
export async function startTestServer() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbv-test-'));
  process.env.SBV_DB_PATH = path.join(dir, 'test.db');
  process.env.DEMO_MODE = 'true';
  process.env.JWT_SECRET = 'test-secret-not-for-production';

  const { initDatabase } = await import('./db.js');
  const { app } = await import('./app.js');

  initDatabase();

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* empty or non-JSON body */ }
    return { status: res.status, body: parsed };
  };

  const login = async (email, password = 'password123') => {
    const res = await call('POST', '/api/auth/login', { email, password });
    return res.body?.token;
  };

  const close = () => new Promise(resolve => {
    server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); });
  });

  return { base, call, login, close };
}
```

- [ ] **Step 7: Write a smoke test proving the harness works**

Create `server/routes.smoke.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('route test harness', () => {
  let srv;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });

  it('serves the seeded events list', async () => {
    const res = await srv.call('GET', '/api/events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('authenticates a seeded user', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    expect(token).toBeTruthy();
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('leo.chen28@gmail.com');
  });

  it('does not touch the real database file', () => {
    expect(process.env.SBV_DB_PATH).toContain('sbv-test-');
  });
});
```

- [ ] **Step 8: Run the smoke test**

Run: `npx vitest run server/routes.smoke.test.js`

Expected: PASS, 3 tests. If it fails with `EADDRINUSE`, the app is still calling `listen` somewhere outside `server.js` — recheck Step 2.

- [ ] **Step 9: Verify the real server still boots and the full suite passes**

```bash
npm test
API_PORT=5099 node server/server.js
```

Expected: `Tests 85 passed (85)`. The server prints `SBVolunteers API Server listening on port 5099`. Stop it with Ctrl-C.

- [ ] **Step 10: Commit**

```bash
git add server/config.js server/app.js server/server.js server/testServer.js server/routes.smoke.test.js server/db.js server/utils.js server/routes/
git commit -m "refactor: split server boot from app assembly so routes are testable

Importing any router previously ran server.js, which calls initDatabase(),
setInterval() and app.listen() at module scope — so no route could be tested.

- config.js: env-derived values, no side effects
- app.js: express assembly, exports app without listening
- server.js: boot only
- db.js: honours SBV_DB_PATH for throwaway test databases
- testServer.js: in-process harness with a temp database

No route behaviour changes."
```

---

## Task 3: Stop seeding demo accounts into production

`initDatabase()` seeds 15 demo users whenever the `users` table is empty, with no `NODE_ENV` or `DEMO_MODE` guard. A fresh production database therefore creates `admin@sbvolunteers.gov` with password `password123` — credentials published in `README.md`. The intended alternative, `bin/make-admin.mjs`, imports `better-sqlite3`, which is not a dependency, so it crashes.

**Files:**
- Modify: `server/db.js:280-288`
- Modify: `bin/make-admin.mjs` (replace whole file)
- Modify: `README.md` (Configuration section)
- Test: `server/routes.seeding.test.js` (create)

**Interfaces:**
- Consumes: `startTestServer` from Task 2.
- Produces: seeding only under `DEMO_MODE`. Later tasks' tests rely on the harness setting `DEMO_MODE=true`, so seeded fixtures remain available in tests.

- [ ] **Step 1: Write the failing test**

Create `server/routes.seeding.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Seeding is a demo affordance. A production database must come up empty, so
 * that no account exists with a password published in the README.
 */
describe('demo seeding is gated on DEMO_MODE', () => {
  it('does not seed when DEMO_MODE is off', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbv-seed-'));
    const dbFile = path.join(dir, 'prod.db');

    const { execFileSync } = await import('child_process');
    execFileSync(process.execPath, ['-e', `
      process.env.SBV_DB_PATH = ${JSON.stringify(dbFile)};
      delete process.env.DEMO_MODE;
      const { initDatabase } = await import('./server/db.js');
      initDatabase();
    `.trim()], { cwd: process.cwd(), input: '', stdio: 'pipe' });

    const db = new DatabaseSync(dbFile);
    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    db.close();
    rmSync(dir, { recursive: true, force: true });

    expect(count).toBe(0);
  });
});
```

Note: `node -e` does not allow top-level `await` in CommonJS mode; use `--input-type=module` instead. Replace the `execFileSync` call with:

```js
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.SBV_DB_PATH = ${JSON.stringify(dbFile)};
      delete process.env.DEMO_MODE;
      const { initDatabase } = await import('${process.cwd().replace(/\\/g, '/')}/server/db.js');
      initDatabase();
    `], { cwd: process.cwd(), stdio: 'pipe' });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes.seeding.test.js`

Expected: FAIL — `expected 15 to be 0`.

- [ ] **Step 3: Gate seeding on DEMO_MODE**

In `server/db.js`, add to the imports at the top:

```js
import { DEMO_MODE } from './config.js';
```

Then replace lines 280–288:

```js
  // Only seed if the database is empty
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    console.log('Seeding database...');
    seedDatabase();
    console.log('Seeding complete.');
  } else {
    console.log('Database already initialized.');
  }
```

with:

```js
  // Seed data is a demo affordance, never a production one: the seed accounts
  // share a password that is printed in the README. A real deployment comes up
  // empty, and its first admin is made with `node bin/make-admin.mjs <email>`
  // after that person has signed up normally.
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count > 0) {
    console.log('Database already initialized.');
  } else if (DEMO_MODE) {
    console.log('Seeding database...');
    seedDatabase();
    console.log('Seeding complete.');
  } else {
    console.log('Empty database initialized. DEMO_MODE is off, so no demo accounts were created.');
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/routes.seeding.test.js`

Expected: PASS.

- [ ] **Step 5: Repair `bin/make-admin.mjs`**

It imports `better-sqlite3`, which is not installed anywhere in this project. Replace the whole file:

```js
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.SBV_DB_PATH || path.join(__dirname, '..', 'server', 'sbvolunteers.db');

const email = process.argv[2];

if (!email) {
  console.error('Usage: node bin/make-admin.mjs <email>');
  process.exit(1);
}

try {
  const db = new DatabaseSync(dbPath);

  const user = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);

  if (!user) {
    console.error(`Error: User with email ${email} not found.`);
    console.error('Please have the user sign up first before promoting them.');
    process.exit(1);
  }

  if (user.role === 'admin') {
    console.log(`User ${email} is already an admin.`);
    process.exit(0);
  }

  db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  console.log(`Successfully promoted ${email} to admin.`);
} catch (error) {
  console.error('Database error:', error.message);
  process.exit(1);
}
```

- [ ] **Step 6: Verify make-admin runs end to end**

```bash
rm -rf /tmp/sbv-admin-check && mkdir -p /tmp/sbv-admin-check
SBV_DB_PATH=/tmp/sbv-admin-check/a.db DEMO_MODE=true node -e "import('./server/db.js').then(m => m.initDatabase())"
SBV_DB_PATH=/tmp/sbv-admin-check/a.db node bin/make-admin.mjs leo.chen28@gmail.com
```

Expected: `Successfully promoted leo.chen28@gmail.com to admin.` (No `ERR_MODULE_NOT_FOUND`.)

- [ ] **Step 7: Document the production bootstrap in README.md**

In the "Configuration → Server" section, add a row to the env var table:

```markdown
| `SBV_DB_PATH`  | `server/sbvolunteers.db`                       | Absolute path to the SQLite file. Used by tests; override in production to place the database on a backed-up volume. |
```

And immediately after the "A minimal production start" code block, add:

```markdown
#### First admin on a fresh deployment

A production database starts **empty** — demo accounts are only seeded when
`DEMO_MODE=true`. To create the first administrator:

1. Have that person sign up through the normal form (they will be a `student`).
2. Promote them:

```bash
node bin/make-admin.mjs person@district.example.org
```
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`

Expected: all tests pass (86 now).

- [ ] **Step 9: Commit**

```bash
git add server/db.js bin/make-admin.mjs README.md server/routes.seeding.test.js
git commit -m "fix: never seed demo accounts into a production database

initDatabase() seeded 15 users, including admin@sbvolunteers.gov with the
password published in the README, whenever the users table was empty — with
no NODE_ENV or DEMO_MODE guard. A fresh production deploy was compromised on
first boot.

Also repairs bin/make-admin.mjs, which imported better-sqlite3 (not a
dependency) and crashed — leaving no working way to create an admin."
```

---

## Task 4: Unblock login — surface `emailVerified`

`src/App.jsx:319` blocks the entire application on `!currentUser.emailVerified`. The server never returns that field: `formatUserResponse` omits it. So `!undefined === true` and **every user is locked out** behind an inescapable "Verify your email" screen whose only button calls a 404 endpoint.

The gate itself is correct — it just needs a real field behind it, and a way to be off during a pilot that has no SMTP server.

**Files:**
- Modify: `server/utils.js:32-45`
- Modify: `server/config.js` (add `REQUIRE_EMAIL_VERIFICATION`)
- Modify: `server/db.js` (backfill when verification is not required)
- Modify: `server/routes/authRoutes.js:40` (set `email_verified` at signup)
- Test: `server/routes.auth.test.js` (create)

**Interfaces:**
- Consumes: `startTestServer` from Task 2.
- Produces: `formatUserResponse` gains `emailVerified: boolean`. `config.js` gains `REQUIRE_EMAIL_VERIFICATION: boolean` (default `false`). Task 6 turns this flag on and adds the endpoints behind it.

- [ ] **Step 1: Write the failing test**

Create `server/routes.auth.test.js`.

> **Important — one server per test file.** `startTestServer()` sets `SBV_DB_PATH` and then dynamically imports `db.js`, which opens the database at module scope. Node caches that module, so a **second** call inside the same file would silently keep using the **first** database while helpers read the newer path. Vitest isolates each test *file*, so the rule is: exactly one `startTestServer()` per file, in a single top-level `beforeAll`, shared by every `describe` in that file. Tasks 5 and 8 append `describe` blocks to this file and reuse the same `srv`.

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './testServer.js';

// One server for the whole file. See the note above.
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('auth: email verification state', () => {
  it('returns emailVerified on the user object', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body).toHaveProperty('emailVerified');
  });

  it('marks a seeded user verified when verification is not required', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.body.emailVerified).toBe(true);
  });

  it('marks a new signup verified when verification is not required', async () => {
    const res = await srv.call('POST', '/api/auth/signup', {
      email: 'verify.check@example.org', password: 'password123',
      name: 'Verify Check', role: 'student', grade: '10'
    });
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes.auth.test.js`

Expected: FAIL — all three fail; the first with `expected { id: …, name: … } to have property "emailVerified"`.

- [ ] **Step 3: Add the config flag**

Append to `server/config.js`:

```js
/**
 * Whether a new account must confirm its email address before using the app.
 *
 * Off by default: turning it on without a working SMTP transport locks every
 * user out with no way through. Turn it on once SMTP_* is configured (see
 * Task 6 / README).
 */
export const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
```

- [ ] **Step 4: Return `emailVerified` from `formatUserResponse`**

In `server/utils.js`, add `emailVerified` to the returned object (after `verified`):

```js
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    grade: row.grade,
    role: row.role,
    verified: row.verified === 1,
    emailVerified: row.email_verified === 1,
    avatar: row.avatar,
    volunteeredHours: totalHours,
    bio: row.bio,
    school: row.school,
    skills: row.skills ? JSON.parse(row.skills) : [],
    createdAt: row.created_at
  };
```

- [ ] **Step 5: Set `email_verified` at signup**

In `server/routes/authRoutes.js`, add `REQUIRE_EMAIL_VERIFICATION` to the config import on line 6. Then after the existing line 40 (`const verifiedVal = ...`), add:

```js
    // When verification is not required there is nothing to confirm, so the
    // address counts as settled. Task 6 sends the confirmation mail when it is.
    const emailVerifiedVal = REQUIRE_EMAIL_VERIFICATION ? 0 : 1;
```

Change the INSERT to include the column — replace the statement and its `.run(...)`:

```js
    const stmt = db.prepare(`
      INSERT INTO users (id, name, email, password_hash, grade, role, verified, email_verified, avatar, bio, school, skills, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(userId, name, email, passwordHash, grade, role, verifiedVal, emailVerifiedVal, avatar || '👤', bio || '', school || '', skillsJSON, new Date().toISOString());
```

- [ ] **Step 6: Backfill existing users when verification is off**

Email verification has never worked, so no existing row's `email_verified = 0` represents a real pending confirmation. In `server/db.js`, widen the config import added in Task 3 Step 3 from:

```js
import { DEMO_MODE } from './config.js';
```

to:

```js
import { DEMO_MODE, REQUIRE_EMAIL_VERIFICATION } from './config.js';
```

Then replace lines 221–225:

```js
  const addedEmailVerified = addColumnIfMissing('users', 'email_verified', 'INTEGER DEFAULT 0');
  if (addedEmailVerified) {
    // Migrate existing users to be verified so they aren't locked out
    db.exec('UPDATE users SET email_verified = 1');
  }
```

with:

```js
  addColumnIfMissing('users', 'email_verified', 'INTEGER DEFAULT 0');
  if (!REQUIRE_EMAIL_VERIFICATION) {
    // Nothing to confirm while the feature is off, and a stale 0 would put an
    // otherwise-fine account behind a wall it cannot get past. Idempotent, and
    // it stops applying the moment verification is switched on.
    db.exec('UPDATE users SET email_verified = 1 WHERE email_verified = 0');
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run server/routes.auth.test.js`

Expected: PASS, 3 tests.

- [ ] **Step 8: Verify the lockout is gone in the browser**

```bash
npm run dev
```

Sign in at `http://localhost:5173` as `leo.chen28@gmail.com` / `password123`.

Expected: the dashboard loads. **Before this task it showed "Verify your email" with no way through.**

- [ ] **Step 9: Run the full suite and commit**

```bash
npm test
git add server/config.js server/utils.js server/db.js server/routes/authRoutes.js server/routes.auth.test.js
git commit -m "fix: return emailVerified so users are not locked out of the app

App.jsx gates the whole application on currentUser.emailVerified, which the
server never returned — so !undefined was true for every user and everyone hit
an inescapable 'Verify your email' wall whose resend button 404s.

Adds emailVerified to formatUserResponse and a REQUIRE_EMAIL_VERIFICATION flag
(default off) so a pilot without SMTP is not gated on mail nobody can send."
```

---

## Task 5: Password reset

`ResetPassword.jsx` and the "Forgot password" link on `Login.jsx` both call endpoints that do not exist. The `password_reset_tokens` table and `sendPasswordResetEmail()` are already written and unused. A forgotten password is currently an unrecoverable account — the highest-volume support request a school system generates.

**Files:**
- Modify: `server/routes/authRoutes.js` (add two routes)
- Test: `server/routes.auth.test.js` (extend)

**Interfaces:**
- Consumes: `password_reset_tokens(token, user_id, expires_at)` from `db.js`; `sendPasswordResetEmail(toEmail, token)` from `email.js`; `authLimiter` from `app.js`.
- Produces: `POST /api/auth/forgot-password` `{email}` → `{success, message}` (always 200). `POST /api/auth/reset-password` `{token, password}` → `{success}` or 400.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes.auth.test.js`. It reuses the file-level `srv` and the `DatabaseSync` import already added in Task 4 — **do not** start a second server (see the note in Task 4 Step 1):

```js
describe('auth: password reset', () => {
  const tokenFor = (userId) => {
    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    const row = db.prepare(
      'SELECT token FROM password_reset_tokens WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1'
    ).get(userId);
    db.close();
    return row?.token;
  };

  it('issues a reset token for a known address', async () => {
    const res = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    expect(res.status).toBe(200);
    expect(tokenFor('user-student-1')).toBeTruthy();
  });

  it('does not reveal whether an address exists', async () => {
    const known = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    const unknown = await srv.call('POST', '/api/auth/forgot-password', { email: 'nobody@example.org' });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('resets the password and lets the user sign in with it', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    const token = tokenFor('user-student-1');

    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'brand-new-pass' });
    expect(res.status).toBe(200);

    const relogin = await srv.call('POST', '/api/auth/login', {
      email: 'leo.chen28@gmail.com', password: 'brand-new-pass'
    });
    expect(relogin.status).toBe(200);
  });

  it('burns the token so it cannot be replayed', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'priya.patel.nhs@outlook.com' });
    const token = tokenFor('user-student-2');

    const first = await srv.call('POST', '/api/auth/reset-password', { token, password: 'first-change' });
    expect(first.status).toBe(200);

    const replay = await srv.call('POST', '/api/auth/reset-password', { token, password: 'second-change' });
    expect(replay.status).toBe(400);
  });

  it('rejects an expired token', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'emiller2027@gmail.com' });
    const token = tokenFor('user-student-3');

    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    db.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token = ?')
      .run('2020-01-01T00:00:00.000Z', token);
    db.close();

    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'too-late-pass' });
    expect(res.status).toBe(400);
  });

  it('rejects a password below the minimum length', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'advait.g@yahoo.com' });
    const token = tokenFor('user-advait');
    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'abc' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes.auth.test.js`

Expected: FAIL — the reset tests fail with 404 responses (`expected 404 to be 200`).

- [ ] **Step 3: Implement both routes**

**Do not import `authLimiter` into this router.** `app.js` imports the routers before it defines `authLimiter`, so `import { authLimiter } from '../app.js'` reads an uninitialised binding and the server dies at boot with `ReferenceError: Cannot access 'authLimiter' before initialization`.

Rate limits are mounted by path in `app.js`, which already does exactly this for login and signup. Add two lines there, beside the existing pair:

```js
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
```

This keeps rate-limiting policy in one place and leaves the routers free of any dependency on `app.js`.

Then add these two routes to `server/routes/authRoutes.js`, immediately after the `GET /api/auth/me` handler (after line 104) — note there is no `authLimiter` argument in the route signatures:

```js
/**
 * Step 1 of password reset: issue a single-use, expiring token and mail it.
 *
 * The response is identical whether or not the address is registered — a
 * differing response here is an account-enumeration oracle, and this endpoint
 * is unauthenticated.
 */
router.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const SAME_ANSWER = {
    success: true,
    message: 'If that address has an account, a reset link is on its way.'
  };

  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    // COLLATE NOCASE: someone typing Leo.Chen@… who registered leo.chen@…
    // should still get their mail, not silence.
    const user = db.prepare('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE').get(String(email).trim());

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      // One live token per user: issuing a new link invalidates the old one.
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
      db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
        .run(token, user.id, expiresAt);

      await sendPasswordResetEmail(user.email, token);
    }

    res.json(SAME_ANSWER);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json(SAME_ANSWER);
  }
});

/** Step 2: exchange the token for a new password. Single use. */
router.post('/api/auth/reset-password', (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  try {
    const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
    if (!row) {
      return res.status(400).json({ error: 'That reset link is not valid. Request a new one.' });
    }

    if (new Date(row.expires_at) < new Date()) {
      db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That reset link has expired. Request a new one.' });
    }

    const passwordHash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));

    inTransaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id);
      db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not reset the password' });
  }
});
```

`crypto`, `bcrypt`, `inTransaction` and `sendPasswordResetEmail` are already imported at the top of this file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/routes.auth.test.js`

Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the flow end to end in the browser**

```bash
npm run dev
```

1. At `http://localhost:5173/login`, click "Forgot password", enter `leo.chen28@gmail.com`, submit.
2. Read the reset link from the **server terminal** — with no SMTP configured, `email.js` prints the message to the console:
   ```
   =================== EMAIL SENT ===================
   To:      leo.chen28@gmail.com
   Subject: Password Reset - SBVolunteers
   ```
3. Open the printed `http://localhost:5173/?reset=<token>` URL. `App.jsx:131` redirects to `/reset-password?token=…`.
4. Set a new password, then sign in with it.

Expected: sign-in succeeds with the new password.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
git add server/routes/authRoutes.js server/routes.auth.test.js
git commit -m "feat: implement password reset

ResetPassword.jsx and the Login 'forgot password' link both called endpoints
that did not exist, so a forgotten password was an unrecoverable account. The
password_reset_tokens table and sendPasswordResetEmail() were already written
and unused.

Tokens are single-use, expire in an hour, and issuing one invalidates the
previous. The forgot-password response is identical for known and unknown
addresses so it cannot be used to enumerate accounts."
```

---

## Task 6: Email verification

`POST /api/auth/verify-email` and `/api/auth/resend-verification` are called by `App.jsx:124` and `App.jsx:336` and do not exist. The `email_verification_tokens` table and `sendVerificationEmail()` are written and unused. Task 4 made the gate satisfiable by defaulting the requirement off; this task makes it work so the flag can be turned on once SMTP exists.

**Files:**
- Modify: `server/routes/authRoutes.js` (add two routes, send mail at signup)
- Modify: `README.md`
- Test: `server/routes.verification.test.js` (create)

**Interfaces:**
- Consumes: `email_verification_tokens(token, user_id, expires_at)`; `sendVerificationEmail(toEmail, token)`; `REQUIRE_EMAIL_VERIFICATION` from `config.js`.
- Produces: `POST /api/auth/verify-email` `{token}` → `{success}` or 400. `POST /api/auth/resend-verification` (authenticated, no body) → `{success}`.

- [ ] **Step 1: Write the failing tests**

Create `server/routes.verification.test.js`. This suite needs the flag **on**, so it sets the env var before importing the harness:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('auth: email verification (flag on)', () => {
  let srv;

  beforeAll(async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  });

  const tokenFor = (userId) => {
    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    const row = db.prepare(
      'SELECT token FROM email_verification_tokens WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1'
    ).get(userId);
    db.close();
    return row?.token;
  };

  const signup = (email) => srv.call('POST', '/api/auth/signup', {
    email, password: 'password123', name: 'Test Person', role: 'student', grade: '10'
  });

  it('creates a new account unverified and issues a token', async () => {
    const res = await signup('unverified@example.org');
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
    expect(tokenFor(res.body.user.id)).toBeTruthy();
  });

  it('marks the account verified when the token is presented', async () => {
    const res = await signup('confirms@example.org');
    const token = tokenFor(res.body.user.id);

    const verify = await srv.call('POST', '/api/auth/verify-email', { token });
    expect(verify.status).toBe(200);

    const me = await srv.call('GET', '/api/auth/me', undefined, res.body.token);
    expect(me.body.emailVerified).toBe(true);
  });

  it('rejects an unknown token', async () => {
    const res = await srv.call('POST', '/api/auth/verify-email', { token: 'not-a-real-token' });
    expect(res.status).toBe(400);
  });

  it('burns the token so it cannot be replayed', async () => {
    const res = await signup('replay@example.org');
    const token = tokenFor(res.body.user.id);
    expect((await srv.call('POST', '/api/auth/verify-email', { token })).status).toBe(200);
    expect((await srv.call('POST', '/api/auth/verify-email', { token })).status).toBe(400);
  });

  it('resends a fresh token to the signed-in user', async () => {
    const res = await signup('resend@example.org');
    const first = tokenFor(res.body.user.id);

    const resend = await srv.call('POST', '/api/auth/resend-verification', undefined, res.body.token);
    expect(resend.status).toBe(200);
    expect(tokenFor(res.body.user.id)).not.toBe(first);
  });

  it('requires authentication to resend', async () => {
    const res = await srv.call('POST', '/api/auth/resend-verification');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes.verification.test.js`

Expected: FAIL — 404s from the missing routes.

- [ ] **Step 3: Add a token helper and send mail at signup**

In `server/routes/authRoutes.js`, add this helper just above the signup route:

```js
/** Issues a fresh email-confirmation token, replacing any previous one. */
function issueVerificationToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expiresAt);
  return token;
}
```

Then in the signup handler, immediately after the `const user = formatUserResponse(userRow);` line, add:

```js
    if (REQUIRE_EMAIL_VERIFICATION) {
      const verifyToken = issueVerificationToken(userId);
      sendVerificationEmail(email, verifyToken).catch(err =>
        console.error('Verification email failed to send:', err)
      );
    }
```

- [ ] **Step 4: Implement both routes**

Rate-limit the new endpoint by path in `app.js`, beside the ones added in Task 5 — do **not** import `authLimiter` into the router (it creates a boot-time circular import):

```js
app.use('/api/auth/verify-email', authLimiter);
```

Then add these routes to `server/routes/authRoutes.js`, after the reset-password route from Task 5:

```js
/** Confirms an address from the link in the welcome email. Single use. */
router.post('/api/auth/verify-email', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const row = db.prepare('SELECT * FROM email_verification_tokens WHERE token = ?').get(token);
    if (!row) {
      return res.status(400).json({ error: 'That confirmation link is not valid. Request a new one.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That confirmation link has expired. Request a new one.' });
    }

    inTransaction(() => {
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
      db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Could not confirm that address' });
  }
});

/** Sends a fresh confirmation link to the signed-in user's own address. */
router.post('/api/auth/resend-verification', authenticateToken, async (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified === 1) {
      return res.json({ success: true, message: 'That address is already confirmed.' });
    }

    const token = issueVerificationToken(user.id);
    await sendVerificationEmail(user.email, token);

    res.json({ success: true });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Could not resend the confirmation email' });
  }
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/routes.verification.test.js`

Expected: PASS, 6 tests.

- [ ] **Step 6: Confirm the default-off path is untouched**

Run: `npx vitest run server/routes.auth.test.js`

Expected: PASS — Task 4's tests still assert `emailVerified === true` with the flag off.

- [ ] **Step 7: Document the flag in README.md**

Add to the server env var table:

```markdown
| `REQUIRE_EMAIL_VERIFICATION` | `false`                          | When `true`, a new account must click a confirmation link before using the app. **Only turn this on once `SMTP_*` is configured** — without a working transport it locks every new user out. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | unset | Transactional mail transport. With any of these unset, mail is printed to the server console instead of being sent. |
| `APP_URL`      | `https://sbvolunteers.org` in production | Base URL used to build confirmation and password-reset links. |
```

- [ ] **Step 8: Run the full suite and commit**

```bash
npm test
git add server/routes/authRoutes.js server/routes.verification.test.js README.md
git commit -m "feat: implement email verification endpoints

App.jsx called /api/auth/verify-email and /api/auth/resend-verification; both
404'd. The email_verification_tokens table and sendVerificationEmail() were
written and unused.

Tokens are single-use and expire in 24h. Gated behind
REQUIRE_EMAIL_VERIFICATION so it stays off until SMTP is configured."
```

---

## Task 7: Withdrawal and re-application

The client sends `status: 'withdrawn'`; the server rejects anything but `'rejected'` with a 403, so **the withdraw button does nothing**. The `withdrawn` status was added to the schema CHECK constraint and a full table migration was written, but the handler still writes `'rejected'` — so a student who withdraws is told they were "Not selected", and is permanently barred from re-applying because the apply endpoint blocks on *any* existing row.

**Files:**
- Modify: `server/routes/applicationRoutes.js:191-255` (student branch)
- Modify: `server/routes/applicationRoutes.js:145-157` (apply: allow re-application)
- Test: `server/routes.applications.test.js` (create)

**Interfaces:**
- Consumes: `startTestServer` from Task 2.
- Produces: students may `PATCH /api/applications/:id` with `{status:'withdrawn'}`. `POST /api/events/:id/apply` updates an existing `withdrawn` row in place rather than rejecting it (respecting `UNIQUE(user_id, slot_id)`).

- [ ] **Step 1: Write the failing tests**

Create `server/routes.applications.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('applications: withdrawal and re-application', () => {
  let srv, studentToken, eventId, slotId;

  beforeAll(async () => {
    srv = await startTestServer();
    studentToken = await srv.login('leo.chen28@gmail.com');
    const events = (await srv.call('GET', '/api/events')).body;
    const ev = events.find(e => e.status === 'open' && e.slots.length > 0);
    eventId = ev.id;
    slotId = ev.slots.find(s => s.spotsRemaining > 0).id;
  });
  afterAll(async () => { await srv.close(); });

  const apply = () => srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, studentToken);
  const myApp = async () => {
    const apps = (await srv.call('GET', '/api/applications', undefined, studentToken)).body;
    return apps.find(a => a.slotId === slotId);
  };

  it('accepts the withdrawn status the client actually sends', async () => {
    await apply();
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'withdrawn' }, studentToken);
    expect(res.status).toBe(200);
  });

  it('records it as withdrawn, not rejected', async () => {
    expect((await myApp()).status).toBe('withdrawn');
  });

  it('lets the student re-apply to the same shift', async () => {
    const res = await apply();
    expect(res.status).toBe(201);
    expect((await myApp()).status).toBe('pending');
  });

  it('still blocks a duplicate application while one is live', async () => {
    const res = await apply();
    expect(res.status).toBe(400);
  });

  it('does not let a student withdraw someone elses application', async () => {
    const other = await srv.login('priya.patel.nhs@outlook.com');
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'withdrawn' }, other);
    expect(res.status).toBe(403);
  });

  it('does not let a student self-accept', async () => {
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'accepted' }, studentToken);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes.applications.test.js`

Expected: FAIL — the first test gets 403 (`Students may only withdraw (reject) their own applications.`).

- [ ] **Step 3: Accept `withdrawn` in the student branch**

In `server/routes/applicationRoutes.js`, replace lines 191–193:

```js
  if (req.user.role === 'student') {
    if (status !== 'rejected') {
      return res.status(403).json({ error: 'Students may only withdraw (reject) their own applications.' });
    }
```

with:

```js
  if (req.user.role === 'student') {
    // 'rejected' is still accepted so an older client build keeps working.
    // Both mean the same act; only 'withdrawn' is stored, because a student
    // leaving is not the same event as an organizer turning them down.
    if (status !== 'withdrawn' && status !== 'rejected') {
      return res.status(403).json({ error: 'Students may only withdraw their own applications.' });
    }
```

- [ ] **Step 4: Store `withdrawn` and report it back**

Still in the student branch, replace line 218:

```js
      db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('rejected', appId);
```

with:

```js
      db.prepare('UPDATE applications SET status = ?, waitlist_order = NULL WHERE id = ?')
        .run('withdrawn', appId);
```

And in the same branch's success response (line 246–250), change the reported status:

```js
      return res.json({
        success: true,
        released: wasConfirmed,
        application: { id: appId, status: 'withdrawn' }
      });
```

- [ ] **Step 5: Allow re-application over a withdrawn row**

Replace lines 145–157 of `server/routes/applicationRoutes.js`:

```js
    // Check if already signed up for this specific slot
    const exists = db.prepare('SELECT COUNT(*) as count FROM applications WHERE slot_id = ? AND user_id = ?').get(slotId, req.user.id);
    if (exists.count > 0) {
      return res.status(400).json({ error: 'You have already applied for this time slot' });
    }

    let status = 'pending';

    const appId = `app-${Date.now()}`;
    db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(appId, req.user.id, eventId, slotId, status, new Date().toISOString());
```

with:

```js
    // A withdrawn application is not a live one. Withdrawing by mistake should
    // cost the student nothing while applications are still open, so the old
    // row is revived rather than blocking — UNIQUE(user_id, slot_id) means a
    // second INSERT is not an option.
    const existing = db.prepare(
      'SELECT id, status FROM applications WHERE slot_id = ? AND user_id = ?'
    ).get(slotId, req.user.id);

    const status = 'pending';
    const appliedAt = new Date().toISOString();
    let appId;

    if (existing && existing.status !== 'withdrawn') {
      return res.status(400).json({ error: 'You have already applied for this time slot' });
    } else if (existing) {
      appId = existing.id;
      db.prepare('UPDATE applications SET status = ?, applied_at = ?, waitlist_order = NULL WHERE id = ?')
        .run(status, appliedAt, appId);
    } else {
      appId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(appId, req.user.id, eventId, slotId, status, appliedAt);
    }
```

Then update the response block below it to use `appliedAt` instead of a second `new Date().toISOString()` call, so the stored and returned timestamps match:

```js
    res.status(201).json({
      success: true,
      application: { id: appId, eventId, slotId, userId: req.user.id, status, appliedAt }
    });
```

The id now carries a random suffix, closing a collision when two students apply in the same millisecond.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/routes.applications.test.js`

Expected: PASS, 6 tests.

- [ ] **Step 7: Check every place that reads application status**

Search for status comparisons that now need to account for `withdrawn`:

```bash
grep -rn "'rejected'" src server --include="*.js" --include="*.jsx" | grep -v node_modules | grep -v test
```

For each hit, confirm whether `withdrawn` belongs alongside it. Two known cases to fix:

1. `server/utils.js:141` — the deadline-reminder sweep excludes users with any application where `a.status != 'rejected'`. Change to `a.status NOT IN ('rejected', 'withdrawn')` so a student who withdrew still gets reminded before the deadline.
2. Client status labels — wherever the student's own application status is rendered, `withdrawn` must read **"Withdrawn"**, not "Not selected". Check `src/views/VolunteerDashboard.jsx` and `src/components/EventModal.jsx` for the status label map and add the case.

- [ ] **Step 8: Verify in the browser**

```bash
npm run dev
```

As `leo.chen28@gmail.com`: apply to an open shift, withdraw it, confirm the dashboard says **"Withdrawn"** (not "Not selected"), then apply to the same shift again.

Expected: re-application succeeds.

- [ ] **Step 9: Run the full suite and commit**

```bash
npm test
git add server/routes/applicationRoutes.js server/utils.js src/ server/routes.applications.test.js
git commit -m "fix: make withdrawal work and allow re-application

The client sent status:'withdrawn' and the server 403'd anything but
'rejected', so the withdraw button did nothing. The withdrawn status had
already been added to the schema and migrated; only the handler was missed.

Withdrawing now stores 'withdrawn' (so a student is no longer told they were
'Not selected' for a shift they chose to leave) and re-applying revives the
row instead of being blocked forever."
```

---

## Task 8: Persist the username

Signup requires a username, validates it client-side, and sends it. The server's handler never destructures it, so every user is created with `username = NULL`. The form promises "This will be your public alias. Avoid using your real name if you prefer privacy" — a privacy promise the platform does not keep. Uniqueness is also unenforced, so two students can both "claim" the same name.

**Files:**
- Modify: `server/routes/authRoutes.js` (signup)
- Test: `server/routes.auth.test.js` (extend)

**Interfaces:**
- Consumes: `users.username` column and `idx_users_username` partial unique index, both already in `db.js`.
- Produces: signup accepts and stores `username`; rejects duplicates with 400 and invalid formats with 400. `formatUserResponse` gains `username`.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes.auth.test.js`. Reuses the file-level `srv` — **do not** start a second server:

```js
describe('auth: username', () => {
  const signup = (over = {}) => srv.call('POST', '/api/auth/signup', {
    email: `u${Math.random().toString(36).slice(2, 9)}@example.org`,
    password: 'password123', name: 'Some Person', role: 'student', grade: '10',
    username: `u${Math.random().toString(36).slice(2, 9)}`,
    ...over
  });

  it('stores the username the signup form sends', async () => {
    const res = await signup({ username: 'alex_r' });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('alex_r');
  });

  it('rejects a duplicate username', async () => {
    await signup({ username: 'taken_name' });
    const res = await signup({ username: 'taken_name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it('rejects a duplicate regardless of case', async () => {
    await signup({ username: 'casecheck' });
    const res = await signup({ username: 'CaseCheck' });
    expect(res.status).toBe(400);
  });

  it('rejects characters the signup form does not allow', async () => {
    const res = await signup({ username: 'bad name!' });
    expect(res.status).toBe(400);
  });

  it('rejects a username that is too short or too long', async () => {
    expect((await signup({ username: 'ab' })).status).toBe(400);
    expect((await signup({ username: 'a'.repeat(21) })).status).toBe(400);
  });

  it('requires a username', async () => {
    const res = await signup({ username: undefined });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes.auth.test.js`

Expected: FAIL — the first fails with `expected undefined to be 'alex_r'`.

- [ ] **Step 3: Validate and store the username**

In `server/routes/authRoutes.js`, add `username` to the signup destructure on line 15:

```js
  const { email, password, name, username, role, grade, avatar, bio, school, skills } = req.body;
```

Add validation after the existing password-length check (after line 30) — the rules mirror `Signup.jsx:29-31` exactly, so the client and server agree:

```js
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) {
    return res.status(400).json({ error: 'Choose a username' });
  }
  if (cleanUsername.length < 3 || cleanUsername.length > 20) {
    return res.status(400).json({ error: 'Username must be between 3 and 20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Username may use letters, numbers, and underscores only' });
  }

  // The unique index is case-sensitive, but two people cannot meaningfully be
  // told apart by capitalisation alone — check the way a person would read it.
  const usernameTaken = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(cleanUsername);
  if (usernameTaken) {
    return res.status(400).json({ error: 'That username is already taken' });
  }
```

Extend the INSERT built in Task 4 to carry the column:

```js
    const stmt = db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, email_verified, avatar, bio, school, skills, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(userId, name, email, cleanUsername, passwordHash, grade, role, verifiedVal, emailVerifiedVal, avatar || '👤', bio || '', school || '', skillsJSON, new Date().toISOString());
```

Also extend the UNIQUE-violation handler at line 56 so the message names the right field:

```js
    if (error.message.includes('UNIQUE')) {
      const field = error.message.includes('username') ? 'Username' : 'Email address';
      return res.status(400).json({ error: `${field} already registered` });
    }
```

- [ ] **Step 4: Expose `username` on the user object**

In `server/utils.js`, add to the `formatUserResponse` return (after `name`):

```js
    username: row.username || null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/routes.auth.test.js`

Expected: PASS, 15 tests.

- [ ] **Step 6: Backfill usernames for seeded and pre-existing users**

`server/migrate_usernames.js` already derives a username from each user's email and de-duplicates. Confirm it runs against the dev database:

```bash
node server/migrate_usernames.js
```

Expected: prints `- <email> -> @<username>` per user, or `Found 0 users needing a username.`

- [ ] **Step 7: Verify in the browser**

```bash
npm run dev
```

Create a new account with username `test_alias`. Then attempt a second account with `TEST_ALIAS`.

Expected: the first succeeds; the second is refused with "That username is already taken", shown in the form's error area.

- [ ] **Step 8: Run the full suite and commit**

```bash
npm test
git add server/routes/authRoutes.js server/utils.js server/routes.auth.test.js
git commit -m "fix: persist the username collected at signup

Signup.jsx requires a username, validates it, and sends it; the server never
destructured it, so every user was created with username = NULL and the form's
promise that it is 'your public alias' was never kept. Uniqueness was likewise
unenforced.

Validation mirrors the client rules exactly, and the taken-name check is
case-insensitive."
```

---

## Task 9: Repair the day-of check-in screen

`CheckInView` is the organizer's on-the-day tool and it is entirely dead, from two independent defects:

1. It calls `api.fetchEventDetails(eventId)`, which is not defined in `api.js`, and there is no `GET /api/events/:id` route either. The `TypeError` is swallowed by `.catch` and the screen renders "Cannot load check-in".
2. It sends check-in keys as `` `${slotId}:${userId}` ``, but `recordCheckins` treats each key as an **application id**. Every entry lands in `skipped` with `marked: 0` — and because the response is HTTP 200 `{success:true}`, the client reports success while recording nothing.

**Files:**
- Modify: `server/routes/eventRoutes.js` (add `GET /api/events/:id`)
- Modify: `src/utils/api.js` (add `fetchEventDetails`)
- Modify: `src/views/CheckInView.jsx:30-93`
- Test: `server/routes.checkin.test.js` (create)

**Interfaces:**
- Consumes: `getCheckins`, `recordCheckins` from `attendance.js` (unchanged).
- Produces: `GET /api/events/:id` → `{ event: {...same shape as one element of GET /api/events...}, applications: [...] }`, organizer/admin only. `api.fetchEventDetails(eventId)` returns that object.

- [ ] **Step 1: Write the failing tests**

Create `server/routes.checkin.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('check-in', () => {
  let srv, orgToken, eventId, application;

  beforeAll(async () => {
    srv = await startTestServer();
    orgToken = await srv.login('jkatzenback@vikings.org');
    const apps = (await srv.call('GET', '/api/applications', undefined, orgToken)).body;
    application = apps.find(a => a.status === 'accepted');
    eventId = application.eventId;
  });
  afterAll(async () => { await srv.close(); });

  it('serves a single event with its applications', async () => {
    const res = await srv.call('GET', `/api/events/${eventId}`, undefined, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe(eventId);
    expect(Array.isArray(res.body.event.slots)).toBe(true);
    expect(Array.isArray(res.body.applications)).toBe(true);
  });

  it('refuses a single event to a student', async () => {
    const student = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('GET', `/api/events/${eventId}`, undefined, student);
    expect(res.status).toBe(403);
  });

  it('404s an unknown event', async () => {
    const res = await srv.call('GET', '/api/events/does-not-exist', undefined, orgToken);
    expect(res.status).toBe(404);
  });

  it('records a check-in keyed by application id', async () => {
    const res = await srv.call('POST', `/api/events/${eventId}/checkin`,
      { checkinMap: { [application.id]: true } }, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(res.body.skipped).toEqual([]);
  });

  it('reads the mark back', async () => {
    const res = await srv.call('GET', `/api/events/${eventId}/checkin`, undefined, orgToken);
    const mark = res.body.find(c => c.userId === application.userId && c.slotId === application.slotId);
    expect(mark.present).toBe(true);
  });

  it('reports keys it could not match rather than silently dropping them', async () => {
    const res = await srv.call('POST', `/api/events/${eventId}/checkin`,
      { checkinMap: { 'slot-x:user-y': true } }, orgToken);
    expect(res.body.marked).toBe(0);
    expect(res.body.skipped).toContain('slot-x:user-y');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes.checkin.test.js`

Expected: FAIL — the first three fail with 404 (no such route). The check-in tests pass already, which is the point: the server side is correct and the client was calling it wrongly.

- [ ] **Step 3a: Extract the slot-shaping helper**

Both `GET /api/events` and the new `GET /api/events/:id` must present a slot identically — two copies would drift. Add this helper near the top of `server/routes/eventRoutes.js`, just below the `const router = express.Router();` line:

```js
/**
 * One slot as the client consumes it. Shared by the list and single-event
 * routes so the two can never disagree about what a slot looks like.
 *
 * `acceptedCount` is passed in rather than queried here: callers already
 * batch-load it, and doing it per slot would reintroduce an N+1.
 */
export function formatSlot(s, acceptedCount = 0) {
  const hours = Math.max(0.1, Number(
    ((new Date(s.end_datetime) - new Date(s.start_datetime)) / (1000 * 60 * 60)).toFixed(2)
  ));
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    startDatetime: s.start_datetime,
    endDatetime: s.end_datetime,
    maxSpots: Number(s.max_spots),
    spotsRemaining: Math.max(0, s.max_spots - acceptedCount),
    hours
  };
}
```

Then replace the inline shaping inside `GET /api/events` (lines 46–63) — the block beginning `const formattedSlots = slots.map(s => {` and ending at its closing `});` — with:

```js
      const formattedSlots = slots.map(s => formatSlot(s, acceptedBySlot.get(s.id) || 0));
```

This is a pure extraction: the arithmetic and field names are unchanged, so `GET /api/events` must return byte-identical output. The smoke test from Task 2 covers that it still responds; verify the shape by eye in Step 6.

- [ ] **Step 3b: Add `GET /api/events/:id`**

Add this route immediately after the `GET /api/events` handler. It uses `formatSlot` so the client sees one consistent event shape:

```js
/**
 * One event with its applications, for the organizer's own screens.
 *
 * Staff-only: it carries the applicant roster, which is not something a
 * student may enumerate for an event they are not running.
 */
router.get('/api/events/:id', authenticateToken, (req, res) => {
  try {
    const event = db.prepare(`
      SELECT e.*, u.name as organizer_name, u.verified as organizer_verified,
             u.school as organizer_school
      FROM events e JOIN users u ON e.organizer_id = u.id
      WHERE e.id = ?
    `).get(req.params.id);

    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isStaff = req.user.role === 'admin' ||
      (req.user.role === 'organizer' && event.organizer_id === req.user.id);
    if (!isStaff) return res.status(403).json({ error: 'Access denied: You do not host this event' });

    const slots = db.prepare('SELECT * FROM slots WHERE event_id = ?').all(event.id);
    const acceptedBySlot = new Map();
    for (const r of db.prepare(`
      SELECT slot_id, COUNT(*) as count FROM applications
      WHERE event_id = ? AND status = 'accepted' GROUP BY slot_id
    `).all(event.id)) {
      acceptedBySlot.set(r.slot_id, r.count);
    }

    const formattedSlots = slots.map(s => formatSlot(s, acceptedBySlot.get(s.id) || 0));

    const applications = db.prepare(`
      SELECT a.id, a.user_id, a.event_id, a.slot_id, a.status, a.applied_at,
             u.name, u.avatar, u.grade, u.school
      FROM applications a JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ?
      ORDER BY u.name
    `).all(event.id).map(a => ({
      id: a.id,
      userId: a.user_id,
      eventId: a.event_id,
      slotId: a.slot_id,
      status: a.status,
      appliedAt: a.applied_at,
      volunteer: { id: a.user_id, name: a.name, avatar: a.avatar, grade: a.grade, school: a.school }
    }));

    res.json({
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        category: event.category,
        location: event.location,
        instructions: event.instructions || '',
        applicationDeadline: event.application_deadline,
        organizerId: event.organizer_id,
        organizerName: event.organizer_name,
        status: event.status,
        autoApprove: event.auto_approve === 1,
        slots: formattedSlots
      },
      applications
    });
  } catch (err) {
    console.error('Fetch event error:', err);
    res.status(500).json({ error: 'Failed to load event' });
  }
});
```

`authenticateToken` is already imported in this file.

- [ ] **Step 4: Add `fetchEventDetails` to the client API**

In `src/utils/api.js`, add to the Events section after `fetchEvents`:

```js
  fetchEventDetails: async (eventId) => apiFetch(`/api/events/${eventId}`),
```

- [ ] **Step 5: Send application ids from CheckInView**

In `src/views/CheckInView.jsx`, replace `toggleCheckin` (lines 55–72):

```js
  const toggleCheckin = async (app) => {
    const key = `${app.slotId}:${app.userId}`;
    const currentlyPresent = !!checkins.get(key);
    const newPresent = !currentlyPresent;

    // Optimistic update
    setCheckins(prev => new Map(prev).set(key, newPresent));

    try {
      // The server keys check-in marks by application id, not slot:user.
      const res = await api.submitCheckins(eventId, { [app.id]: newPresent });
      if (res.marked !== 1) {
        throw new Error('The server did not record that mark.');
      }
    } catch (err) {
      setCheckins(prev => new Map(prev).set(key, currentlyPresent));
      alert(`Could not save check-in: ${err.message}`);
    }
  };
```

And `markAll` (lines 74–93):

```js
  const markAll = async (slotId, present) => {
    const appsInSlot = applications.filter(a => a.slotId === slotId);
    const updates = {};
    const optimisticMap = new Map(checkins);

    appsInSlot.forEach(app => {
      updates[app.id] = present;
      optimisticMap.set(`${app.slotId}:${app.userId}`, present);
    });

    const previous = new Map(checkins);
    setCheckins(optimisticMap);
    try {
      const res = await api.submitCheckins(eventId, updates);
      if (res.marked !== appsInSlot.length) {
        throw new Error(`Only ${res.marked} of ${appsInSlot.length} marks were recorded.`);
      }
    } catch (err) {
      setCheckins(previous);
      alert(`Could not save check-ins: ${err.message}`);
    }
  };
```

The `window.location.reload()` goes away — reverting to the previous map is enough, and reloading mid-event on a phone is the worst possible recovery.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/routes.checkin.test.js`

Expected: PASS, 6 tests.

- [ ] **Step 7: Verify the screen works in the browser**

```bash
npm run dev
```

Sign in as `jkatzenback@vikings.org` / `password123`, open the Softball Tournament event, click through to check-in (`/checkin/event-softball`).

Expected: the roster renders (it previously showed "Cannot load check-in"). Tap a volunteer — the row highlights. Reload the page and confirm the mark **persisted**. Before this task, every tap silently recorded nothing.

- [ ] **Step 8: Run the full suite and commit**

```bash
npm test
git add server/routes/eventRoutes.js src/utils/api.js src/views/CheckInView.jsx server/routes.checkin.test.js
git commit -m "fix: repair the day-of check-in screen

Two independent defects made it entirely non-functional:
- it called api.fetchEventDetails(), which was never defined, and no
  GET /api/events/:id route existed — the TypeError was swallowed and the
  screen rendered 'Cannot load check-in'
- it keyed check-in marks by slotId:userId while the server keys them by
  application id, so every mark landed in 'skipped' with marked:0 while the
  client reported success

The client now checks the marked count instead of trusting HTTP 200."
```

---

## Task 10: Verify the full P0 surface

A final pass proving every P0 from the audit is closed, and that nothing regressed.

**Files:** none modified.

- [ ] **Step 1: Clean-install and build**

```bash
rm -rf node_modules server/node_modules
npm ci
npm ci --prefix server
npm run build
```

Expected: build succeeds, `dist/` written.

- [ ] **Step 2: Full test suite**

Run: `npm test`

Expected: all pass. Roughly 115 tests across 11 files (82 pre-existing + ~33 added).

- [ ] **Step 3: Fresh production-shaped database comes up empty**

```bash
rm -rf /tmp/sbv-prod-check && mkdir -p /tmp/sbv-prod-check
SBV_DB_PATH=/tmp/sbv-prod-check/prod.db NODE_ENV=production JWT_SECRET=$(openssl rand -hex 32) \
  API_PORT=5098 node server/server.js &
sleep 3
curl -s -X POST localhost:5098/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@sbvolunteers.gov","password":"password123"}'
kill %1
```

Expected: `{"error":"Invalid email or password"}` — **not** a token. Before Task 3 this returned a working admin session.

- [ ] **Step 4: Walk the student journey manually**

```bash
npm run dev
```

As a brand-new account (sign up with a username), confirm each step:
- [ ] Signup succeeds and the username is accepted and unique-checked
- [ ] The app loads — no "Verify your email" wall
- [ ] Browse events, apply to a shift
- [ ] Withdraw, and see it labelled **"Withdrawn"** (not "Not selected")
- [ ] Re-apply to the same shift successfully
- [ ] Sign out, use "Forgot password", read the link from the server console, set a new password, sign in with it

- [ ] **Step 5: Walk the organizer journey manually**

As `jkatzenback@vikings.org`:
- [ ] Create an event with two shifts
- [ ] Review applicants and accept one
- [ ] Open the day-of check-in screen, mark someone present, reload, confirm it persisted
- [ ] Finalise attendance on a shift that has ended and confirm hours are credited
- [ ] Confirm the certificate appears for that student and verifies at `/verify/<code>`

- [ ] **Step 6: Confirm the P1 items are still open and unchanged**

These were deliberately **not** fixed here and belong to the next plan. Spot-check that they still behave as the audit recorded, so the follow-up plan is written against reality:

```bash
# still unauthenticated, still exposes instructions
curl -s localhost:5173/api/events | head -c 200
```

- [ ] **Step 7: Tag the milestone**

```bash
git tag -a p0-complete -m "All P0 launch blockers closed; app is usable end to end"
```

---

## Self-Review Notes

**Spec coverage.** Every P0 from the audit maps to a task: P0-1 → Task 1; P0-2 → Task 4; P0-3 → Tasks 5 and 6; P0-4 → Task 7; P0-5 → Task 3; P0-6 → Task 9; P0-7 → Task 8. Task 2 is enabling infrastructure with no audit finding of its own; Task 10 is verification. Two smaller defects found during the audit are folded in where they belong rather than given their own tasks: the broken `bin/make-admin.mjs` (Task 3, because disabling seeding makes it the only admin path) and the `app-${Date.now()}` id collision (Task 7, because that line is being rewritten anyway).

**Deliberately out of scope.** The `/health` shadowing and error-handler ordering are visible in Task 2's `app.js` and are left as-is on purpose — they are P1, they need their own tests, and changing them while moving the file would conflate a refactor with a fix. Password minimum length stays at 6 for consistency with the existing client; raising it is P1 work that touches both sides.

**Type consistency.** `formatUserResponse` gains `emailVerified` (Task 4) and `username` (Task 8) — both are additive and no task renames an existing field. `call(method, path, body, token)` from `testServer.js` keeps one signature across all five test files. `issueVerificationToken(userId)` is defined in Task 6 and used only there. `fetchEventDetails(eventId)` is defined in Task 9 Step 4 and consumed in the same task, returning `{event, applications}` — matching what `CheckInView.jsx:35-36` already destructures.

---

## Task 11: Repair event navigation and the password-reset landing

Found by Task 10's browser verification — both defects predate this plan and were invisible to the original audit, which tested the API directly because the client would not compile.

**Files:**
- Modify: `src/App.jsx:250-254` (`openEventById`) and `src/App.jsx:131-135` (reset redirect)
- Test: manual browser verification (these are client-side wiring defects; the repo has no client component-test harness and this plan does not add one)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `openEventById(eventOrId)` accepts either an event object or an id string.

### Defect A — no event can be opened from the main screens

Every call site passes the whole event object:

```
src/components/EventCard.jsx:118          onViewDetails(event)
src/views/BrowseEvents.jsx:132            onViewDetails(event)
src/views/VolunteerDashboard.jsx:102,153,261   onViewDetails(event) / onViewDetails(nextShift.event)
src/views/OrganizerDashboard.jsx:224,233,359,377  onViewDetails(event) / onViewDetails(needsReview[0].event)
```

but `openEventById` does `events.find(e => e.id === eventId)` against that object, never matches, and shows "That event is no longer available." The Opportunities page and both dashboards are the primary way into an event, so this is the most-used interaction in the product.

- [ ] **Step 1: Reproduce it**

`npm run dev`, sign in as `leo.chen28@gmail.com` / `password123`, go to Opportunities, click any event card. Expect the toast "That event is no longer available." and no modal.

- [ ] **Step 2: Make the handler accept either shape**

Nine call sites pass an object and the profile/notification/calendar paths pass an id. Normalising in the one handler is a smaller, safer change than editing nine call sites, and it matches how `viewVolunteer` in this same file already handles both (`typeof person === 'string' ? person : person?.id`).

Replace `src/App.jsx:250-254`:

```jsx
  const openEventById = (eventId) => {
    const match = events.find(e => e.id === eventId);
    if (match) setSelectedEventState(eventId);
    else addToast('That event is no longer available.', 'info');
  };
```

with:

```jsx
  // Callers pass either an event object (cards, dashboards) or an id string
  // (notifications, calendar, profiles). Normalise here rather than at nine
  // call sites — `viewVolunteer` below already takes the same approach.
  const openEventById = (eventOrId) => {
    const id = typeof eventOrId === 'string' ? eventOrId : eventOrId?.id;
    const match = id && events.find(e => e.id === id);
    if (match) setSelectedEventState(id);
    else addToast('That event is no longer available.', 'info');
  };
```

- [ ] **Step 3: Verify Defect A is fixed**

Reload, click an event card on Opportunities — the event modal must open. Repeat from the volunteer dashboard ("View"), the organizer dashboard, and the next-shift banner. Then confirm the id-passing paths still work: open an event from a notification and from the calendar.

### Defect B — the password-reset link lands on an infinite spinner

`src/App.jsx:131-135` navigates to `/reset-password` and `return`s out of `validateSession()` before `setIsCheckingSession(false)` runs. The effect's dependency array is `[refreshKey]`, which did not change, so the effect never re-fires and `isCheckingSession` stays `true` forever — the app renders its loading state permanently. The endpoint and the `ResetPassword` page are both fine; only this glue is broken.

- [ ] **Step 4: Reproduce it**

With the dev server running, request a reset for `leo.chen28@gmail.com`, copy the `/?reset=<token>` URL printed to the server console, and open it. Expect a spinner that never resolves.

- [ ] **Step 5: Clear the checking flag before redirecting**

Replace `src/App.jsx:131-135`:

```jsx
        if (searchParams.has('reset') && currentPath !== '/reset-password') {
          const token = searchParams.get('reset');
          navigate(`/reset-password?token=${token}`, { replace: true });
          return;
        }
```

with:

```jsx
        if (searchParams.has('reset') && currentPath !== '/reset-password') {
          const token = searchParams.get('reset');
          // Clear the checking flag before returning: this effect only re-runs
          // when refreshKey changes, so leaving it set strands the app on its
          // loading state for ever.
          setIsCheckingSession(false);
          navigate(`/reset-password?token=${token}`, { replace: true });
          return;
        }
```

- [ ] **Step 6: Verify Defect B is fixed**

Open the `/?reset=<token>` link again. The "Choose a new password" form must render. Set a new password and sign in with it.

- [ ] **Step 7: Full suite and build**

```bash
npm test
npm run build
```

Expected: 119 passing, build succeeds. Neither defect has server-side coverage, so the counts are unchanged — the verification for this task is the browser walkthrough in Steps 3 and 6.

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "fix: open events from cards and land the password-reset link

openEventById compared an event object against event ids, so every View/Apply
button on Opportunities and both dashboards showed 'That event is no longer
available' — the primary way into an event was dead.

The reset-link redirect returned before clearing isCheckingSession, and the
effect only re-runs on refreshKey, so /?reset=<token> stranded the app on its
loading spinner for ever.

Both predate this branch; both were invisible until the build was repaired."
```
