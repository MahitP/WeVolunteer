/**
 * Checks that must run BEFORE any other module is evaluated.
 *
 * ── Why this module exists at all ──
 *
 * ES module imports are hoisted: every `import` in a file is resolved and its module
 * body executed before any statement in the importing file runs. So this does NOT
 * work, however it reads:
 *
 *     enforceNodeVersion();              // looks first
 *     import { app } from './app.js';    // actually ran first
 *
 * Verified rather than assumed — a two-file probe printed the dependency's module
 * body before a statement written above the import. `app.js` pulls in `config.js`
 * and `db.js`, and `db.js` opens the database and applies `PRAGMA journal_mode =
 * WAL` at import time. On an unsupported Node major that work would already have
 * happened against an experimental API before any check could speak.
 *
 * Importing THIS module first is the only ordering guarantee available, because
 * imports are evaluated in source order. Keep it first in server.js, and keep the
 * side effect here rather than in nodeVersion.js — that module stays pure so its
 * decision can be unit-tested without exiting the test runner.
 */
import { enforceNodeVersion } from './nodeVersion.js';

enforceNodeVersion();
