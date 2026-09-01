import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * ── Why this runs the DEVELOPMENT topology ──
 *
 * Serving a production build looks like the more faithful choice and is wrong
 * twice. vite.config.js configures a proxy under `server` and has no `preview`
 * block at all, so `vite preview` would serve the SPA with /api unproxied and
 * every request would land on the SPA fallback. And server/app.js serves
 * ../dist and its SPA fallback only inside `if (IS_PRODUCTION)` — so serving the
 * built client means turning production mode on, which also turns on secure
 * cookies. Playwright drives http://127.0.0.1, secure cookies are not sent over
 * http, and sign-in would fail for every role as what looks like an
 * authentication bug rather than a configuration one. server/db.js additionally
 * FATALs on a relative WEV_DB_PATH in production.
 *
 * The trade is that a dev bundle is not the shipped bundle. Chunking,
 * minification and asset hashing differ, and none of them affect the DOM, the
 * accessible tree, the CSS cascade, or layout — which is the entire subject of
 * this audit. What a dev build cannot catch is a defect introduced BY the
 * production build itself; that is recorded as a known limitation rather than
 * papered over.
 *
 * ── Ports ──
 *
 * 5199/5198 rather than the defaults 5050/5173, so a developer's own dev server
 * keeps running while the harness does. vite.config.js:79 honours PORT for
 * exactly this ("lets the dev harness assign a free port"); the API server reads
 * API_PORT and never PORT, which is the trap docs/ENGINEERING_GUIDE.md records.
 */
const API_PORT = 5199;
const WEB_PORT = 5198;
const ROOT = import.meta.dirname;

/**
 * Passed to both servers.
 *
 * WEV_DB_PATH is already in the environment by the time this is read — both
 * globalSetup and bin/a11y-audit.mjs assert it — and an explicitly exported
 * variable beats --env-file-if-exists on Node 24 (verified empirically), so
 * .env's `WEV_DB_PATH=../pilot.db` cannot win. The webServer commands below also
 * run plain `node server.js` with no --env-file flag at all, so .env is never
 * read on this path.
 */
const shared = {
  NODE_ENV: 'development',
  DATABASE_ENGINE: 'sqlite',
  WEV_DB_PATH: process.env.WEV_DB_PATH,
  JWT_SECRET: process.env.JWT_SECRET
    || 'a11y-harness-development-secret-not-for-any-real-deployment'
};

export default defineConfig({
  testDir: './a11y',
  /**
   * `*.spec.js` is Playwright's; `*.test.js` is Vitest's.
   *
   * Two runners share the `a11y/` directory: the harness's own guards
   * (`harness/guard.test.js`, `harness/routes.test.js`, `harness/baseline.test.js`)
   * are Vitest tests, registered in vitest.config.js's server project because
   * they spawn processes and read the filesystem and need no browser at all.
   *
   * Without this, Playwright collected them too and the whole run failed at
   * collection with "Cannot read properties of undefined (reading 'config')" —
   * Vitest's `describe` is not Playwright's. It failed only when running the
   * FULL suite, not any single spec, which is exactly the shape of defect that
   * reaches CI and nowhere else.
   */
  testMatch: /.*\.spec\.js$/,
  globalSetup: './a11y/harness/globalSetup.mjs',
  /* Serial. The suites share one database, and two specs signing in or mutating
     state concurrently produce failures that read as accessibility defects. */
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'test-results/a11y.json' }]]
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
      env: {
        ...shared,
        API_PORT: String(API_PORT),
        BIND_ADDRESS: '127.0.0.1',
        DEMO_MODE: 'true',
        /**
         * Named explicitly because this `env` is an allowlist, not a spread of
         * `process.env` — a variable not listed here does not reach the server.
         *
         * Forwarded rather than hardcoded to `'1'`, so it is on only when
         * `bin/a11y-audit.mjs` set it. Running `npx playwright test` directly
         * gets the ordinary volume limiter, which is the honest default: the
         * exemption belongs to the audited run, not to the config file. See
         * A11Y_HARNESS in server/config.js for what it does and does not
         * exempt.
         */
        WEV_A11Y_HARNESS: process.env.WEV_A11Y_HARNESS ?? ''
      }
    },
    {
      /* --host 127.0.0.1 is not optional. Without it Vite binds [::1] only —
         IPv6 — while the url below and baseURL are both 127.0.0.1, so
         Playwright's readiness poll never connects and the run stalls until the
         timeout with both servers visibly up and no test ever starting. Binding
         explicitly makes the listener, the health check and baseURL agree. */
      command: `npx vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
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
        /* Defaults to 'true' in vite.config.js. Left on, Welly would download a
           model into every page load of every route in the sweep. */
        VITE_LOCAL_AI: 'false'
      }
    }
  ]
});
