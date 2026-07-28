import { defineConfig, configDefaults } from 'vitest/config';

/**
 * `scratch/` holds throwaway full copies of the project made during
 * deployment checks. Vitest walks the filesystem rather than git, so
 * .gitignore does not keep it out: those copies contribute their own
 * `server/*.test.js` files and turn a passing run into a failing one
 * against code that is not part of the repository.
 *
 * Measured when this was first hit: dropping the exclusion turned a passing
 * run of 25 files / 256 tests into 73 files / 36 failures.
 *
 * The defaults are spread back in rather than replaced — omitting them
 * would re-enable scanning of node_modules and dist.
 *
 * Shared by both projects below, and not optional in either: `scratch/`
 * currently holds 101 test files, so dropping it from one project
 * reintroduces the failure immediately and visibly.
 */
const EXCLUDE = [...configDefaults.exclude, '**/scratch/**'];

/**
 * Test isolation is load-bearing here, so it is declared rather than inherited.
 *
 * Several server suites set process-wide state before importing the app:
 * `testServer.js` assigns WEV_DB_PATH/DEMO_MODE/JWT_SECRET, and
 * routes.verification.test.js sets REQUIRE_EMAIL_VERIFICATION='true' while
 * routes.auth.test.js asserts the flag-OFF behaviour. Those two files can only
 * both be right if each gets a fresh module registry — db.js and config.js read
 * their environment once, at import time.
 *
 * This is NOT merely defensive. Setting `isolate: false` and running the suite
 * repeatedly fails every time, with a failure count that varies by test-file
 * scheduling order (observed 2, then 4, then 2 failures across three runs) —
 * module-level state such as the rate limiters' counters survives across files
 * that share a worker. Pinned, the suite is green on every run.
 *
 * So do not remove this pin to "simplify" the config: it is load-bearing today,
 * and without it CI becomes order-dependently flaky rather than obviously
 * broken, which is far harder to diagnose.
 */
export default defineConfig({
  test: {
    /**
     * Environment is per-directory, not global.
     *
     * The server suites talk to node:sqlite, bind a real port, and read
     * process.env — they must keep running under `node`. Only the client
     * suites need a DOM. Setting `environment: 'jsdom'` globally would put
     * every server test inside a fake browser, where `fetch` against
     * 127.0.0.1 and DatabaseSync behave differently than in production and
     * failures would be blamed on the code rather than the harness.
     */
    projects: [
      {
        test: {
          name: 'client',
          include: ['src/**/*.test.{js,jsx}'],
          exclude: EXCLUDE,
          environment: 'jsdom',
          // Only the client project loads this; server suites never import
          // @testing-library and must not pay for it.
          setupFiles: ['./src/setupTests.js'],
          isolate: true
        }
      },
      {
        test: {
          name: 'server',
          include: ['server/**/*.test.js'],
          exclude: EXCLUDE,
          environment: 'node',
          isolate: true
        }
      }
    ]
  }
});
