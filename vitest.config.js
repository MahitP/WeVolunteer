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
          /* Reclaims the throwaway temp directories a dozen server suites leave
             behind. See server/testTempCleanup.js for why this is one global hook
             with an age threshold rather than 55 afterAll blocks. */
          globalSetup: ['./server/testTempCleanup.js'],
          include: ['server/**/*.test.js', 'a11y/**/*.test.js'],
          exclude: EXCLUDE,
          environment: 'node',
          isolate: true,
          /**
           * Fifteen seconds, on the SERVER project only.
           *
           * Vitest's default is five, which is ample for a unit test and not
           * ample for this suite. A server test boots the real application
           * against a throwaway SQLite file, and the authentication paths hash
           * with bcrypt at cost 10 — enrolment alone hashes ten recovery codes
           * before it verifies anything, and a recovery sign-in compares against
           * the whole set. One of those takes well under a second on an idle
           * machine and several seconds when the whole worker pool is busy.
           *
           * The symptom was a suite that failed differently on every run: one to
           * three files, never the same ones, every failure `Test timed out in
           * 5000ms`, and every one of them passing in isolation. That is a
           * measurement artefact reported as a defect, and the cost is worse
           * than the noise — a suite that cries wolf is one people stop reading.
           *
           * Raised rather than removed, and raised only here. A genuine hang
           * still fails, fifteen seconds is still far below anything a correct
           * test needs, and the client project keeps the default because jsdom
           * tests do no such work and a slow one there is a real finding.
           *
           * This is not a licence to write slow tests. A case that needs longer
           * than this should say so at the call site, as several already do.
           */
          testTimeout: 15_000,

          /**
           * Hooks get longer than tests, because they do strictly more.
           *
           * `hookTimeout` was left at its 10-second default while `testTimeout`
           * was raised, which made `beforeAll` the tightest budget in the suite
           * despite being the part that boots a server, applies a schema and
           * seeds it.
           *
           * On PostgreSQL that gap became a wrong answer rather than a slow one.
           * Every file gets its own schema namespace, so `startTestServer()`
           * creates ~65 tables and ~95 indexes before the first test runs, and a
           * fixture's inserts are round-trips instead of function calls. Five
           * files tipped over ten seconds — and vitest reports EVERY test in a
           * file whose suite hook failed as *skipped*, so 76 tests silently
           * stopped running and the failure count improved while coverage got
           * worse. That is the most misleading shape a suite can take, and it is
           * the same cascade this migration has now hit three times.
           *
           * Thirty seconds is still far below anything a correct hook needs; a
           * genuine hang in setup still fails the file.
           */
          hookTimeout: 30_000
        }
      }
    ]
  }
});
