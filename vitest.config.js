import { defineConfig } from 'vitest/config';

/**
 * Test isolation is load-bearing here, so it is declared rather than inherited.
 *
 * Several server suites set process-wide state before importing the app:
 * `testServer.js` assigns SBV_DB_PATH/DEMO_MODE/JWT_SECRET, and
 * routes.verification.test.js sets REQUIRE_EMAIL_VERIFICATION='true' while
 * routes.auth.test.js asserts the flag-OFF behaviour. Those two files can only
 * both be right if each gets a fresh module registry — db.js and config.js read
 * their environment once, at import time.
 *
 * This is NOT merely defensive. Setting `isolate: false` and running the suite
 * repeatedly fails every time, with a failure count that varies by test-file
 * scheduling order (observed 2, then 4, then 2 failures across three runs) —
 * module-level state such as the rate limiters' counters survives across files
 * that share a worker. `isolate: true` produces 241/241 on every run.
 *
 * So do not remove this pin to "simplify" the config: it is load-bearing today,
 * and without it CI becomes order-dependently flaky rather than obviously
 * broken, which is far harder to diagnose.
 */
export default defineConfig({
  test: {
    isolate: true
  }
});
