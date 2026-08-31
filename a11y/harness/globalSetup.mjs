import { assertScratchDatabase } from './guard.mjs';

/**
 * The gate again, for the `npx playwright test` path.
 *
 * bin/a11y-audit.mjs is the supported entry point and gates first, but nothing
 * stops somebody running Playwright directly — an IDE's run button does exactly
 * that. The webServer block starts the API server with whatever WEV_DB_PATH is
 * in the environment, so without this the direct path is the unguarded one.
 *
 * One implementation, two call sites. The guard exits the process on refusal, so
 * a failure here stops the run before a browser or a server is started.
 */
export default function globalSetup() {
  assertScratchDatabase({ tool: 'The accessibility audit' });
}
