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
 * Note the suite currently passes with `isolate: false` too, because the
 * default worker pool already runs each file in its own process, which supplies
 * a fresh registry by itself. So this pin is defence in depth, not a fix for a
 * present failure: it states the requirement explicitly so that a future change
 * to the pool, or a major-version flip of the default, cannot quietly let these
 * suites contaminate each other — a failure that would surface as confusing
 * order-dependent flakiness rather than an obvious error.
 */
export default defineConfig({
  test: {
    isolate: true
  }
});
