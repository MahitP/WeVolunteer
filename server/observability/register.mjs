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
 * process, this application's own included. That rewrite turns a hoisted
 * function declaration into an assigned binding, which put `limitHandler` in the
 * temporal dead zone and killed the boot outright:
 *
 *     ReferenceError: Cannot access 'limitHandler' before initialization
 *         at server/checkinLimiters.js:149
 *
 * The cause was two circular imports — `checkinLimiters.js` and
 * `reportLimiter.js` both took `limitHandler` from `app.js`, which reaches them
 * again through its route imports. Those cycles have since been broken:
 * `limitHandler` lives in `rateLimitResponse.js` now, and the tree boots under
 * an unscoped rewrite (verified).
 *
 * ── So why is the allowlist still here ──
 *
 * Because it was never only a workaround. Three reasons outlast the bug:
 *
 *   · **Blast radius.** "Instrument express" does not need permission to rewrite
 *     the application's own modules, and a telemetry feature that can alter the
 *     semantics of `server/` is a telemetry feature that can break it. Scoped,
 *     this file cannot change the behaviour of any code in `server/` at all.
 *   · **The next cycle.** The two that existed were found by accident, by a boot
 *     crash. Nothing prevents a third being introduced, and the allowlist means
 *     the next one is an ordinary latent bug rather than a failed deploy.
 *   · **Cost.** Rewriting two packages is cheaper than rewriting every module in
 *     the process, on every boot.
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
