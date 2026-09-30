import { defineConfig } from 'vitest/config';

/**
 * The "week in the life" rehearsal — deliberately NOT part of `npm test`.
 *
 * `vitest.config.js` includes `*.test.js` only, so a `*.sim.js` file can never
 * run there by accident. It is slow (minutes, not seconds), it writes a whole
 * lived-in database, and its purpose is to exercise the product as a cohort of
 * people would over several days — a different question from the suite's.
 *
 *     npm run simulate:week
 *
 * One file at a time, one fork: the simulation moves the clock, and two of them
 * moving it at once would each be answering for the other's timeline.
 */
export default defineConfig({
  test: {
    include: ['server/simulation/**/*.sim.js'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
});
