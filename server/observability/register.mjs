/**
 * Registers the OpenTelemetry ESM loader hook, before anything else is loaded.
 *
 * ── Why this cannot live inside the application ──
 *
 * MEASURED, and it is the whole reason this file exists. `otel.js` calls
 * `module.register()` itself, and against a DYNAMIC import that works. Against a
 * STATIC one it does not, and `server.js` uses a static import:
 *
 *     import './observability/bootstrap.js';   // registers the hook, eventually
 *     import { app } from './app.js';          // pulls in express
 *
 * ES modules are **loaded** graph-wide before any of them are **evaluated**. So
 * by the time `bootstrap.js`'s body runs and registers the hook, express's
 * source has already been read — and `import-in-the-middle` transforms source at
 * load time, so there is nothing left for it to transform.
 *
 * The symptom is not an error. It is one span per request named `GET` instead of
 * four named `GET /api/events/:id`, and it was found only by querying the real
 * Better Stack account and noticing that 31 of 31 automatic spans came from
 * `instrumentation-http` and none from `instrumentation-express`.
 *
 * `--import` runs this module before the main graph is loaded, which is early
 * enough. That is why `package.json` and the systemd unit pass it.
 *
 * ── The objection this file has to answer ──
 *
 * A load-bearing flag in two places is a flag a deployment can lose, and losing
 * it degrades silently — which is exactly the failure this repository keeps
 * warning about. The answer is not to avoid the flag; it is to make its absence
 * LOUD. The marker below is read by `otel.js`, which warns at boot when the hook
 * was not installed this way, so a missing flag is a line in the journal rather
 * than a quietly worse dashboard.
 */
import { register } from 'node:module';

/**
 * The packages the loader hook is allowed to touch — and it is an ALLOWLIST for
 * a reason that cost a broken boot to learn.
 *
 * ── What happened without it ──
 *
 * Registered unscoped, `import-in-the-middle` rewrites EVERY ES module in the
 * process, this application's own included. That rewrite changes how a module's
 * bindings are initialised, and `server/checkinLimiters.js` imports
 * `limitHandler` from `app.js` while `app.js` imports it back — a circular
 * import that works today only because of the exact order Node happens to
 * evaluate the two in. Rewritten, the order changes and the boot dies:
 *
 *     ReferenceError: Cannot access 'limitHandler' before initialization
 *
 * That is a latent fragility in the application rather than a bug in the hook,
 * and it is worth fixing on its own. But an observability feature must not be
 * able to stop the server from starting, and "instrument express" never needed
 * permission to rewrite the whole codebase.
 *
 * So the hook is scoped to the two packages there are instrumentations for.
 * Application modules are left exactly as Node would have loaded them, which
 * also means this file cannot change the behaviour of any code in `server/`.
 *
 * `pg` is listed even though SQLite is the engine in production: the
 * PostgreSQL migration is the direction of travel, and a package that is never
 * loaded costs nothing to allow.
 */
const INSTRUMENTED_PACKAGES = ['express', 'pg'];

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
  data: { include: INSTRUMENTED_PACKAGES },
});

/**
 * Proof, for the boot line, that the hook was installed EARLY rather than late.
 *
 * A Symbol on `globalThis` rather than an export, because nothing imports this
 * module — it is run by `--import` and its only effect is a side effect.
 */
globalThis[Symbol.for('wevolunteer.otel.esmHookPreloaded')] = true;
