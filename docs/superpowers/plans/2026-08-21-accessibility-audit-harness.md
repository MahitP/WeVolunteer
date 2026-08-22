# Accessibility Audit and Measurement Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-browser accessibility measurement harness for WeVolunteer, use it to produce an evidence-backed WCAG 2.2 AA defect inventory, and fix the P0 blockers it confirms.

**Architecture:** Playwright drives Chromium against the *development* topology (Vite dev server proxying to the API server) with a disposable SQLite database. A route inventory derived from `src/routes/index.jsx` is crossed with roles from the demo-accounts endpoint. Nine check families run per route x role; known violations live in a ratcheted `A11Y_BASELINE.json` that CI compares against. Findings become `docs/audits/2026-08-21-accessibility-audit.md`, each row carrying an evidence class.

**Tech Stack:** Node 24, React 19, Vite 8, Express 4, `node:sqlite`, Vitest 4, oxlint, Playwright + `@axe-core/playwright` (new).

**Spec:** `docs/superpowers/specs/2026-08-21-accessibility-audit-design.md`

---

## Global Constraints

These apply to every task. Do not restate them; do not violate them.

- **Never touch `pilot.db`.** It holds real minors' personal data. Every database interaction in this plan goes through an absolute `WEV_DB_PATH` under `scratch/`.
- **`WEV_DB_PATH` unset is a refusal, never a fallback.** The default is `server/wevolunteer.db`; defaulting is how a harness audits the wrong database.
- **Reuse `bin/lib/db-safety.mjs`.** It already exports `resolveDbPath`, `refuseProduction`, `refuseNonSqliteEngine`, `refuseProductionLikePath`, `refuseNonDisposableDatabase`. A second implementation of any of these is a defect.
- **Verified fact you may rely on:** on Node v24.14.0, an explicitly-exported environment variable takes precedence over `--env-file-if-exists`. Confirmed empirically. So exporting `WEV_DB_PATH` is safe even when `.env` sets it to `../pilot.db`.
- **Environment variable names are exact.** The API server reads **`API_PORT`** (default 5050), never `PORT`. Vite reads **`PORT`** (default 5173). Health check is `GET /health` on the API server. Demo accounts require **`DEMO_MODE=true`**. `VITE_LOCAL_AI` **defaults to `'true'`** and must be set to `'false'` for CI.
- **Playwright floor: `@playwright/test` >= 1.49**, for `toMatchAriaSnapshot`.
- **Do not run `npm run dev`** to start the harness; it uses `nodemon` and `concurrently`. Playwright's `webServer` starts plain `node` and `vite` processes.
- **Never claim a criterion passes because axe did not flag it.** Every finding carries an evidence class: `measured`, `inspected`, `human-verified`, or `unverified`.
- **No ADA compliance claims** in any deliverable.
- **Commit style:** imperative subject, no assistant attribution, no `Co-Authored-By`. Explain the failure the change prevents, in the style of the surrounding codebase.
- **Test style:** this repo writes guard tests with a docstring explaining the specific failure the test exists to prevent, and it distrusts vacuous assertions. Match that. A test that would pass against `null` needs a guard-the-guard assertion first.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `a11y/harness/guard.mjs` | The safety gate. Composes `db-safety.mjs` refusals plus the scratch-only constraint. Nothing else in `a11y/` may open a database without it. |
| `a11y/harness/routes.mjs` | Derives the route inventory from `src/routes/index.jsx`. Resolves the 12 parameterised paths against fixtures. |
| `a11y/harness/roles.mjs` | Fetches roles from `GET /api/auth/demo-accounts`; maps role to the routes it may reach. |
| `a11y/harness/signIn.mjs` | Signs in one role, saves a Playwright `storageState`. |
| `a11y/harness/axe.mjs` | axe-core injection with the WCAG 2.2 tag set; normalises results into baseline shape. |
| `a11y/harness/measure.mjs` | Layout primitives: focus walk, target-size measurement, reflow check. |
| `a11y/harness/baseline.mjs` | Reads/compares/writes `A11Y_BASELINE.json`. Owns the ratchet rule. |
| `a11y/sweep.axe.spec.js` | axe across every route x role. |
| `a11y/sweep.aria.spec.js` | Accessible structure and heading tree across every route. |
| `a11y/sweep.focus.spec.js` | Focus walk + focus-not-obscured. |
| `a11y/sweep.geometry.spec.js` | Target size, reflow, text spacing. |
| `a11y/sweep.media.spec.js` | forced-colors and reduced-motion emulation. |
| `a11y/workflows/*.spec.js` | 12 deep keyboard journeys. |
| `a11y/A11Y_BASELINE.json` | Ratcheted known violations, each keyed to an audit finding ID. |
| `bin/a11y-audit.mjs` | Destructive entry point: gate, reset the scratch DB, hand off to Playwright. Registered in `DESTRUCTIVE_TOOLS`. |
| `bin/a11y-report.mjs` | Turns the baseline into the audit document's measured rows. |
| `playwright.config.js` | Projects, `webServer` pair, `globalSetup`, emulation profiles. |
| `docs/audits/2026-08-21-accessibility-audit.md` | The deliverable inventory. |
| `docs/audits/2026-08-21-voiceover-test-script.md` | The manual script the owner runs. |
| `docs/ENGINEERING_GUIDE.md` | Gains an accessibility section. |

---

## Task 1: The safety gate

Nothing may touch a database before this exists.

**Files:**
- Create: `a11y/harness/guard.mjs`
- Create: `bin/a11y-audit.mjs`
- Modify: `server/tooling.scriptSafety.test.js:32-36` (add to `DESTRUCTIVE_TOOLS`)
- Modify: `vitest.config.js` (bring `a11y/` into the server project)
- Test: `server/tooling.scriptSafety.test.js`, `a11y/harness/guard.test.js`

**Interfaces:**
- Consumes: `resolveDbPath`, `refuseProduction`, `refuseNonSqliteEngine`, `refuseProductionLikePath`, `refuseNonDisposableDatabase` from `bin/lib/db-safety.mjs`.
- Produces: `assertScratchDatabase({ tool }) -> string` (returns the resolved absolute path, or exits non-zero). Called by `bin/a11y-audit.mjs` in this task and by Task 2's `globalSetup`.

- [ ] **Step 1: Add `bin/a11y-audit.mjs` to the parameterised refusal suite, so it fails**

Modify `server/tooling.scriptSafety.test.js`:

```js
/** Tools that delete or mutate a database and therefore need the full gate. */
const DESTRUCTIVE_TOOLS = [
  'bin/seed-pilot.js',
  'bin/simulate-pilot.js',
  'bin/reset-dev-db.mjs',
  /* The accessibility harness resets a scratch database before every run, which
     makes it destructive in exactly the way this suite exists for. Listed here
     rather than given its own guard so a refusal added to the shared gate
     reaches it automatically — the drift this file's header describes. */
  'bin/a11y-audit.mjs'
];
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run --project server server/tooling.scriptSafety.test.js`

Expected: every `bin/a11y-audit.mjs` case fails because the file does not exist, **not** because a refusal was missing. If any case *passes*, stop — a non-existent script exiting non-zero would satisfy the assertions vacuously, and the suite needs an existence assertion before it is trustworthy.

- [ ] **Step 3: Add the existence assertion that makes the suite non-vacuous**

Append to `server/tooling.scriptSafety.test.js`:

```js
/**
 * Guards the guard.
 *
 * Every assertion above is "exit non-zero and print REFUS". A tool whose file
 * does not exist exits non-zero, and node's own error contains no "REFUS" — so
 * a missing file fails loudly today. But a tool that exits non-zero for ANY
 * duller reason (a syntax error, a bad import) would satisfy the exit-code half
 * while the refusal it is supposed to prove never ran. This asserts the files
 * are real, so the suite is measuring gates rather than crashes.
 */
describe('the destructive-tool list points at real tools', () => {
  for (const tool of DESTRUCTIVE_TOOLS) {
    it(`${tool} exists`, () => {
      expect(existsSync(path.join(ROOT, tool)), `${tool} is listed but absent`).toBe(true);
    });
  }
});
```

- [ ] **Step 4: Write the scratch-only guard's own test**

Create `a11y/harness/guard.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * The accessibility harness must refuse to run against anything but a scratch
 * database.
 *
 * The shared gate in bin/lib/db-safety.mjs already refuses production, a
 * PostgreSQL target, a production-looking path, and a database holding real
 * accounts. It does not refuse an UNSET WEV_DB_PATH, because it is written for
 * an operator at a terminal who can read the announced path before confirming.
 * This harness runs unattended, and the default resolution is
 * server/wevolunteer.db — a real developer database with real local accounts in
 * it. Auditing that silently is the failure this adds.
 *
 * The other addition is the scratch/ containment rule. A path under the OS temp
 * root satisfies every existing check, which is correct for the hand-run tools
 * and too loose here: the harness writes artefacts next to its database, and
 * they belong somewhere git already ignores.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const TOOL = 'bin/a11y-audit.mjs';

function run(env) {
  const res = spawnSync(process.execPath, [TOOL, '--yes'], {
    cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development', ...env }
  });
  return { code: res.status ?? 1, combined: String(res.stdout || '') + String(res.stderr || '') };
}

describe('the accessibility harness refuses a database it must not audit', () => {
  it('refuses an unset WEV_DB_PATH rather than defaulting', () => {
    const res = run({ WEV_DB_PATH: undefined });
    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    expect(res.combined).toMatch(/WEV_DB_PATH/);
  });

  it('refuses a relative WEV_DB_PATH, which resolves differently per directory', () => {
    const res = run({ WEV_DB_PATH: './scratch/a11y.db' });
    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    expect(res.combined).toMatch(/absolute/i);
  });

  it('refuses an absolute path outside scratch/, even under the temp root', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-a11y-outside-'));
    const dbFile = path.join(dir, 'scratch.db');
    writeFileSync(dbFile, 'sentinel');
    const res = run({ WEV_DB_PATH: dbFile });
    rmSync(dir, { recursive: true, force: true });
    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
  });

  it('accepts an absolute path under scratch/', () => {
    /* --dry-run stops before starting browsers, so this asserts the GATE
       accepts, not that a whole audit runs. */
    const res = spawnSync(process.execPath, [TOOL, '--yes', '--dry-run'], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
      env: {
        ...process.env, NODE_ENV: 'development',
        WEV_DB_PATH: path.join(ROOT, 'scratch', 'a11y.db'),
        DATABASE_ENGINE: 'sqlite'
      }
    });
    const combined = String(res.stdout || '') + String(res.stderr || '');
    expect(res.status, combined).toBe(0);
    expect(combined).not.toMatch(/REFUS/i);
  });
});
```

- [ ] **Step 5: Run it and confirm it is not even collected**

Run: `npx vitest run --project client a11y/harness/guard.test.js`

Expected: FAIL — `a11y/` is outside the client project's `include` glob (`src/**/*.test.{js,jsx}`), so the file is not collected at all. Note the exact message; the next step fixes it.

- [ ] **Step 6: Bring `a11y/` into the vitest server project**

Modify `vitest.config.js`. The `server` project runs in the `node` environment, which is what these guard tests need — they spawn processes and touch the filesystem.

```js
          name: 'server',
          include: ['server/**/*.test.js', 'a11y/**/*.test.js'],
          environment: 'node',
```

Keep everything else in that project block unchanged.

- [ ] **Step 7: Run again and confirm the failure is now about the missing tool**

Run: `npx vitest run --project server a11y/harness/guard.test.js`

Expected: FAIL with a non-zero exit from a missing `bin/a11y-audit.mjs` — the tests are collected and the assertions are real.

- [ ] **Step 8: Write the guard module**

Create `a11y/harness/guard.mjs`:

```js
import path from 'node:path';
import fs from 'node:fs';
import {
  resolveDbPath,
  refuseProduction,
  refuseNonSqliteEngine,
  refuseProductionLikePath,
  refuseNonDisposableDatabase
} from '../../bin/lib/db-safety.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRATCH = path.join(ROOT, 'scratch');

/** A sentinel no real path resolves to, so an unset variable cannot default. */
const UNSET = ' unset';

/**
 * Refuses any database this harness must not drive a browser through, and
 * returns the one it may.
 *
 * The four shared refusals below are the same ones bin/reset-dev-db.mjs
 * composes, in the same order and for the same reasons — production first,
 * because it is the check that must not be reachable past; then the engine,
 * because with DATABASE_ENGINE=postgres a file path is irrelevant and every
 * check after it would be inspecting the wrong thing; then the path; then the
 * contents.
 *
 * Two refusals are added on top, and both exist because this runs unattended
 * rather than under a person who can read an announced path and stop.
 */
export function assertScratchDatabase({ tool }) {
  const effect = 'delete that database, reseed it, and drive a browser through it';

  refuseProduction({ tool, effect });
  refuseNonSqliteEngine({ tool, effect });

  /* Deliberately NOT resolveDbPath's default. The default is
     server/wevolunteer.db, a real developer database; silently auditing it is
     the failure this refusal exists for. */
  const raw = process.env.WEV_DB_PATH;
  if (raw === undefined || raw === '') {
    refuse(tool, 'WEV_DB_PATH is not set.',
      'This harness has no default database on purpose: the default would be\n'
      + '  server/wevolunteer.db, which holds real local accounts.\n'
      + `  Point WEV_DB_PATH at an absolute path under ${SCRATCH}.`);
  }

  if (!path.isAbsolute(raw)) {
    refuse(tool, `WEV_DB_PATH="${raw}" is not absolute.`,
      'A relative path means a different file from every working directory, and\n'
      + '  the harness starts processes in two of them (the root, and server/).');
  }

  const dbPath = resolveDbPath(UNSET);
  /* realpath the CONTAINING directory, not the file: the database may not exist
     yet on a first run, but a symlinked parent must not smuggle the target out
     of scratch/. */
  const parent = fs.realpathSync(ensureDir(path.dirname(dbPath)));
  const scratchReal = fs.realpathSync(ensureDir(SCRATCH));
  if (parent !== scratchReal && !parent.startsWith(scratchReal + path.sep)) {
    refuse(tool, `WEV_DB_PATH resolves to ${dbPath}, outside scratch/.`,
      `Artefacts are written beside the database, so it belongs under\n  ${SCRATCH}, which git already ignores.`);
  }

  refuseProductionLikePath({ tool, dbPath });
  refuseNonDisposableDatabase({ tool, dbPath, effect });

  return dbPath;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same shape as db-safety.mjs's refusals, so the output reads consistently. */
function refuse(tool, headline, detail) {
  console.error(`REFUSING: ${headline}`);
  console.error('');
  console.error(`  ${tool} will not run.`);
  console.error(`  ${detail}`);
  process.exit(1);
}
```

- [ ] **Step 9: Write the entry point**

Create `bin/a11y-audit.mjs`:

```js
#!/usr/bin/env node
/**
 * Entry point for the accessibility audit.
 *
 * ── Why this is a script and not just `npx playwright test` ──
 *
 * It resets a database, which makes it destructive, which means it belongs in
 * the same parameterised refusal suite as every other destructive tool here
 * (server/tooling.scriptSafety.test.js). A gate that lives only in Playwright's
 * globalSetup is a gate no existing suite covers.
 *
 * The gate ALSO runs in playwright.config.js's globalSetup, so `npx playwright
 * test` on its own cannot bypass it. Two call sites, one implementation.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertScratchDatabase } from '../a11y/harness/guard.mjs';

const TOOL = 'The accessibility audit';
const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const dbPath = assertScratchDatabase({ tool: TOOL });

console.log('WeVolunteer — accessibility audit');
console.log('');
console.log(`  Database: ${dbPath}`);
console.log(`  NODE_ENV: ${process.env.NODE_ENV || '(unset)'}`);
console.log('');

if (dryRun) {
  console.log('  --dry-run: the gate passed. Stopping before the database reset.');
  process.exit(0);
}

/* Reset through the existing tool rather than deleting the file here. It owns
   the "delete the file and let initDatabase rebuild the schema" decision, and
   its own header explains why enumerating tables drifts. */
const reset = spawnSync(process.execPath, ['bin/reset-dev-db.mjs', '--yes'], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, WEV_DB_PATH: dbPath, DATABASE_ENGINE: 'sqlite' }
});
if (reset.status !== 0) process.exit(reset.status ?? 1);

const pw = spawnSync('npx', ['playwright', 'test', ...args.filter(a => a !== '--yes')], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, WEV_DB_PATH: dbPath, DATABASE_ENGINE: 'sqlite' }
});
process.exit(pw.status ?? 1);
```

- [ ] **Step 10: Run both suites and confirm they pass**

Run: `npx vitest run --project server a11y/harness/guard.test.js server/tooling.scriptSafety.test.js`

Expected: PASS. If `refuses an absolute path outside scratch/` fails because `refuseProductionLikePath` fired first with a different message, keep the `/REFUS/i` assertion and add a comment naming which refusal won — do not weaken the containment check itself.

- [ ] **Step 11: Confirm the gate actually refuses in the real shell**

Run: `node bin/a11y-audit.mjs --yes --dry-run`

Expected: `REFUSING: WEV_DB_PATH is not set.` and exit 1.

Run: `WEV_DB_PATH="$PWD/scratch/a11y.db" DATABASE_ENGINE=sqlite node bin/a11y-audit.mjs --yes --dry-run`

Expected: the gate passes, prints the resolved path, exits 0.

- [ ] **Step 12: Commit**

```bash
git add a11y/harness/guard.mjs a11y/harness/guard.test.js bin/a11y-audit.mjs server/tooling.scriptSafety.test.js vitest.config.js
git commit -m "Gate the accessibility harness behind the shared database refusals"
```

Use this commit body:

```
An unattended harness has no operator to read an announced path and stop, so
two refusals the hand-run tools do not need are added: an unset WEV_DB_PATH is
refused rather than defaulted, because the default is server/wevolunteer.db and
auditing a real developer database silently is the whole failure; and the target
must sit under scratch/, because artefacts are written beside it.

The other four refusals are the shared ones, composed in reset-dev-db.mjs's
order. bin/a11y-audit.mjs joins DESTRUCTIVE_TOOLS so a refusal added to the
shared gate reaches it without anybody remembering. That suite asserted only
"exit non-zero and print REFUS", which a missing file satisfies, so it now
asserts its tools exist.
```

---

## Task 2: Playwright, the dev topology, and a smoke test that proves sign-in works

**Files:**
- Create: `playwright.config.js`, `a11y/harness/globalSetup.mjs`, `a11y/smoke.spec.js`
- Modify: `package.json` (devDeps + scripts), `.gitignore`

**Interfaces:**
- Consumes: `assertScratchDatabase` (Task 1).
- Produces: a `baseURL` every later spec inherits from `playwright.config.js`. Ports are fixed at **5199** (API) and **5198** (Vite) so a developer's own `npm run dev` on 5050/5173 is never disturbed.

- [ ] **Step 1: Install**

Run: `npm install -D @playwright/test @axe-core/playwright && npx playwright install --with-deps chromium`

Then confirm the floor from Global Constraints is met:

Run: `node -e "console.log(require('./package.json').devDependencies['@playwright/test'])"`

Expected: a `^1.x` where x >= 49. If it is lower, stop — the accessible-structure work in Task 11 assumes a modern Playwright.

- [ ] **Step 2: Ignore the generated output**

Append to `.gitignore`:

```
# Accessibility harness output. The baseline is committed; runs are not.
/test-results/
/playwright-report/
/a11y/.auth/
```

- [ ] **Step 3: Write the global setup that re-runs the gate**

Create `a11y/harness/globalSetup.mjs`:

```js
import { assertScratchDatabase } from './guard.mjs';

/**
 * The gate again, for the `npx playwright test` path.
 *
 * bin/a11y-audit.mjs is the supported entry point and gates first, but nothing
 * stops somebody running Playwright directly — an IDE button does exactly that.
 * The webServer block starts the API server with whatever WEV_DB_PATH is in the
 * environment, so without this the direct path is the unguarded one.
 */
export default function globalSetup() {
  assertScratchDatabase({ tool: 'The accessibility audit' });
}
```

- [ ] **Step 4: Write the Playwright config**

Create `playwright.config.js`:

```js
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * ── Why this runs the DEVELOPMENT topology ──
 *
 * Serving a production build looks like the more faithful choice and is wrong
 * twice. vite.config.js configures a proxy under `server` and has no `preview`
 * block at all, so `vite preview` serves the SPA with /api unproxied and every
 * request lands on the SPA fallback. And server/app.js serves ../dist only
 * inside `if (IS_PRODUCTION)` — so serving the built client means turning
 * production mode on, which also turns on secure cookies. Playwright drives
 * http://127.0.0.1, secure cookies are not sent over http, and sign-in would
 * fail for every role as what looks like an authentication bug. server/db.js
 * additionally FATALs on a relative WEV_DB_PATH in production.
 *
 * The trade is that a dev bundle is not the shipped bundle. Chunking,
 * minification and asset hashing differ, and none of them affect the DOM, the
 * accessible tree, the cascade, or layout — which is the entire subject here.
 *
 * ── Ports ──
 *
 * 5199/5198 rather than the defaults 5050/5173, so a developer's own dev server
 * keeps running while the harness does. vite.config.js:79 honours PORT for
 * exactly this ("lets the dev harness assign a free port"); the API server reads
 * API_PORT and never PORT, which is the trap the engineering guide documents.
 */
const API_PORT = 5199;
const WEB_PORT = 5198;
const ROOT = import.meta.dirname;

/* Passed to both servers. WEV_DB_PATH is already in the environment by the time
   this is read — globalSetup and bin/a11y-audit.mjs both assert it — and an
   explicit env var beats --env-file-if-exists on Node 24, so .env's
   WEV_DB_PATH=../pilot.db cannot win. */
const shared = {
  NODE_ENV: 'development',
  DATABASE_ENGINE: 'sqlite',
  WEV_DB_PATH: process.env.WEV_DB_PATH,
  JWT_SECRET: process.env.JWT_SECRET || 'a11y-harness-development-secret-not-for-any-real-deployment'
};

export default defineConfig({
  testDir: './a11y',
  globalSetup: './a11y/harness/globalSetup.mjs',
  /* Serial by default. The suites share one database, and two specs signing in
     or mutating state concurrently produce failures that look like a11y defects. */
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['json', { outputFile: 'test-results/a11y.json' }]]
                           : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: [
    {
      command: 'node server.js',
      cwd: path.join(ROOT, 'server'),
      url: `http://127.0.0.1:${API_PORT}/health`,
      timeout: 60000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...shared, API_PORT: String(API_PORT), BIND_ADDRESS: '127.0.0.1', DEMO_MODE: 'true' }
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: ROOT,
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 120000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...shared,
        PORT: String(WEB_PORT),
        VITE_API_TARGET: `http://127.0.0.1:${API_PORT}`,
        /* Defaults to 'true'. Welly would download a model into every page load. */
        VITE_LOCAL_AI: 'false'
      }
    }
  ]
});
```

- [ ] **Step 5: Add npm scripts**

Modify `package.json` scripts, adding these three:

```json
    "a11y": "node bin/a11y-audit.mjs --yes",
    "a11y:local": "VITE_LOCAL_AI=true node bin/a11y-audit.mjs --yes --grep @local",
    "a11y:report": "node bin/a11y-report.mjs"
```

- [ ] **Step 6: Write the smoke test**

Create `a11y/smoke.spec.js`:

```js
import { test, expect } from '@playwright/test';

/**
 * Proves the harness itself works before any accessibility assertion depends on
 * it.
 *
 * Everything downstream signs in and navigates. If sign-in silently fails, every
 * later spec audits the login page while reporting the route it meant to visit —
 * a whole run of confident, wrong results. That is the specific failure this
 * exists to make loud, so it asserts the demo shortcut is really there and that
 * a signed-in shell really rendered.
 */
test('the demo sign-in shortcut reaches a signed-in shell', async ({ page }) => {
  await page.goto('/login');

  const demo = page.locator('.auth-demo-btn').first();
  await expect(demo, 'no demo sign-in shortcut — is DEMO_MODE=true and the database seeded?')
    .toBeVisible({ timeout: 15000 });
  await demo.click();

  /* The shell's landmark, and its single h1 — which headingLevels.test.js proves
     every route has exactly one of. Their presence is what "signed in" means
     structurally. */
  await expect(page.locator('#main-content')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
});

test('the skip link is the first thing a keyboard reaches in the shell', async ({ page }) => {
  await page.goto('/login');
  await page.locator('.auth-demo-btn').first().click();
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15000 });

  /* Focus starts at the document, so one Tab must land on the skip link — it is
     the first focusable node in App.jsx's shell (App.jsx:1627). */
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /skip to main content/i })).toBeFocused();
});
```

- [ ] **Step 7: Run it**

Run: `npm run a11y -- a11y/smoke.spec.js`

Expected: both tests PASS. If the demo button is not found, read the API server's piped stdout for a seed failure and confirm `DEMO_MODE=true` reached it. If `.auth-demo-btn` does not exist, check the real class name in `src/views/Login.jsx:1097`.

- [ ] **Step 8: Commit**

```bash
git add playwright.config.js a11y/harness/globalSetup.mjs a11y/smoke.spec.js package.json package-lock.json .gitignore
git commit -m "Drive a real browser at WeVolunteer, in the topology that can sign in"
```

Use this commit body:

```
Every accessibility guard on this platform reads source text, because jsdom has
no layout engine and the guards say so. This is the missing half: a real
Chromium, real layout, real focus.

It runs the DEVELOPMENT topology deliberately. vite.config.js has no preview
block, so vite preview would serve the SPA with /api unproxied; and app.js
serves dist only under IS_PRODUCTION, which also arms secure cookies that
http://127.0.0.1 cannot satisfy, so sign-in would fail for every role and look
like an auth bug. Ports are 5199/5198 so a developer's own dev server survives.

The smoke test asserts sign-in reaches a shell before anything else depends on
it. A silent sign-in failure would make every later spec audit the login page
while reporting the route it meant to visit.
```

---

## Task 3: Route inventory and per-role sign-in

**Files:**
- Create: `a11y/harness/routes.mjs`, `a11y/harness/routes.test.js`, `a11y/harness/roles.mjs`, `a11y/harness/signIn.mjs`, `a11y/roles.spec.js`
- Reference: `src/pageTitleCoverage.test.js:28-33` (the existing parse of the route table)

**Interfaces:**
- Produces:
  - `ROUTES: Array<{ path: string, concrete: string, parameterised: boolean }>` — `concrete` is the probeable URL.
  - `FIXTURES: Record<string, string>` — parameter name to seeded value.
  - `fetchRoles(request, baseURL) -> Promise<Array<{ key, email, role }>>`
  - `signInAs(browser, role, baseURL) -> Promise<string>` — returns a `storageState` file path.

- [ ] **Step 1: Write the inventory test first**

Create `a11y/harness/routes.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES, FIXTURES } from './routes.mjs';

/**
 * The inventory is derived, and this proves it stayed derived.
 *
 * src/pageTitleCoverage.test.js exists because tabForPath silently titled
 * unknown paths as the dashboard, three separate times, and a hand-written list
 * is what let each one hide. The same trap applies harder here: a route missing
 * from a sweep is not a wrong heading, it is a page nobody ever audited, and
 * nothing about a green run would say so.
 *
 * So the count is asserted against the route table itself rather than against a
 * number typed here, and every parameterised path must have a fixture. A skip
 * would be the quiet failure: /appeal/:token and /verify/:code are exactly the
 * awkward ones somebody would skip, and they are also where somebody contests a
 * decision taken about them.
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/routes/index.jsx'), 'utf8'
);
const DECLARED = [...SRC.matchAll(/\{\s*path:\s*'([^']+)'/g)].map(m => m[1]);

describe('the accessibility route inventory', () => {
  it('found the route table at all', () => {
    /* Guards the guard: a moved or renamed file would make every assertion
       below pass against an empty list. There are 47 entries today. */
    expect(DECLARED.length).toBeGreaterThan(40);
  });

  it('covers every declared route', () => {
    const covered = new Set(ROUTES.map(r => r.path));
    const missing = DECLARED.filter(p => !p.includes('*') && !covered.has(p));
    expect(missing, `routes declared but not swept: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives every parameterised route a concrete probeable path', () => {
    const unresolved = ROUTES
      .filter(r => r.parameterised)
      .filter(r => r.concrete.includes(':'));
    expect(unresolved.map(r => r.path),
      'a parameterised route with no fixture must FAIL, not skip').toEqual([]);
  });

  it('has a fixture for every distinct parameter name', () => {
    const names = new Set();
    for (const p of DECLARED) {
      for (const m of p.matchAll(/:([A-Za-z]+)/g)) names.add(m[1]);
    }
    const missing = [...names].filter(n => !(n in FIXTURES));
    expect(missing, `parameters with no fixture: ${missing.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project server a11y/harness/routes.test.js`

Expected: FAIL — `Cannot find module './routes.mjs'`.

- [ ] **Step 3: Write the inventory**

Create `a11y/harness/routes.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Parameter values that exist in the seeded database.
 *
 * Typed here rather than queried because a query needs a live connection and
 * this module is imported by a vitest guard that must not open one. They are
 * asserted against the running app by the sweep: a fixture that 404s fails the
 * route, which is the signal that a seed changed.
 *
 * The 12 parameterised routes these serve are /events/:id/edit,
 * /checkin/:eventId, /users/id/:id, /users/:handle, /users/:handle/badges,
 * /users/:handle/certificates, /users/:handle/hours, /organizations/:key,
 * /organizations/:key/edit, /verify/:code, /legal/:slug and /appeal/:token.
 */
export const FIXTURES = {
  id: '1',
  eventId: '1',
  handle: 'alex',
  key: 'riverside-community-center',
  code: 'DEMOCERT1',
  slug: 'terms',
  token: 'demo-appeal-token'
};

const SRC = fs.readFileSync(path.join(ROOT, 'src/routes/index.jsx'), 'utf8');

/**
 * Every route the table declares, with a URL that can actually be visited.
 *
 * Parsed from the route table for the same reason pageTitleCoverage.test.js
 * parses it: a route added tomorrow is swept the day it is added, not the day
 * somebody remembers this file. Splat routes are excluded — a catch-all is not
 * a page.
 */
export const ROUTES = [...SRC.matchAll(/\{\s*path:\s*'([^']+)'/g)]
  .map(m => m[1])
  .filter(p => !p.includes('*'))
  .map(routePath => {
    const parameterised = routePath.includes(':');
    const concrete = routePath.replace(
      /:([A-Za-z]+)/g,
      (whole, name) => (name in FIXTURES ? FIXTURES[name] : whole)
    );
    return { path: routePath, concrete, parameterised };
  });
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run --project server a11y/harness/routes.test.js`

Expected: PASS. If `has a fixture for every distinct parameter name` fails, add the missing name to `FIXTURES` with a value the seed creates — read `bin/reset-dev-db.mjs`'s seed to find one. Do **not** delete the assertion.

- [ ] **Step 5: Write the role list and per-role sign-in**

Create `a11y/harness/roles.mjs`:

```js
/**
 * Roles come from the server, never from a literal here.
 *
 * src/components/DemoBar.jsx records what happens when a client hardcodes the
 * seed instead: api.login answered "No account found with that email address"
 * and the failure surfaced as a toast, i.e. as a product bug. The endpoint also
 * filters tombstones and internal actors, so it is the only list that is right.
 */
export async function fetchRoles(request, baseURL) {
  const res = await request.get(`${baseURL}/api/auth/demo-accounts`);
  if (!res.ok()) {
    throw new Error(
      `GET /api/auth/demo-accounts returned ${res.status()}. `
      + 'Is DEMO_MODE=true on the API server and the scratch database seeded?'
    );
  }
  const list = await res.json();
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('the demo-accounts endpoint returned nothing — the seed did not run');
  }
  /* One account per distinct role. Auditing five students adds no coverage; the
     shell, the rail and the route set are what differ, and those follow role. */
  const byRole = new Map();
  for (const acc of list) if (!byRole.has(acc.role)) byRole.set(acc.role, acc);
  return [...byRole.values()].map(a => ({ key: a.role, email: a.email, role: a.role }));
}
```

Create `a11y/harness/signIn.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';

const AUTH_DIR = path.resolve(import.meta.dirname, '../.auth');

/**
 * Signs one role in and saves the cookie jar.
 *
 * Reused across every route rather than re-authenticating per page: with 35
 * concrete routes times several roles, a sign-in per visit is the difference
 * between a harness people run and one they stop running. That is the stated
 * risk in the spec, and this is the mitigation.
 *
 * The password is the seed's published one. It only ever reaches a scratch
 * database, which the gate in guard.mjs is what guarantees.
 */
export async function signInAs(browser, role, baseURL) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const statePath = path.join(AUTH_DIR, `${role.key}.json`);

  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(role.email);
  await page.getByLabel(/password/i).first().fill('password123');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  /* The signed-in shell's landmark. Waiting on a URL would pass while an error
     banner is the only thing on screen. */
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });

  await context.storageState({ path: statePath });
  await context.close();
  return statePath;
}
```

- [ ] **Step 6: Prove sign-in works for every role**

Create `a11y/roles.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { fetchRoles } from './harness/roles.mjs';
import { signInAs } from './harness/signIn.mjs';

test('every seeded role can sign in and reach a shell', async ({ browser, request, baseURL }) => {
  test.setTimeout(5 * 60 * 1000);
  const roles = await fetchRoles(request, baseURL);
  expect(roles.length, 'no distinct roles in the seed').toBeGreaterThan(1);

  for (const role of roles) {
    const statePath = await signInAs(browser, role, baseURL);
    const ctx = await browser.newContext({ baseURL, storageState: statePath });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('#main-content'), `${role.key} did not reach a shell`).toBeVisible();
    await ctx.close();
  }
});
```

- [ ] **Step 7: Run it**

Run: `npm run a11y -- a11y/roles.spec.js`

Expected: PASS, listing each role. If `getByLabel(/password/i)` matches more than one field, tighten the pattern against the real markup in `src/views/Login.jsx` — do not switch to a CSS selector, because the label association is itself part of what is being audited.

- [ ] **Step 8: Commit**

```bash
git add a11y/harness/routes.mjs a11y/harness/routes.test.js a11y/harness/roles.mjs a11y/harness/signIn.mjs a11y/roles.spec.js
git commit -m "Derive the audit's route and role inventory from the sources of truth"
```

Use this commit body:

```
The route list is parsed from src/routes/index.jsx, the way
pageTitleCoverage.test.js already parses it. That test exists because tabForPath
silently titled unknown paths as the dashboard three times, and a hand-written
list is what let each one hide; here the same mistake means a page nobody ever
audited, with nothing about a green run to say so. A parameterised route with no
fixture therefore FAILS rather than skipping — /appeal/:token and /verify/:code
are the awkward ones somebody would skip, and they are where somebody contests a
decision taken about them.

Roles come from GET /api/auth/demo-accounts, not a literal. DemoBar.jsx records
what hardcoding the seed did last time: login answered "No account found with
that email address".

storageState is saved per role and reused across routes, because a sign-in per
page visit is the difference between a harness people run and one they abandon.
```

---

## Task 4: axe across every route and role, with a ratcheted baseline

**Files:**
- Create: `a11y/harness/axe.mjs`, `a11y/harness/baseline.mjs`, `a11y/harness/baseline.test.js`, `a11y/sweep.axe.spec.js`, `a11y/A11Y_BASELINE.json`

**Interfaces:**
- Consumes: `ROUTES`, `fetchRoles`, `signInAs` (Task 3).
- Produces:
  - `scan(page) -> Promise<Array<{ id, impact, help, selector }>>`
  - `tally(violations) -> Record<string, number>`
  - `load() -> object`, `save(data) -> void`, `compare(baseline, found) -> { regressions, fixed, unchanged }`
  - `A11Y_BASELINE.json` shape: `{ "<route>::<role>": { "<ruleId>": { count: number, finding: string } } }`

- [ ] **Step 1: Write the ratchet's test first**

Create `a11y/harness/baseline.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { compare } from './baseline.mjs';

/**
 * The ratchet, and the two ways a baseline stops being a ratchet.
 *
 * A baseline is a place defects go to be forgotten unless two rules hold: a new
 * rule firing is a regression, and an EXISTING rule firing more often is also a
 * regression. Without the second, somebody adds nine more unlabelled buttons to
 * a page that already had one and the run stays green — which is worse than no
 * baseline, because it reads as proof.
 *
 * Every entry also carries the audit finding that explains it. An unexplained
 * entry is how a baseline becomes a list nobody can act on, so it is a failure.
 */
describe('the accessibility baseline ratchet', () => {
  const baseline = { '/::student': { 'color-contrast': { count: 2, finding: 'A-01' } } };

  it('accepts the same violations at the same count', () => {
    const r = compare(baseline, { '/::student': { 'color-contrast': 2 } });
    expect(r.regressions).toEqual([]);
  });

  it('reports a new rule as a regression', () => {
    const r = compare(baseline, { '/::student': { 'color-contrast': 2, 'button-name': 1 } });
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatchObject({ key: '/::student', rule: 'button-name', was: 0, now: 1 });
  });

  it('reports MORE of an existing rule as a regression', () => {
    const r = compare(baseline, { '/::student': { 'color-contrast': 3 } });
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatchObject({ rule: 'color-contrast', was: 2, now: 3 });
  });

  it('reports fewer as fixed, and never as a failure', () => {
    const r = compare(baseline, { '/::student': { 'color-contrast': 1 } });
    expect(r.regressions).toEqual([]);
    expect(r.fixed).toHaveLength(1);
  });

  it('treats a route absent from the baseline as all-new', () => {
    const r = compare(baseline, { '/settings::student': { 'label': 1 } });
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatchObject({ key: '/settings::student', was: 0 });
  });

  it('refuses a baseline entry with no audit finding id', () => {
    expect(() => compare({ '/::student': { 'label': { count: 1 } } }, {}))
      .toThrow(/finding/i);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run --project server a11y/harness/baseline.test.js`

Expected: FAIL — `Cannot find module './baseline.mjs'`.

- [ ] **Step 3: Write the ratchet**

Create `a11y/harness/baseline.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '../A11Y_BASELINE.json');

export function load() {
  if (!fs.existsSync(FILE)) return {};
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

export function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * The ratchet is one-way: counts may fall freely, and may only rise through an
 * explicit reviewed edit to the baseline file.
 */
export function compare(baseline, found) {
  const regressions = [];
  const fixed = [];
  const unchanged = [];

  for (const [key, rules] of Object.entries(baseline)) {
    for (const [rule, entry] of Object.entries(rules)) {
      if (!entry || typeof entry.finding !== 'string' || entry.finding === '') {
        throw new Error(
          `baseline entry ${key} / ${rule} has no audit finding id. `
          + 'Every accepted violation must point at the row that explains it.'
        );
      }
    }
  }

  const keys = new Set([...Object.keys(baseline), ...Object.keys(found)]);
  for (const key of keys) {
    const was = baseline[key] || {};
    const now = found[key] || {};
    for (const rule of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const before = was[rule]?.count ?? 0;
      const after = now[rule] ?? 0;
      if (after > before) regressions.push({ key, rule, was: before, now: after });
      else if (after < before) fixed.push({ key, rule, was: before, now: after });
      else unchanged.push({ key, rule, count: after });
    }
  }
  return { regressions, fixed, unchanged };
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run --project server a11y/harness/baseline.test.js`

Expected: PASS, six tests.

- [ ] **Step 5: Write the axe wrapper**

Create `a11y/harness/axe.mjs`:

```js
import AxeBuilder from '@axe-core/playwright';

/**
 * The WCAG 2.2 AA tag set, and nothing wider.
 *
 * `best-practice` is deliberately excluded. It reports things that are good
 * advice and not conformance failures, and mixing them into a baseline means
 * the ratchet can be tripped by an opinion — which is how a team learns to
 * ignore the ratchet.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function scan(page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.flatMap(v =>
    v.nodes.map(n => ({
      id: v.id, impact: v.impact, help: v.help,
      selector: Array.isArray(n.target) ? n.target.join(' ') : String(n.target)
    }))
  );
}

/** Violations collapsed to per-rule counts, which is what the baseline stores. */
export function tally(violations) {
  const out = {};
  for (const v of violations) out[v.id] = (out[v.id] || 0) + 1;
  return out;
}
```

- [ ] **Step 6: Write the sweep**

Create `a11y/sweep.axe.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { ROUTES } from './harness/routes.mjs';
import { fetchRoles } from './harness/roles.mjs';
import { signInAs } from './harness/signIn.mjs';
import { scan, tally } from './harness/axe.mjs';
import { load, save, compare } from './harness/baseline.mjs';

/**
 * axe over every route the table declares, for every distinct seeded role.
 *
 * One test, not one per route, because the ratchet has to see the whole run at
 * once: a per-route test could only compare its own row, and "this rule moved
 * from page A to page B" would read as one fix and one regression rather than as
 * nothing changing.
 *
 * Set A11Y_UPDATE_BASELINE=1 to record the current state. That is an explicit,
 * reviewable act, which is the only way the ratchet is allowed to loosen.
 */
test('axe finds no new WCAG 2.2 AA violations', async ({ browser, request, baseURL }) => {
  test.setTimeout(30 * 60 * 1000);

  const roles = await fetchRoles(request, baseURL);
  const found = {};
  const unreachable = [];

  for (const role of roles) {
    const statePath = await signInAs(browser, role, baseURL);
    const ctx = await browser.newContext({ baseURL, storageState: statePath });
    const page = await ctx.newPage();

    for (const route of ROUTES) {
      const res = await page.goto(route.concrete, { waitUntil: 'domcontentloaded' });

      /* A fixture that 404s means the seed changed under us. Recorded and failed
         at the end rather than skipped: a skip is how a route stops being
         audited without anybody noticing. */
      if (res && res.status() >= 400) {
        unreachable.push(`${route.concrete} (${role.key}) -> HTTP ${res.status()}`);
        continue;
      }

      /* Suspense fallbacks are LoadingSkeleton. Scanning one measures the
         skeleton, not the page. */
      await page.locator('#main-content, main, [role="main"]').first()
        .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});

      const violations = await scan(page);
      const counts = tally(violations);
      if (Object.keys(counts).length) found[`${route.path}::${role.key}`] = counts;
    }
    await ctx.close();
  }

  if (process.env.A11Y_UPDATE_BASELINE) {
    const stamped = {};
    for (const [key, rules] of Object.entries(found)) {
      stamped[key] = {};
      for (const [rule, count] of Object.entries(rules)) {
        stamped[key][rule] = { count, finding: 'A-00' };
      }
    }
    save(stamped);
    console.log('baseline written — replace every A-00 with a real finding id before committing');
  }

  expect(unreachable, `routes that did not load:\n${unreachable.join('\n')}`).toEqual([]);

  const { regressions, fixed } = compare(load(), found);
  if (fixed.length) console.log(`${fixed.length} violation(s) fixed since the baseline`);
  expect(
    regressions,
    'new accessibility violations:\n'
    + regressions.map(r => `  ${r.key} — ${r.rule}: ${r.was} -> ${r.now}`).join('\n')
  ).toEqual([]);
});
```

- [ ] **Step 7: Record the first baseline**

Run: `echo '{}' > a11y/A11Y_BASELINE.json && A11Y_UPDATE_BASELINE=1 npm run a11y -- a11y/sweep.axe.spec.js`

Expected: the sweep completes and rewrites `a11y/A11Y_BASELINE.json`. Read it. If `unreachable` is non-empty, fix `FIXTURES` in `a11y/harness/routes.mjs` against the real seed before continuing — a baseline recorded over unloadable routes is a baseline of nothing.

- [ ] **Step 8: Confirm the ratchet holds on a clean re-run**

Run: `npm run a11y -- a11y/sweep.axe.spec.js`

Expected: PASS with no regressions.

- [ ] **Step 9: Confirm the ratchet actually catches a regression**

Temporarily add an unlabelled icon button to `src/views/Settings.jsx`, inside the Appearance section around line 194:

```jsx
<button className="btn btn-icon btn-sm" onClick={() => {}}><span aria-hidden="true">*</span></button>
```

Run: `npm run a11y -- a11y/sweep.axe.spec.js`

Expected: FAIL naming `button-name` on `/settings`. **Then revert the edit** and re-run to confirm PASS. A ratchet never demonstrated to fail is a ratchet nobody should trust.

- [ ] **Step 10: Commit**

```bash
git add a11y/harness/axe.mjs a11y/harness/baseline.mjs a11y/harness/baseline.test.js a11y/sweep.axe.spec.js a11y/A11Y_BASELINE.json
git commit -m "Sweep every route and role with axe, behind a one-way ratchet"
```

Use this commit body:

```
The ratchet fails on a new rule AND on more of an existing rule. Without the
second half somebody adds nine more unlabelled buttons to a page that already
had one and the run stays green, which is worse than having no baseline because
it reads as proof. Counts may fall freely; they rise only through an explicit
edit to the committed file.

Every baseline entry must name the audit finding that explains it, or compare()
throws. An unexplained accepted violation is how a baseline becomes a list
nobody can act on.

best-practice tags are excluded: they report good advice rather than conformance
failures, and a ratchet that can be tripped by an opinion is a ratchet a team
learns to ignore. A route whose fixture 404s FAILS rather than skipping, because
a skip is how a page stops being audited without anybody noticing.
```

---

## Task 5: The two focus-indicator P0s

Both are application-wide, both live in `src/index.css`, and both are the defects the harness was built to make visible. Fixed together because one guard covers both.

**Files:**
- Modify: `src/index.css:4545-4549`, and append a `forced-colors` block
- Create: `src/focusIndicators.test.js`, `a11y/sweep.media.spec.js`

**Interfaces:**
- Consumes: `fetchRoles`, `signInAs` (Task 3).
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the CSS guard first**

Create `src/focusIndicators.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Every keyboard-operable control keeps a visible focus indicator, including in
 * forced-colors mode.
 *
 * ── The failure this exists to prevent ──
 *
 * `--focus` is a box-shadow by construction — `0 0 0 2px var(--surface), 0 0 0
 * 4px var(--brand)`, two rings — and index.css:3146 says so in a comment
 * explaining why `outline: 2px solid var(--focus)` would be invalid. So the
 * global rule replaced the outline with that shadow:
 *
 *     :focus { outline: none; }
 *     :focus-visible { outline: none; box-shadow: var(--focus); }
 *
 * Windows High Contrast Mode strips box-shadow. There was no
 * `@media (forced-colors: active)` block anywhere in 12,381 lines of this
 * stylesheet, so in that mode the application had NO focus indicator at all, on
 * any control, on any page — a 2.4.7 failure aimed precisely at the users most
 * likely to be in that mode. It was invisible in review because nobody reviews
 * CSS in High Contrast.
 *
 * `.composer-input` was worse and needed no special mode: it zeroed `outline`
 * and `box-shadow` together, on both `:focus` and `:focus-visible`, so the
 * message composer had no focus indicator for anybody.
 *
 * ── Why the rule is stated generally ──
 *
 * The bug was not two bad declarations. It was that killing an outline and
 * restoring it were separate decisions nobody kept paired. So this asserts the
 * property: no focus rule may zero its outline and its replacement together,
 * and the stylesheet must carry a forced-colors block that puts a real outline
 * back.
 */
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { body }` pair, comments already stripped. */
function rules() {
  return [...CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(m => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
    .filter(r => r.selector && !r.selector.startsWith('@'));
}

const zeroesOutline = body => /outline\s*:\s*(none|0)\b/.test(body);
const hasIndicator = body => /box-shadow\s*:\s*(?!none)/.test(body);

describe('focus indicators', () => {
  it('read the stylesheet at all', () => {
    /* Guards the guard: an empty read makes every assertion below vacuous. */
    expect(CODE.length).toBeGreaterThan(100000);
  });

  it('never zeroes an outline and its replacement together', () => {
    const offenders = rules()
      .filter(r => /:focus/.test(r.selector))
      .filter(r => zeroesOutline(r.body) && /box-shadow\s*:\s*none/.test(r.body))
      .map(r => r.selector);
    expect(
      offenders,
      `these focus rules leave no visible indicator: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('gives the message composer a focus indicator', () => {
    const composer = rules().filter(r => /\.composer/.test(r.selector) && /:focus/.test(r.selector));
    expect(composer.length, '.composer focus rules are gone — was the class renamed?')
      .toBeGreaterThan(0);
    expect(
      composer.some(r => hasIndicator(r.body)),
      '.composer has focus rules but none paints an indicator'
    ).toBe(true);
  });

  it('restores a real outline in forced-colors mode', () => {
    const block = CODE.match(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*?)\n\}/);
    expect(block, 'no @media (forced-colors: active) block — box-shadow focus rings vanish there')
      .toBeTruthy();
    const body = block[1];
    expect(body, 'the forced-colors block does not mention :focus-visible').toMatch(/:focus-visible/);
    expect(body, 'the forced-colors block declares no outline').toMatch(/outline\s*:\s*[^n]/);
    /* A system colour keyword, not a token: tokens are the thing forced-colors
       overrides, so `outline: 2px solid var(--brand)` would be repainted to
       whatever the user's scheme chose and could match the background. */
    expect(body, 'use a system colour keyword (Highlight / CanvasText / LinkText)')
      .toMatch(/\b(Highlight|CanvasText|LinkText|ButtonText)\b/);
  });
});
```

- [ ] **Step 2: Run and confirm three of four assertions fail**

Run: `npx vitest run --project client src/focusIndicators.test.js`

Expected: `read the stylesheet at all` PASSES. `never zeroes an outline and its replacement together` FAILS naming `.composer-input:focus, .composer-input:focus-visible`. `gives the message composer a focus indicator` FAILS. `restores a real outline in forced-colors mode` FAILS with "no @media (forced-colors: active) block".

- [ ] **Step 3: Confirm the composer's wrapper class before styling it**

Run: `grep -n 'className="composer' src/components/messages/ConversationPane.jsx`

Note the real wrapper class. The next step assumes `.composer`; if it is different, use the real one and say so in the CSS comment.

- [ ] **Step 4: Fix the composer**

In `src/index.css`, replace lines 4545-4549:

```css
.composer-input:focus,
.composer-input:focus-visible {
  outline: none;
  box-shadow: none;
}
```

with:

```css
/* The composer's visible border lives on the wrapper, so the ring belongs there
   rather than tight around the text. What must not happen is what did: both
   `outline` and `box-shadow` zeroed here, leaving the message composer as the
   one control in the application with no focus indicator at all. */
.composer-input:focus,
.composer-input:focus-visible {
  outline: none;
}

.composer:focus-within {
  box-shadow: var(--focus);
  border-radius: var(--r-sm);
}
```

- [ ] **Step 5: Add the forced-colors block**

Append to `src/index.css`:

```css
/* ==========================================================================
   Forced colors (Windows High Contrast, and any user colour scheme)
   ========================================================================== */

/**
 * Focus rings, restored.
 *
 * `--focus` is a box-shadow by construction — see the note at `.persona-option`
 * — and forced-colors mode strips box-shadow. Combined with the global
 * `:focus { outline: none }` near the top of this file, that left the whole
 * application with no focus indicator at all in the mode used by people who
 * most depend on one.
 *
 * The colour is a system keyword rather than a token on purpose: forced-colors
 * repaints authored colours, so `var(--brand)` could be mapped to something
 * indistinguishable from the background. `Highlight` is the colour the user's
 * own scheme picked for exactly this.
 */
@media (forced-colors: active) {
  :focus-visible {
    outline: 3px solid Highlight;
    outline-offset: 2px;
    /* Not merely redundant: a shadow that survived would sit under the outline
       and read as a doubled ring. */
    box-shadow: none;
  }

  /* Controls that opt out of the global rule and paint their own shadow ring.
     Listed because each declares `outline: none` locally, which the rule above
     cannot reach. */
  .dp-toggle:focus-visible,
  .dp-nav-btn:focus-visible,
  .dp-quick:focus-visible,
  .dp-cell:focus-visible,
  .form-input:focus,
  .composer:focus-within {
    outline: 3px solid Highlight;
    outline-offset: 2px;
  }
}
```

- [ ] **Step 6: Run the guard and confirm it passes**

Run: `npx vitest run --project client src/focusIndicators.test.js`

Expected: PASS, four tests.

- [ ] **Step 7: Confirm no token was invented and nothing else broke**

Run: `npx vitest run --project client src/tokens.test.js src/noHardcodedColors.test.js src/touchTargets.test.js src/documentContrast.test.js src/inputContrast.test.js`

Expected: PASS. If `noHardcodedColors` rejects `Highlight`, read its allowlist and add the system keywords with a comment explaining that a forced-colors keyword is the opposite of a hardcoded colour — it defers to the user's scheme.

- [ ] **Step 8: Write the browser proof**

Create `a11y/sweep.media.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { fetchRoles } from './harness/roles.mjs';
import { signInAs } from './harness/signIn.mjs';

/**
 * The CSS guard proves the rule is declared. This proves the browser paints it.
 *
 * Those are different claims, and the gap between them is where the original
 * defect lived: the declarations were all individually reasonable, and the
 * composed result was no ring at all.
 */
test('focus stays visible in forced-colors mode', async ({ browser, request, baseURL }) => {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath, forcedColors: 'active' });
  const page = await ctx.newPage();
  await page.goto('/settings');
  await page.locator('#main-content').waitFor({ state: 'visible' });

  /* Tab off the skip link and onto a real control. */
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');

  const painted = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    return {
      tag: el.tagName,
      outlineWidth: parseFloat(s.outlineWidth) || 0,
      outlineStyle: s.outlineStyle
    };
  });

  expect(painted, 'nothing was focused after two Tabs').not.toBeNull();
  expect(
    painted.outlineWidth,
    `${painted.tag} has outline-width ${painted.outlineWidth}px in forced-colors mode — `
    + 'box-shadow is stripped there, so an outline is the only indicator that survives'
  ).toBeGreaterThanOrEqual(2);
  expect(painted.outlineStyle).not.toBe('none');
  await ctx.close();
});

test('reduced-motion is respected, not merely shortened', async ({ browser, request, baseURL }) => {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.locator('#main-content').waitFor({ state: 'visible' });

  const moving = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      const dur = parseFloat(s.animationDuration) || 0;
      /* An infinite animation is the one that matters: a 200ms transition that
         still runs is a detail, a permanently spinning element is not. */
      if (s.animationIterationCount === 'infinite' && dur > 0) {
        out.push(el.className?.toString?.() || el.tagName);
      }
    }
    return out;
  });

  expect(
    moving,
    `these elements animate forever under prefers-reduced-motion: ${moving.join(', ')}`
  ).toEqual([]);
  await ctx.close();
});
```

- [ ] **Step 9: Run it**

Run: `npm run a11y -- a11y/sweep.media.spec.js`

Expected: the forced-colors test PASSES. The reduced-motion test may legitimately FAIL — a loading spinner is the usual cause. If it does, that is a real finding: fix the spinner's `@media (prefers-reduced-motion: reduce)` rule if it is a one-line change, or add the element to an explicit allowlist array in the test with a comment naming the audit finding id. Do not delete the assertion.

- [ ] **Step 10: Run the whole suite, then commit**

Run: `npm test && npm run lint && npm run build`

Expected: PASS. `src/index.css` grew, so `tokens.test.js`, `noHardcodedColors.test.js`, `documentContrast.test.js` and `inputContrast.test.js` all re-parse it.

```bash
git add src/index.css src/focusIndicators.test.js a11y/sweep.media.spec.js
git commit -m "Restore the focus ring this stylesheet loses in High Contrast Mode"
```

Use this commit body:

```
--focus is a box-shadow by construction — two rings, and index.css says so where
it explains why outline: 2px solid var(--focus) would be invalid. Forced-colors
mode strips box-shadow, and there was no forced-colors block anywhere in 12,381
lines, so with :focus { outline: none } above it this application had no focus
indicator at all, on any control, on any page, in the mode used by the people
who most depend on one. It was invisible in review because nobody reviews CSS in
High Contrast.

.composer-input needed no special mode: it zeroed outline and box-shadow
together on both :focus and :focus-visible, so the message composer had no
indicator for anybody. The ring moves to the wrapper's :focus-within, where the
visible border already is.

The system colour keyword is deliberate. forced-colors repaints authored
colours, so var(--brand) could be mapped to something indistinguishable from the
background; Highlight is what the user's own scheme chose for this.

Guarded twice, because they are different claims: a CSS parse proves the rule is
declared, and a forced-colors browser context proves it paints.
```

---

## Task 6: Keyboard reachability, focus order, and focus-not-obscured

**Files:**
- Create: `a11y/harness/measure.mjs`, `a11y/sweep.focus.spec.js`

**Interfaces:**
- Consumes: `ROUTES`, `fetchRoles`, `signInAs`.
- Produces: `walkFocus(page, max) -> Promise<Array<{ index, tag, name, outerHTML, inView, visibleRing, obscuredBy }>>`, `interactiveRects(page) -> Promise<Array<{ w, h, tag, name, outerHTML }>>`, `scrollsHorizontally(page) -> Promise<boolean>`. Task 7 uses the last two.

- [ ] **Step 1: Write the measurement primitives**

Create `a11y/harness/measure.mjs`:

```js
/**
 * Layout facts jsdom cannot produce.
 *
 * Every existing accessibility guard in this repo reads source text, and
 * src/touchTargets.test.js explains why: getBoundingClientRect is zero in jsdom,
 * so a rendered assertion there is vacuous in exactly the way that looks
 * convincing. This module is the other half.
 */

/** Presses Tab up to `max` times, recording what focus lands on. */
export async function walkFocus(page, max = 120) {
  const seen = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const step = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();

      /* An indicator is a real outline OR a real box-shadow. Both are
         legitimate here — --focus is a shadow — so requiring an outline would
         fail the whole application for a design decision. */
      const visibleRing =
        ((parseFloat(s.outlineWidth) || 0) >= 1 && s.outlineStyle !== 'none')
        || (s.boxShadow && s.boxShadow !== 'none');

      /**
       * 2.4.11 Focus Not Obscured (Minimum), new at AA in WCAG 2.2.
       *
       * The topbar is sticky and carries a backdrop-filter, which is the classic
       * way a focused control ends up underneath something. Sampling the centre
       * of the focused element and asking what the browser thinks is on top is
       * the cheapest honest test: if the answer is neither the element nor
       * related to it, something is covering it.
       */
      let obscuredBy = null;
      if (r.width && r.height) {
        const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
        const cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) {
          obscuredBy = top.className?.toString?.() || top.tagName;
        }
      }

      return {
        tag: el.tagName,
        name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60),
        outerHTML: el.outerHTML.slice(0, 120),
        inView: r.top >= 0 && r.bottom <= innerHeight,
        visibleRing,
        obscuredBy
      };
    });
    if (!step) break;
    seen.push({ index: i, ...step });
  }
  return seen;
}

/** Every interactive element with its rendered box, for target-size checks. */
export function interactiveRects(page) {
  return page.evaluate(() => {
    const SEL = 'a[href], button, input:not([type="hidden"]), select, textarea,'
      + ' [role="button"], [role="link"], [role="tab"], [role="checkbox"],'
      + ' [role="radio"], [role="switch"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
    return [...document.querySelectorAll(SEL)]
      .filter(el => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          tag: el.tagName,
          name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 50),
          outerHTML: el.outerHTML.slice(0, 120)
        };
      });
  });
}

/** True when the document scrolls on the cross axis — a 1.4.10 failure. */
export function scrollsHorizontally(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    /* One pixel of tolerance: sub-pixel layout rounding produces a 0.5px
       overflow on perfectly correct pages, and failing those trains people to
       ignore the check. */
    return d.scrollWidth > d.clientWidth + 1;
  });
}
```

- [ ] **Step 2: Write the focus sweep**

Create `a11y/sweep.focus.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { ROUTES } from './harness/routes.mjs';
import { fetchRoles } from './harness/roles.mjs';
import { signInAs } from './harness/signIn.mjs';
import { walkFocus } from './harness/measure.mjs';

/**
 * Keyboard reachability across every route, for the first seeded role.
 *
 * One role, not all of them, because focus order is a property of the shell and
 * the page rather than of authorisation, and the shell is shared. Role-specific
 * keyboard behaviour is covered by the workflow specs, which is where it
 * actually differs.
 */
test('every route is keyboard-navigable with a visible focus indicator', async ({ browser, request, baseURL }) => {
  test.setTimeout(30 * 60 * 1000);

  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  const page = await ctx.newPage();

  const noRing = [];
  const obscured = [];
  const noStops = [];

  for (const route of ROUTES) {
    await page.goto(route.concrete, { waitUntil: 'domcontentloaded' });
    await page.locator('#main-content, main, [role="main"]').first()
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    const walk = await walkFocus(page);

    /* A page with no tab stops at all is either genuinely static or a page whose
       controls are all divs. Both are worth seeing; neither is silently fine. */
    if (walk.length === 0) noStops.push(route.path);

    for (const step of walk) {
      if (!step.visibleRing) noRing.push(`${route.path} — ${step.tag} "${step.name}" ${step.outerHTML}`);
      if (step.obscuredBy) obscured.push(`${route.path} — ${step.tag} "${step.name}" covered by .${step.obscuredBy}`);
    }
  }
  await ctx.close();

  console.log(`routes with no tab stops: ${noStops.join(', ') || 'none'}`);

  expect(noRing, `controls that focus with no visible indicator:\n${noRing.join('\n')}`).toEqual([]);
  expect(obscured, `WCAG 2.2 2.4.11 — focused controls covered by other content:\n${obscured.join('\n')}`).toEqual([]);
});
```

- [ ] **Step 3: Run it and expect real findings**

Run: `npm run a11y -- a11y/sweep.focus.spec.js`

Expected: this is the first run that measures focus, so **failures here are the audit's output, not a bug in the test.** Capture the full output for Task 9. For each failure decide: a one-line CSS fix, or a P1/P2 finding recorded and added to an explicit allowlist array in the spec with a `// A-NN` comment. Do not weaken the assertions to get green.

If `obscured` reports many controls all covered by the same class, check whether that class is a transparent overlay — `elementFromPoint` returns it legitimately, and an overlay that intercepts nothing should carry `pointer-events: none`. That is itself the finding.

- [ ] **Step 4: Confirm green with the allowlist, then commit**

Run: `npm run a11y -- a11y/sweep.focus.spec.js && npm test`

Expected: PASS.

```bash
git add a11y/harness/measure.mjs a11y/sweep.focus.spec.js
git commit -m "Walk the keyboard through every route and measure what focus lands on"
```

Use this commit body:

```
Three things no static guard on this platform can check: that every control
reachable by Tab paints an indicator, that nothing covers the focused control
(2.4.11, new at AA in WCAG 2.2), and that a route has any tab stops at all.

The obscured check samples the centre of the focused element and asks the browser
what is on top. header.topbar is sticky and carries a backdrop-filter, which is
the classic way a focused control ends up underneath something.

An indicator counts as either a real outline or a real box-shadow. Requiring an
outline would fail the entire application for a design decision — --focus is a
shadow — and a check that fails everything is a check nobody reads.
```

---

## Task 7: Target size, reflow, and text spacing

**Files:**
- Create: `a11y/sweep.geometry.spec.js`

**Interfaces:**
- Consumes: `interactiveRects`, `scrollsHorizontally` (Task 6), `ROUTES`, `fetchRoles`, `signInAs`.

- [ ] **Step 1: Write the geometry sweep**

Create `a11y/sweep.geometry.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { ROUTES } from './harness/routes.mjs';
import { fetchRoles } from './harness/roles.mjs';
import { signInAs } from './harness/signIn.mjs';
import { interactiveRects, scrollsHorizontally } from './harness/measure.mjs';

/**
 * WCAG 2.2 2.5.8 Target Size (Minimum) — 24x24 CSS px, Level AA.
 *
 * Not 44. src/touchTargets.test.js cites "WCAG 2.1 §2.5.5" and enforces 44px;
 * 2.5.5 Target Size (Enhanced) is Level AAA. The AA criterion is 2.5.8, new in
 * 2.2, at 24x24. That guard is therefore STRICTER than conformance requires,
 * which is a good thing and is not being loosened — it just is not the number
 * this file measures against, and conflating them would report a house rule as
 * a conformance failure.
 */
const AA_MIN = 24;

/** The house rule, measured separately so the two are never confused. */
const HOUSE_MIN = 44;

async function eachRoute(browser, request, baseURL, contextOptions, visit) {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath, ...contextOptions });
  const page = await ctx.newPage();
  for (const route of ROUTES) {
    await page.goto(route.concrete, { waitUntil: 'domcontentloaded' });
    await page.locator('#main-content, main, [role="main"]').first()
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await visit(page, route);
  }
  await ctx.close();
}

test('interactive targets meet the 24x24 AA minimum', async ({ browser, request, baseURL }) => {
  test.setTimeout(30 * 60 * 1000);
  const tooSmall = [];
  await eachRoute(browser, request, baseURL, {}, async (page, route) => {
    for (const el of await interactiveRects(page)) {
      /* An inline link inside a sentence is explicitly excepted by 2.5.8. */
      if (el.tag === 'A' && el.h < AA_MIN && el.w > AA_MIN * 2) continue;
      if (el.w < AA_MIN || el.h < AA_MIN) {
        tooSmall.push(`${route.path} — ${el.w}x${el.h} ${el.tag} "${el.name}" ${el.outerHTML}`);
      }
    }
  });
  expect(tooSmall, `below the 24x24 AA floor:\n${tooSmall.join('\n')}`).toEqual([]);
});

test('touch targets are measured against the 44px house rule', async ({ browser, request, baseURL }) => {
  test.setTimeout(30 * 60 * 1000);
  const tooSmall = [];
  await eachRoute(
    browser, request, baseURL,
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    async (page, route) => {
      for (const el of await interactiveRects(page)) {
        if (el.tag === 'A' && el.w > HOUSE_MIN * 2) continue;
        if (el.w < HOUSE_MIN || el.h < HOUSE_MIN) {
          tooSmall.push(`${route.path} — ${el.w}x${el.h} ${el.tag} "${el.name}"`);
        }
      }
    }
  );
  /* Reported, not failed. The 44px rule is a house rule above AA, and failing
     the build on it before the inventory exists would stall the audit on
     something that is not a conformance defect. Task 9 records these. */
  console.log(`below the 44px house rule (${tooSmall.length}):\n${tooSmall.join('\n')}`);
});

/**
 * WCAG 1.4.10 Reflow — 320 CSS px with no two-axis scrolling.
 *
 * 320px is the criterion's own number: 1280 at 400% zoom. Tested by viewport
 * rather than by zoom because they are equivalent for layout and a viewport is
 * reproducible.
 */
test('no route scrolls horizontally at 320px', async ({ browser, request, baseURL }) => {
  test.setTimeout(30 * 60 * 1000);
  const overflowing = [];
  await eachRoute(
    browser, request, baseURL, { viewport: { width: 320, height: 512 } },
    async (page, route) => {
      if (await scrollsHorizontally(page)) {
        const w = await page.evaluate(() => document.documentElement.scrollWidth);
        overflowing.push(`${route.path} — scrollWidth ${w} at a 320 viewport`);
      }
    }
  );
  expect(overflowing, `WCAG 1.4.10 Reflow failures:\n${overflowing.join('\n')}`).toEqual([]);
});

/**
 * WCAG 1.4.12 Text Spacing — the exact four values the criterion names.
 *
 * Applied with !important because the criterion is about a user stylesheet doing
 * precisely that, and the failure it looks for is a fixed-height container
 * clipping the result. Scrollable containers are excluded: scrollable is not
 * clipped.
 */
test('content is not clipped under the 1.4.12 text-spacing overrides', async ({ browser, request, baseURL }) => {
  test.setTimeout(30 * 60 * 1000);
  const clipped = [];
  await eachRoute(browser, request, baseURL, {}, async (page, route) => {
    await page.addStyleTag({ content: `
      * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
      p { margin-bottom: 2em !important; }
    ` });

    const hits = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        if (s.overflow === 'visible' && s.overflowY === 'visible') continue;
        if (s.overflowY === 'auto' || s.overflowY === 'scroll') continue;
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2) {
          out.push(`${el.tagName}.${el.className?.toString?.().slice(0, 40)} ${el.clientHeight}<${el.scrollHeight}`);
        }
      }
      return out.slice(0, 15);
    });
    if (hits.length) clipped.push(`${route.path}: ${hits.join('; ')}`);
  });
  console.log(`possible 1.4.12 clipping (${clipped.length}):\n${clipped.join('\n')}`);
});
```

- [ ] **Step 2: Run it**

Run: `npm run a11y -- a11y/sweep.geometry.spec.js`

Expected: the two reporting tests always pass and print findings. The 2.5.8 and 1.4.10 tests may FAIL — those failures are the audit's output. For each, decide fix-now (a one-line CSS change) or record-as-finding with an allowlist entry carrying a finding id.

- [ ] **Step 3: Commit**

```bash
git add a11y/sweep.geometry.spec.js
git commit -m "Measure target size, reflow and text spacing in a real viewport"
```

Use this commit body:

```
The AA target-size criterion is 2.5.8 at 24x24, new in WCAG 2.2.
touchTargets.test.js cites 2.5.5 and enforces 44px, but 2.5.5 is Level AAA — so
that guard is stricter than conformance requires, which is good and stays. The
two are measured separately here so a house rule is never reported as a
conformance failure: 24x24 fails the run, 44px is printed.

Reflow uses a 320px viewport, which is the criterion's own number (1280 at
400%), because a viewport is reproducible where a zoom factor is not. Text
spacing applies the exact four values 1.4.12 names, with !important, because a
user stylesheet is precisely what the criterion describes — and scrollable
containers are excluded, since scrollable is not clipped.
```

---

## Task 8: Accessible structure and heading tree

**Files:**
- Create: `a11y/sweep.aria.spec.js`

**Interfaces:**
- Consumes: `ROUTES`, `fetchRoles`, `signInAs`.

- [ ] **Step 1: Write the sweep**

Create `a11y/sweep.aria.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { ROUTES } from './harness/routes.mjs';
import { fetchRoles } from './harness/roles.mjs';
import { signInAs } from './harness/signIn.mjs';

/**
 * The accessible structure the browser actually computes, per route.
 *
 * axe reports rule violations; this records STRUCTURE — what a screen-reader
 * user navigates by. The two find different things: a page can satisfy every axe
 * rule and still present eleven h3s under no h2, or a landmark set that makes
 * the rotor useless.
 */
test('the accessible structure of every route holds up', async ({ browser, request, baseURL }) => {
  test.setTimeout(30 * 60 * 1000);
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  const page = await ctx.newPage();

  const wrongH1 = [];
  const badHeadings = [];
  const ambiguousLandmarks = [];

  for (const route of ROUTES) {
    await page.goto(route.concrete, { waitUntil: 'domcontentloaded' });
    await page.locator('#main-content, main, [role="main"]').first()
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    const structure = await page.evaluate(() => {
      const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .map(h => ({ level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 40) }));

      const skips = [];
      for (let i = 1; i < levels.length; i++) {
        if (levels[i].level > levels[i - 1].level + 1) {
          skips.push(`h${levels[i - 1].level} "${levels[i - 1].text}" -> h${levels[i].level} "${levels[i].text}"`);
        }
      }

      /* Two landmarks of the same role need distinct names to be usable in a
         rotor. App.jsx renders two <nav> elements — the rail and the mobile bar
         — and both are labelled "Main", which is the case worth catching. */
      const byRole = {};
      for (const el of document.querySelectorAll('nav,main,header,footer,aside,[role="navigation"],[role="region"]')) {
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const name = (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '').trim();
        (byRole[role] ||= []).push(name);
      }
      const ambiguous = Object.entries(byRole)
        .filter(([, names]) => names.length > 1 && new Set(names).size < names.length)
        .map(([role, names]) => `${role} x${names.length} all named "${names[0] || '(unnamed)'}"`);

      return { h1Count: levels.filter(l => l.level === 1).length, skips, ambiguous };
    });

    if (structure.h1Count !== 1) wrongH1.push(`${route.path} has ${structure.h1Count} h1 elements`);
    if (structure.skips.length) badHeadings.push(`${route.path}: ${structure.skips.join('; ')}`);
    if (structure.ambiguous.length) ambiguousLandmarks.push(`${route.path}: ${structure.ambiguous.join(', ')}`);
  }
  await ctx.close();

  /* Reported rather than failed: a skipped heading level is a 1.3.1 concern
     whose fix is often a decision about what the missing section is, and
     stalling the harness on it would stop the audit meant to enumerate them. */
  console.log(`skipped heading levels (${badHeadings.length}):\n${badHeadings.join('\n')}`);
  console.log(`indistinguishable duplicate landmarks (${ambiguousLandmarks.length}):\n${ambiguousLandmarks.join('\n')}`);

  /* This one DOES fail. src/headingLevels.test.js already enforces exactly one
     h1 per page by static analysis, reasoning about an allowlist of views that
     render outside the shell. If runtime disagrees, that reasoning is wrong,
     and a guard that is wrong is worse than no guard. */
  expect(wrongH1, `routes whose h1 count contradicts headingLevels.test.js:\n${wrongH1.join('\n')}`).toEqual([]);
});
```

- [ ] **Step 2: Run it**

Run: `npm run a11y -- a11y/sweep.aria.spec.js`

Expected: the `h1` assertion should PASS on every route, because `src/headingLevels.test.js` already enforces it statically — this is the browser confirming that guard was telling the truth. **If any route fails it, that is a significant finding:** the static guard's allowlist reasoning does not hold at runtime. Record it in Task 9 and fix the guard, not the assertion.

- [ ] **Step 3: Commit**

```bash
git add a11y/sweep.aria.spec.js
git commit -m "Record the accessible structure of every route, from the browser"
```

Use this commit body:

```
axe reports rule violations; this records what a screen-reader user navigates by.
A page can satisfy every axe rule and still present eleven h3s under no h2, or
two navigation landmarks both labelled "Main" — which App.jsx does render, and
which makes a rotor useless for telling the rail from the mobile bar.

The one-h1 assertion is the browser checking headingLevels.test.js's claim. That
guard reasons about source text and an allowlist of views rendering outside the
shell; if runtime disagrees with it, the allowlist reasoning is wrong, and a
guard that is wrong is worse than no guard. Skipped heading levels are reported
rather than failed, because their fix is usually a decision about what the
missing section is, and stalling here would stop the audit meant to enumerate
them.
```

---

## Task 9: The location cluster, at its true severity

**Files:**
- Modify: `src/components/location/LocationThumbnail.jsx`, `src/components/location/LocationCard.jsx`, `src/components/location/index.js`, `src/components/EventCard.jsx`
- Delete: `src/components/location/LocationDisplay.jsx`
- Create: `src/components/location/locationSemantics.test.jsx`

**Interfaces:**
- Consumes: the existing `DirectionsButton` component and `mapsDirectionsUrl` util.
- Produces: nothing later tasks import.

- [ ] **Step 1: Confirm the reachability claim before deleting anything**

Run: `grep -rn "LocationDisplay" --include='*.jsx' --include='*.js' src | grep -v "components/location/"`

Expected: nothing. If anything appears, **stop and do not delete** — repair it instead, and record that the plan was wrong.

- [ ] **Step 2: Write the guard first**

Create `src/components/location/locationSemantics.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import LocationThumbnail from './LocationThumbnail';
import LocationCard from './LocationCard';

/**
 * The location cluster's controls are real controls, or they are not controls.
 *
 * ── What was wrong, and what was not ──
 *
 * LocationThumbnail rendered `<span onClick>`: keyboard-unreachable, with no
 * role and no key handler. It was NOT a blocker, and the audit says so — its
 * onClick was `onViewDetails`, the same action as the card's footer button at
 * EventCard.jsx:133, so a keyboard user always had a working, properly-named
 * control. It was a duplicate affordance, and probably a broken one: the button
 * calls onViewDetails(event) while the span called onViewDetails(clickEvent),
 * and the handler App.jsx supplies is named openEventById. So the fix is to stop
 * pretending a line of text is a button, not to promote it to one — a button
 * named "Riverside Park · 2.3 mi away" would be a worse control than the one
 * that already exists.
 *
 * LocationCard is the live directions surface, and its button is real and
 * visibly labelled. What it is not is a link: window.open means cmd-click and
 * middle-click do nothing, a popup blocker eats it silently, and nothing tells a
 * screen reader a new tab opened. DirectionsButton already solves all three — a
 * real anchor, mapsDirectionsUrl with a geo: handoff, an aria-label, and an
 * sr-only "(opens in a new tab)" — and was unused. Adopting it is the
 * shared-component-first rule applying to a component that already existed.
 */
describe('LocationThumbnail', () => {
  it('is not a control, because the card already has one', () => {
    const { container } = render(
      <LocationThumbnail location="Riverside Park" latitude={1} longitude={2} distance={2.3} />
    );
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[tabindex]')).toBeNull();
  });

  it('still shows the place and the distance', () => {
    render(<LocationThumbnail location="Riverside Park" latitude={1} longitude={2} distance={2.3} />);
    expect(screen.getByText(/Riverside Park/)).toBeInTheDocument();
    expect(screen.getByText(/2\.3 mi away/)).toBeInTheDocument();
  });

  it('accepts no onClick at all', () => {
    /* A prop that silently does nothing is worse than a missing one: a caller
       keeps passing it and believes the affordance exists. */
    expect(String(LocationThumbnail)).not.toMatch(/onClick/);
  });
});

describe('LocationCard directions', () => {
  const props = { location: 'Riverside Park', address: '1 Main St', latitude: 1, longitude: 2 };

  it('offers directions as a link, not a scripted window.open', () => {
    render(<LocationCard {...props} />);
    const link = screen.getByRole('link', { name: /get directions/i });
    expect(link).toHaveAttribute('href');
    expect(link.getAttribute('href')).not.toBe('');
  });

  it('says that it opens elsewhere', () => {
    render(<LocationCard {...props} />);
    expect(screen.getByRole('link', { name: /get directions/i }).textContent).toMatch(/opens in/i);
  });

  it('does not make the map a clickable non-control', () => {
    expect(String(LocationCard)).not.toMatch(/onClick=\{openDirections\}/);
    expect(String(LocationCard)).not.toMatch(/window\.open/);
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `npx vitest run --project client src/components/location/locationSemantics.test.jsx`

Expected: FAIL — the thumbnail still has an `onClick`, and `LocationCard` renders a `button` where a `link` is asked for.

- [ ] **Step 4: Make the thumbnail a fact instead of a control**

Replace `src/components/location/LocationThumbnail.jsx` entirely:

```jsx
import React from 'react';
import { MapPin } from 'lucide-react';
import './LocationDisplay.css';

/**
 * Lightweight location fact for event cards and list views.
 *
 * ── Why this is not clickable ──
 *
 * It used to be `<span onClick={onViewDetails}>` with an inline `cursor:
 * pointer` — keyboard-unreachable, no role, no key handler. Promoting it to a
 * button would have produced a control whose accessible name is "Riverside Park
 * · 2.3 mi away", which describes a place and not an action, sitting beside the
 * card's real footer button that already does the same thing and says so.
 *
 * The duplicate was also probably broken. EventCard's footer calls
 * `onViewDetails(event)`; this span called `onViewDetails(clickEvent)`, passing a
 * React synthetic event to a handler App.jsx names `openEventById`.
 *
 * So the location is information now, and the action stays where it is named.
 */
export default function LocationThumbnail({ location, latitude, longitude, distance }) {
  const hasCoords = latitude != null && longitude != null;

  return (
    <span className="eventcard-fact">
      <MapPin size={14} aria-hidden="true" />
      <span className="truncate" title={location}>
        {location}
        {hasCoords && distance != null && (
          <span className="s-775d10" style={{ opacity: 0.8 }}> · {distance.toFixed(1)} mi away</span>
        )}
      </span>
    </span>
  );
}
```

- [ ] **Step 5: Drop the now-dead prop at the call site**

In `src/components/EventCard.jsx`, remove the `onClick={onViewDetails}` line from the `LocationThumbnail` element (around line 115), leaving its other props unchanged. Do **not** remove `onViewDetails` from the component's props — the footer button at line 133 still uses it.

- [ ] **Step 6: Adopt `DirectionsButton` in `LocationCard`**

In `src/components/location/LocationCard.jsx`:

Add the import:

```jsx
import DirectionsButton from './DirectionsButton';
```

Delete the `openDirections` function and remove `Navigation` from the `lucide-react` import. Replace the button:

```jsx
          <button className="btn btn-secondary btn-sm location-directions-btn" onClick={openDirections}>
            <Navigation size={14} /> Get Directions
          </button>
```

with:

```jsx
          {/* DirectionsButton, not a scripted window.open: it is a real anchor,
              so cmd-click and middle-click work and a popup blocker cannot eat
              it, and it carries the sr-only "(opens in a new tab)" this card was
              missing. It also falls back from coordinates to the address to the
              place name, which the old handler did too but less carefully. */}
          <DirectionsButton
            latitude={latitude}
            longitude={longitude}
            address={address}
            location={location}
          />
```

And remove `onClick={openDirections}` from the `MapPreview` element, leaving its other props unchanged.

- [ ] **Step 7: Delete the unreachable component**

Run: `git rm src/components/location/LocationDisplay.jsx`

Remove its line from `src/components/location/index.js`:

```js
export { default as LocationDisplay } from './LocationDisplay';
```

`LocationDisplay.css` **stays** — `WeatherSummary`, `MapReveal`, `LocationPrompt`, `LocationLink`, `DirectionsButton` and `LocationThumbnail` all import it.

- [ ] **Step 8: Run the guard, then everything**

Run: `npx vitest run --project client src/components/location/locationSemantics.test.jsx`

Expected: PASS, six tests.

Run: `npm test && npm run lint && npm run build`

Expected: PASS. If an existing test asserted the thumbnail was clickable, it encoded the defect — update it and say so in the commit. If `build` fails on a missing `LocationDisplay` export, something still imports it and Step 1's check was wrong; restore the file and record that.

- [ ] **Step 9: Commit**

```bash
git add -A src/components/location src/components/EventCard.jsx
git commit -m "Stop a line of text pretending to be a button, and delete a component nobody renders"
```

Use this commit body:

```
LocationThumbnail was <span onClick={onViewDetails}> with an inline cursor:
pointer — keyboard-unreachable, no role, no key handler. It was not a blocker,
and the audit records it as P2 rather than P0: the same action sits on the card's
footer button, properly named. Promoting the span would have created a control
whose accessible name is "Riverside Park · 2.3 mi away" — a place, not an action
— beside the one that already says what it does. It was probably broken too: the
footer passes the event object, the span passed a DOM event, and the handler is
named openEventById.

LocationDisplay had a worse version of the same defect and no referrers outside
its own directory; the live event-details path renders LocationCard. Calling it a
P0 implied somebody was affected, and nobody was.

LocationCard's directions button was real and labelled but was not a link, so
cmd-click and middle-click did nothing, a popup blocker could eat it silently,
and nothing announced a new tab. DirectionsButton already solved all three and
was unused. Adopting it is shared-component-first applied to a component that
already existed.
```

---

## Task 10: Deep keyboard workflow specs

Twelve journeys, in four commits so a reviewer can reject one cluster without rejecting all of them.

**Files:**
- Create: `a11y/workflows/auth.spec.js`, `discover.spec.js`, `search.spec.js`, `signup.spec.js`, `schedule.spec.js`, `attendance.spec.js`, `hours.spec.js`, `profile.spec.js`, `notifications.spec.js`, `messages.spec.js`, `settings.spec.js`, `welly.spec.js`

**Interfaces:**
- Consumes: `fetchRoles`, `signInAs`, `walkFocus`.

- [ ] **Step 1: Write the auth cluster**

Create `a11y/workflows/auth.spec.js`:

```js
import { test, expect } from '@playwright/test';

/**
 * The authentication journey, keyboard only.
 *
 * Auth is where an accessibility failure is total: everything else in the
 * application is behind it. It is also where security mechanisms are most
 * tempted to break accessibility, which is why the paste assertion is here —
 * WCAG 2.2 3.3.8 Accessible Authentication (Minimum) is satisfied today because
 * nothing in this codebase cancels a paste event, and that is a property worth
 * pinning rather than rediscovering.
 */
test('sign-in is completable with the keyboard alone', async ({ page }) => {
  await page.goto('/login');

  /* Fields are reached by accessible name, not by counting Tabs. A count
     encodes the current layout, breaks on any change, and teaches people to
     delete the test instead of reading it. */
  const email = page.getByLabel(/email/i);
  await email.focus();
  await page.keyboard.type('alex@example.org');
  await page.keyboard.press('Tab');
  await page.keyboard.type('password123');
  await page.keyboard.press('Enter');

  await expect(page.locator('#main-content')).toBeVisible({ timeout: 20000 });
});

test('the password field accepts paste, so a password manager works', async ({ page }) => {
  await page.goto('/login');
  const pw = page.getByLabel(/password/i).first();
  const blocked = await pw.evaluate(el => {
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    /* defaultPrevented is the thing 3.3.8 cares about: a handler that cancels
       paste is what breaks a password manager. */
    return ev.defaultPrevented;
  });
  expect(blocked, 'a paste handler cancelled the event — this breaks password managers').toBe(false);
});

test('a rejected sign-in explains itself in text, not only in colour', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('nobody@example.org');
  await page.getByLabel(/password/i).first().fill('wrongpassword');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  const alert = page.locator('[role="alert"], [aria-live="assertive"], [aria-live="polite"]')
    .filter({ hasText: /\S/ }).first();
  await expect(alert, 'no live region carried the error, so it is only visual')
    .toBeVisible({ timeout: 15000 });
  const text = (await alert.textContent()).trim();
  expect(text.length, 'the error region is empty').toBeGreaterThan(10);
});

test('focus is not lost when sign-in fails', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('nobody@example.org');
  await page.getByLabel(/password/i).first().fill('wrongpassword');
  await page.getByRole('button', { name: /^sign in$/i }).press('Enter');
  await expect(page.locator('[role="alert"], [aria-live]').filter({ hasText: /\S/ }).first())
    .toBeVisible({ timeout: 15000 });
  const focused = await page.evaluate(() => document.activeElement?.tagName || 'BODY');
  expect(focused, 'focus fell to the body, so the keyboard user restarts from the top')
    .not.toBe('BODY');
});
```

- [ ] **Step 2: Run it and record what fails**

Run: `npm run a11y -- a11y/workflows/auth.spec.js`

Expected: run it and record. Failures here are audit findings. Fix a one-line defect; otherwise record it with a finding id and mark the test `test.fixme` with a comment naming that id — `fixme` keeps it visible where a deletion would not.

- [ ] **Step 3: Commit the auth cluster**

```bash
git add a11y/workflows/auth.spec.js
git commit -m "Walk the authentication journey with a keyboard only"
```

Use this commit body:

```
Auth is where an accessibility failure is total, because the rest of the
application is behind it, and it is where security mechanisms are most tempted to
break accessibility.

The paste assertion pins a property this codebase already has: nothing anywhere
cancels a paste event, which is what satisfies WCAG 2.2 3.3.8 and what lets a
password manager work. Worth pinning rather than rediscovering the next time
somebody reaches for onPaste to stop a user pasting their own password.

Field lookups go by accessible name rather than by counting Tabs. A count
encodes the current layout, breaks on any change, and teaches people to delete
the test instead of reading it.
```

- [ ] **Step 4: Write the discovery cluster**

Create `a11y/workflows/discover.spec.js`, `a11y/workflows/search.spec.js`, `a11y/workflows/signup.spec.js`. Each follows the shape of `auth.spec.js` — a docstring naming the failure it prevents, then tests — and each must assert, for its journey:

- the journey completes with the keyboard alone (Tab / Shift+Tab / Enter / Space / Escape, plus arrow keys for any widget claiming an ARIA pattern);
- every control it touches has a non-empty accessible name that describes an action, not a place;
- status is available as text, not by colour alone. For `signup.spec.js` specifically, assert that seat availability reads as words — `src/components/Seats.jsx` renders it — and not only as a coloured bar;
- an async result (a filter applied, a search returning, a signup succeeding) reaches a live region;
- an empty result state has both a heading and explanatory text. `src/components/common/EmptyState.headings.test.jsx` already guards the heading statically; assert the rendered result.

- [ ] **Step 5: Run, record, commit the discovery cluster**

Run: `npm run a11y -- a11y/workflows/discover.spec.js a11y/workflows/search.spec.js a11y/workflows/signup.spec.js`

```bash
git add a11y/workflows/discover.spec.js a11y/workflows/search.spec.js a11y/workflows/signup.spec.js
git commit -m "Walk discovery, search and signup with a keyboard only"
```

Use this commit body:

```
The three journeys a volunteer cannot skip. Each asserts the same four things:
the journey completes without a mouse, every control's accessible name describes
an action rather than a place, status is available as words and not only as
colour, and an async result reaches a live region.

Seat availability gets a named assertion because it is the clearest colour-only
risk on the platform: a coloured bar saying "nearly full" says nothing to
somebody who cannot see it.
```

- [ ] **Step 6: Write the scheduling and participation cluster**

Create `a11y/workflows/schedule.spec.js`, `a11y/workflows/attendance.spec.js`, `a11y/workflows/hours.spec.js`.

`schedule.spec.js` must test `src/components/common/DatePicker.jsx` against the ARIA APG date-picker dialog pattern it implies: opens with Enter and with Space from the toggle; arrow keys move by day; the month control changes month; Home and End reach the week's ends; Escape closes and **returns focus to the toggle**; the focused date's accessible name includes the full date rather than just the number; a disabled date is announced as disabled; the selected date is announced as selected.

`attendance.spec.js` must cover `src/views/CheckInView.jsx`, `src/components/CheckInCodeModal.jsx` and `src/components/CheckInScanner.jsx` — and must assert that a **non-camera** check-in route exists, since a camera-only check-in is a barrier for several disabilities at once.

`hours.spec.js` must cover `src/views/LogExternalHours.jsx` and `src/views/LoggedHours.jsx`: every field has a programmatically associated label, required fields are indicated other than by colour, a validation error is associated with its field via `aria-describedby` or `aria-errormessage`, and the credited-hours figure is readable as text.

- [ ] **Step 7: Run, record, commit**

Run: `npm run a11y -- a11y/workflows/schedule.spec.js a11y/workflows/attendance.spec.js a11y/workflows/hours.spec.js`

```bash
git add a11y/workflows/schedule.spec.js a11y/workflows/attendance.spec.js a11y/workflows/hours.spec.js
git commit -m "Test the calendar against the pattern it claims, and check-in against the camera"
```

Use this commit body:

```
DatePicker's own docstring says a calendar is the easiest place accessibility is
lost, and it was written to avoid that. This holds it to the APG date-picker
dialog contract it implies: arrow keys by day, Home and End to the week's ends,
Escape returning focus to the toggle, and disabled and selected dates announced
as such rather than merely styled.

The check-in scanner gets a named assertion that a non-camera route exists. A
camera-only check-in is a barrier for several disabilities at once, and it is the
kind that looks fine in review because the reviewer has a working camera and a
steady hand.
```

- [ ] **Step 8: Write the account and communication cluster**

Create `a11y/workflows/profile.spec.js`, `a11y/workflows/notifications.spec.js`, `a11y/workflows/messages.spec.js`, `a11y/workflows/settings.spec.js`.

`profile.spec.js`: `src/components/ProfileEditModal.jsx` — focus moves into the dialog on open, is contained while open, Escape closes it, and focus **returns to the element that opened it**. (`src/components/dialogSemantics.test.jsx` asserts the ARIA wiring; this asserts the browser behaviour.)

`notifications.spec.js`: `src/components/NotificationsBell.jsx` has an accessible name containing the unread count **as a number in text**; the popover is keyboard-operable and closes on Escape; `src/components/common/Toasts.jsx` announces through a live region; unread state is not conveyed by colour alone.

`messages.spec.js`: `src/components/messages/RecipientPicker.jsx` against the APG combobox pattern — `aria-expanded` tracks the listbox, `aria-controls` points at it, arrow keys move through options via `aria-activedescendant` or roving focus, Enter selects, Escape closes; and `ConversationPane`'s message list identifies each message's author and boundary.

`settings.spec.js`: the section navigation is keyboard-operable at both mobile and desktop widths — it is `searchParams`-driven, so assert the URL and the rendered section agree — and every form control has a programmatically associated label.

- [ ] **Step 9: Run, record, commit**

Run: `npm run a11y -- a11y/workflows/profile.spec.js a11y/workflows/notifications.spec.js a11y/workflows/messages.spec.js a11y/workflows/settings.spec.js`

```bash
git add a11y/workflows/profile.spec.js a11y/workflows/notifications.spec.js a11y/workflows/messages.spec.js a11y/workflows/settings.spec.js
git commit -m "Prove the dialog, combobox and notification behaviour in a browser"
```

Use this commit body:

```
dialogSemantics.test.jsx already asserts the ARIA wiring is present. These
assert the browser does the thing: focus moves in, stays in, and comes back to
the control that opened it. Those are different claims, and the gap between them
is where a dialog that reads correctly still traps somebody.

RecipientPicker is held to the APG combobox contract because its own header
records that its results list used to be div-onClick soup. The notification bell
must carry the unread count as a number in its accessible name — a coloured dot
is not a count.
```

- [ ] **Step 10: Write the Welly spec, tagged `@local`**

Create `a11y/workflows/welly.spec.js`:

```js
import { test, expect } from '@playwright/test';

/**
 * Welly, with a real model.
 *
 * Tagged @local and excluded from CI. VITE_LOCAL_AI=false — which CI must use,
 * because otherwise every page load downloads a model — renders the
 * engine-unavailable state, so a CI run would audit a placeholder and prove
 * nothing while appearing to pass. Run with `npm run a11y:local`.
 *
 * ── The live-region question this exists to answer ──
 *
 * Streamed text on this platform IS the committed text; there is no post-hoc
 * repair. A naive aria-live="polite" wrapped around the growing bubble would
 * therefore re-announce the whole accumulating string on every chunk, which is
 * unusable rather than merely verbose. What must be established is whether the
 * wiring announces COMPLETION or ACCUMULATION — and a machine can see which
 * element carries the live region and how its text changes, even though only a
 * person can hear the result. The human half is in the VoiceOver script.
 */
test('@local the chat input has a real accessible name', async ({ page }) => {
  await page.goto('/welly');
  await page.locator('#main-content').waitFor({ state: 'visible' });

  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 120000 });

  const name = await input.evaluate(el =>
    el.getAttribute('aria-label')
    || el.labels?.[0]?.textContent
    || document.querySelector(`label[for="${el.id}"]`)?.textContent
    || '');
  expect(name.trim(), 'the Welly input has no accessible name — a placeholder is not a label')
    .not.toBe('');
});

test('@local record how a streamed reply reaches the live region', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.goto('/welly');
  await page.locator('#main-content').waitFor({ state: 'visible' });

  const live = page.locator('[aria-live]').first();
  await expect(live, 'Welly has no live region at all').toBeAttached({ timeout: 120000 });

  /* Sample the live region's text over time. A region whose content grows
     monotonically across many samples is announcing accumulation. */
  const samples = [];
  const stop = setInterval(async () => {
    samples.push((await live.textContent().catch(() => '')) || '');
  }, 250);

  await page.getByRole('textbox').first().fill('How many hours do I have?');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(20000);
  clearInterval(stop);

  const distinct = [...new Set(samples.filter(Boolean))];
  const growing = distinct.filter((s, i) => i > 0 && s.startsWith(distinct[i - 1]) && s.length > distinct[i - 1].length);

  /* Deliberately not a threshold. The right announcement strategy is a design
     decision this audit is measuring, not one it should impose. Recorded so the
     audit document and the VoiceOver script can be written from evidence. */
  console.log(`live-region samples: ${distinct.length} distinct, ${growing.length} strictly growing`);
  console.log(distinct.slice(0, 6).map(s => `  "${s.slice(0, 80)}"`).join('\n'));
  expect(distinct.length, 'the live region never changed — nothing was announced').toBeGreaterThan(0);
});
```

- [ ] **Step 11: Run it locally with a real model**

Run: `npm run a11y:local`

Expected: slow — the model downloads. Record the live-region evidence for Task 11's audit document, and use it to write the Welly section of the VoiceOver script precisely.

- [ ] **Step 12: Confirm CI excludes it, then commit**

Run: `npm run a11y -- --grep-invert @local`

Expected: the Welly tests do not run.

```bash
git add a11y/workflows/welly.spec.js
git commit -m "Audit Welly with a real model, and keep it out of CI on purpose"
```

Use this commit body:

```
VITE_LOCAL_AI=false renders the engine-unavailable state, so a CI run would audit
a placeholder and pass while proving nothing. Tagged @local and excluded, with
the reason recorded in the audit document rather than buried in config.

The streaming assertion is deliberately evidence-gathering rather than a
threshold. Streamed text here IS the committed text with no post-hoc repair, so
a live region around the growing bubble would re-announce the whole accumulating
string on every chunk — unusable, not merely verbose. Whether the current wiring
announces completion or accumulation is what this measures; whether the result is
bearable is what the VoiceOver script asks a person.
```

---

## Task 11: The audit document and the VoiceOver script

**Files:**
- Create: `bin/a11y-report.mjs`, `docs/audits/2026-08-21-accessibility-audit.md`, `docs/audits/2026-08-21-voiceover-test-script.md`
- Modify: `a11y/A11Y_BASELINE.json` (real finding ids)

**Interfaces:**
- Consumes: `A11Y_BASELINE.json`, and the console output collected in Tasks 4-10.

- [ ] **Step 1: Write the report generator**

Create `bin/a11y-report.mjs`:

```js
#!/usr/bin/env node
/**
 * Turns the baseline into the measured rows of the audit document.
 *
 * Deliberately NOT the whole document. Severity, who is affected, what the fix
 * is, and whether something was human-verified are judgements, and a generator
 * that emitted them would emit confident guesses. This writes the measured
 * columns and leaves the rest for a person, which is also what keeps the
 * evidence classes honest.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'a11y/A11Y_BASELINE.json'), 'utf8'));

const rows = [];
for (const [key, rules] of Object.entries(baseline)) {
  const [route, role] = key.split('::');
  for (const [rule, entry] of Object.entries(rules)) {
    rows.push({ finding: entry.finding, rule, route, role, count: entry.count });
  }
}
rows.sort((a, b) => a.finding.localeCompare(b.finding) || a.route.localeCompare(b.route));

const stale = rows.filter(r => r.finding === 'A-00');
if (stale.length) {
  console.error(`${stale.length} baseline row(s) still carry the placeholder finding id A-00.`);
  process.exit(1);
}

console.log('| Finding | axe rule | Route | Role | Instances |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(`| ${r.finding} | \`${r.rule}\` | \`${r.route}\` | ${r.role} | ${r.count} |`);
}
console.log('');
console.log(`${rows.length} accepted violation rows across ${new Set(rows.map(r => r.route)).size} routes.`);
```

- [ ] **Step 2: Assign real finding ids to every baseline entry**

Replace every `"finding": "A-00"` in `a11y/A11Y_BASELINE.json` with a sequential id (`A-01`, `A-02`, ...), grouping identical root causes under one id.

Run: `npx vitest run --project server a11y/harness/baseline.test.js && npm run a11y:report`

Expected: the table prints, and the generator exits 0 — meaning no `A-00` remains.

- [ ] **Step 3: Write the audit document**

Create `docs/audits/2026-08-21-accessibility-audit.md` with these eight sections, filled from the run output collected in Tasks 4-10:

1. **Scope and method** — what was swept (35 concrete routes plus 12 fixtured parameterised ones, times each distinct seeded role), which tool measured what, and the topology caveat from `playwright.config.js` (a dev bundle, not the shipped bundle, and why that is acceptable here).
2. **Evidence classes** — the four (`measured`, `inspected`, `human-verified`, `unverified`) and what each licenses you to claim.
3. **Findings table** — one row per finding: id, problem, WCAG criterion **with its level**, severity P0-P3, route/component, affected users, recommended fix, status, evidence class. Paste the generated table from Step 1 as the measured subset.
4. **Fixed in this workstream** — the two focus P0s (Task 5) and the location cluster (Task 9), each with its finding id and its guard.
5. **WCAG 2.2 A/AA mapping** — every criterion with its evidence class. Record explicitly: **3.3.8** clean (nothing cancels a paste event anywhere), **2.5.7** not applicable (no drag interactions exist), **4.1.1** obsolete in 2.2 and dropped, **1.3.5** partial (129 `<input>` elements, 30 with `autoComplete` — quantify the true shortfall against the criterion's defined purposes rather than reporting 99). **3.2.6 Consistent Help** and **3.3.7 Redundant Entry** are `unverified`: no scanner detects either, and both are new at Level A in 2.2.
6. **Known limitations** — Welly excluded from CI and why; the dev-bundle caveat; the harness runs Chromium only; no screen reader was run by the harness.
7. **Confidence assessment** — one honest grade. Do **not** claim ADA compliance; state that WCAG conformance is a technical target and that whether the ADA applies, and how, is a legal question for qualified advice.
8. **Recommended next steps** — the follow-up specs named as out of scope in the design: the preferences layer, the statement page, and P1-P3 remediation.

- [ ] **Step 4: Write the VoiceOver script**

Create `docs/audits/2026-08-21-voiceover-test-script.md`. A person executes it on macOS, so it must be unambiguous:

- **Setup:** start VoiceOver with Command-F5; use Safari; run `npm run dev`; sign in as the seeded student.
- **Notation:** write `VO` for Control-Option. Give the key names in words — "VO plus Right Arrow" to move to the next item, "VO plus Space" to activate, "VO plus U" for the rotor, "Control" to interrupt speech.
- **A table per journey**, three columns: *Action*, *Expected announcement*, *Result (pass / fail / notes)*. Cover: sign in; the skip link; rail navigation; discover an opportunity; apply a filter; open an event; sign up; the confirmation; the calendar (arrow keys, month change, a disabled date, the selected date); check-in; the notifications bell and its popover; a toast; a form error in Settings; the profile edit dialog (focus entering, Escape, focus restored).
- **A dedicated Welly section**, run with `VITE_LOCAL_AI=true`, asking specifically: does a streaming reply announce **once on completion**, or does it re-read the growing text on every chunk? Is the thinking state announced? Can you interrupt with Control and still read the final reply with the rotor? Does an engine error announce at all?
- **A toast-interruption section:** open a toast while reading a page; record whether it interrupts mid-sentence (assertive) or waits (polite), and whether that is the right choice for that message.
- **A closing "how to report back" section** giving the finding-id format, so results merge into the audit table.

- [ ] **Step 5: Commit**

```bash
git add bin/a11y-report.mjs docs/audits/2026-08-21-accessibility-audit.md docs/audits/2026-08-21-voiceover-test-script.md a11y/A11Y_BASELINE.json
git commit -m "Write the accessibility inventory, and the script for the half a machine cannot run"
```

Use this commit body:

```
Every row carries an evidence class — measured, inspected, human-verified,
unverified — because a criterion is not passing merely because axe did not flag
it, and the mapping records what nothing checked rather than omitting it. 3.2.6
Consistent Help and 3.3.7 Redundant Entry are unverified by construction: no
scanner detects either.

The generator emits only the measured columns, and refuses to run while any row
still carries the placeholder finding id. Severity, affected users and whether
something was human-verified are judgements, and a generator that emitted them
would emit confident guesses.

The VoiceOver script exists because the harness verifies what the browser
COMPUTES — names, roles, states, live-region wiring — and cannot hear verbosity,
interruption or announcement order. Welly's streaming and toast interruption are
the two cases where that gap is most likely to hide a real barrier, so they get
their own sections.
```

---

## Task 12: CI, and the documentation that keeps this alive

**Files:**
- Modify: `.github/workflows/ci.yml`, `docs/ENGINEERING_GUIDE.md`

- [ ] **Step 1: Add the job**

Append to `.github/workflows/ci.yml`, as a sibling of `validate`:

```yaml
  accessibility:
    runs-on: ubuntu-latest

    steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '24.x'
        cache: 'npm'

    - name: Install Dependencies
      run: npm ci

    # Chromium only. The other engines triple the download for coverage this
    # audit does not claim.
    - name: Install Chromium
      run: npx playwright install --with-deps chromium

    # WEV_DB_PATH is not a convenience here: the harness refuses to start
    # without it, because its default would be a real developer database.
    - name: Run the accessibility sweep
      env:
        NODE_ENV: development
        DATABASE_ENGINE: sqlite
        VITE_LOCAL_AI: 'false'
      run: |
        mkdir -p scratch
        WEV_DB_PATH="$PWD/scratch/a11y.db" npm run a11y -- --grep-invert @local

    - name: Upload the report on failure
      if: failure()
      uses: actions/upload-artifact@v4
      with:
        name: a11y-report
        path: |
          playwright-report/
          test-results/
        retention-days: 7
```

- [ ] **Step 2: Verify the job's command works exactly as written, locally**

Run: `rm -rf scratch && mkdir -p scratch && NODE_ENV=development DATABASE_ENGINE=sqlite VITE_LOCAL_AI=false WEV_DB_PATH="$PWD/scratch/a11y.db" npm run a11y -- --grep-invert @local`

Expected: PASS. This is the same command CI runs; if it only works with something extra in your shell, CI will fail.

- [ ] **Step 3: Document it**

Add an `## Accessibility` section to `docs/ENGINEERING_GUIDE.md` covering:

- **The target:** WCAG 2.2 Level AA, and the explicit statement that conformance is not a legal ADA compliance claim.
- **The two layers:** built into the application, never behind a setting, versus optional preferences (the follow-up spec).
- **What guards what:** the static guards under `src/` read source text and cannot see layout; the `a11y/` harness measures layout in a real browser. Name the reason — `getBoundingClientRect` is zero in jsdom — so nobody adds a layout assertion to a jsdom test again.
- **The ratchet rule:** `A11Y_BASELINE.json` counts may fall freely and rise only through a reviewed edit; every entry names an audit finding.
- **The safety rule:** `WEV_DB_PATH` absolute, under `scratch/`, and unset is a refusal. Say why: the default is a real developer database, and `pilot.db` holds real minors' data.
- **The env var traps:** `API_PORT` not `PORT` for the server; `VITE_LOCAL_AI` defaults to `true`.
- **Component requirements for new UI:** native element first; an accessible name always; a focus indicator never removed without a replacement that also survives `forced-colors`; no clickable non-interactive elements; no colour-only status.
- **How to run it:** `npm run a11y`, `npm run a11y:local`, `A11Y_UPDATE_BASELINE=1`, `npm run a11y:report`.

- [ ] **Step 4: Final full verification**

Run: `npm test && npm run lint && npm run build && npm run a11y -- --grep-invert @local`

Expected: all four PASS. Report the actual output. If anything fails, fix it — do not report completion.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml docs/ENGINEERING_GUIDE.md
git commit -m "Gate accessibility regressions in CI, and write down why the guards are split"
```

Use this commit body:

```
A separate job, not an addition to validate: a browser download must not be able
to break a pipeline that currently runs build, vitest and oxlint in minutes.
Chromium only — the other engines triple the download for coverage this audit
does not claim.

The engineering guide now records the split that is easy to get wrong. The static
guards under src/ read source text because getBoundingClientRect is zero in
jsdom, so a rendered assertion there is vacuous; layout is measured in a11y/
instead. Written down so nobody adds a geometry assertion to a jsdom test again.

Also written down: the ratchet is one-way and every accepted violation names the
finding that explains it, WEV_DB_PATH must be absolute and under scratch/ with
unset being a refusal, and the server reads API_PORT while Vite reads PORT.
```

---

## Self-Review

**Spec coverage.** Safety boundary → Task 1. Architecture and the derived inventory → Tasks 1-3. The nine check families → axe (4), accessible structure and heading tree (8), focus walk and 2.4.11 (6), target size (7), reflow (7), text spacing (7), forced-colors (5), reduced-motion (5) — eight files covering nine families, with target size and the house rule measured as separate tests inside Task 7. WCAG 2.2 corrections → Task 7 (2.5.8 versus 2.5.5) and Task 11 §5 (3.3.8, 2.5.7, 4.1.1, 1.3.5, 3.2.6, 3.3.7). The two P0s → Task 5. Location reclassification → Task 9. Deep workflows → Task 10. Welly `@local` → Task 10 Steps 10-12. Audit document, VoiceOver script, evidence classes → Task 11. CI and documentation → Task 12. Every out-of-scope item is absent from every task, as intended.

**Placeholder scan.** No `TBD`, no "add appropriate error handling", no "similar to Task N". Three places specify required content and assertions rather than literal code — Task 10 Steps 4/6/8 and Task 11 Steps 3/4 — because their content is the run's actual findings and the audit prose, neither of which can be written before the run. Every other code step contains real code.

**Type consistency.** `assertScratchDatabase({ tool })` — defined Task 1, called Tasks 1 and 2. `ROUTES` / `FIXTURES` — defined Task 3, consumed Tasks 4, 6, 7, 8. `fetchRoles(request, baseURL)` and `signInAs(browser, role, baseURL)` — defined Task 3, consumed Tasks 4-8 and 10. `scan(page)` / `tally(violations)` — Task 4. `load` / `save` / `compare` — defined Task 4, consumed Tasks 4 and 11. `walkFocus` / `interactiveRects` / `scrollsHorizontally` — defined Task 6, consumed Tasks 6 and 7. Baseline shape `{ "<route>::<role>": { "<rule>": { count, finding } } }` — written Task 4, read Tasks 4 and 11. Ports 5199 and 5198 — Task 2 only. Consistent throughout.
