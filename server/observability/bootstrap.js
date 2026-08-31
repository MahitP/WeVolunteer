/**
 * Starts OpenTelemetry, as a side effect of being imported.
 *
 * ── Why a side-effect module rather than a call in `server.js` ──
 *
 * Instrumentation has to be installed before the modules it instruments are
 * loaded. In an ES module, every `import` in the file is evaluated before the
 * first statement runs — so `startOtel()` written as a statement in `server.js`
 * would run after `app.js`, and therefore after `express`, `http` and `pg` had
 * all already been imported. The patches would be installed onto nobody.
 *
 * Import order is the only ordering primitive available before the first
 * statement, so the call lives inside a module and `server.js` imports it in the
 * right place. `preflight.js` is in this file's position for the same reason and
 * says so at the top of `server.js`.
 *
 * Kept separate from `otel.js` so that `otel.js` stays a module a test can import
 * and drive without starting an SDK as a side effect of the import.
 */
import { startOtel } from './otel.js';

startOtel();
