/**
 * The one shape every third-party integration answers in, and the one place
 * that decides what a failure is allowed to say.
 *
 * ── Why a shared vocabulary rather than each module's own ──
 *
 * The Owner Center draws four providers side by side and has to render each of
 * them in every state. If Better Stack says `{ error: 'unauthorized' }` and
 * Amplitude says `{ status: 401 }` and Upstash says `{ ok: false }`, the page
 * grows a translation layer per provider and the states drift: one shows a
 * "Retry" button for a bad credential (which will never help) and another shows
 * "Not configured" for a provider that is configured and simply down. Those are
 * different sentences to a person holding a pager, so they are different states
 * here.
 *
 * ── The rule about what a failure carries ──
 *
 * **A state, and nothing from the wire.** No response body, no request URL, no
 * header, no token, no upstream error text. A provider's 401 body has been
 * observed to echo back the credential prefix; a 500 body is arbitrary text
 * from somebody else's server, which would land in the Owner Center's DOM. So
 * failures are reduced to one of the words below, at the boundary, before
 * anything can carry a payload further in. `detail` exists for a SHORT string
 * this repository wrote itself (a plan restriction, say) and is never filled
 * from a response.
 *
 * That is the same decision `server/redis/status.js` makes for Redis and
 * `server/telemetry.js` makes for outbound logs — an allowlist owned by one
 * module, rather than assembled at each call site.
 */

/**
 * Every state a provider section can be in.
 *
 * `not_configured` is deliberately NOT a failure. Every one of these
 * integrations is optional and the pilot runs with most of them unset; a
 * dashboard that shows four red cards on a correctly configured deployment
 * teaches its reader to ignore red.
 *
 * `plan_restricted` is separated from `forbidden` because the remedies differ
 * and neither is "try again": one means the credential is wrong, the other
 * means this account's plan does not include the capability and the Owner
 * Center should stop asking. See `docs/operations/owner-center.md`.
 */
export const PROVIDER_STATES = Object.freeze([
  'ok',
  'not_configured',
  'unauthorized',
  'forbidden',
  'plan_restricted',
  'not_found',
  'rate_limited',
  'timeout',
  'unavailable',
  'bad_response',
]);

const STATE_SET = new Set(PROVIDER_STATES);

/** A successful read. `data` is whatever the caller's own allowlist produced. */
export function ok(data) {
  return { state: 'ok', ...data };
}

/**
 * A non-success, reduced to a word.
 *
 * @param {string} state one of PROVIDER_STATES
 * @param {string} [detail] a short sentence THIS REPOSITORY wrote. Never a
 *   response body, never an upstream message, never a URL.
 */
export function fail(state, detail) {
  if (!STATE_SET.has(state)) {
    /* A typo'd state renders as an unknown card rather than as the state
       intended, which is silent and looks like a provider problem. Throwing
       here surfaces it in the test suite instead. */
    throw new Error(`Unknown provider state '${state}'`);
  }
  return detail ? { state, detail } : { state };
}

/**
 * "Nothing is set up here", with the variables that would set it up.
 *
 * ── Why the variable names come from the SERVER ──
 *
 * They are the one genuinely useful thing to tell an owner looking at an empty
 * card, and they must not be written in the client. `server/redis.privacy.test.js`
 * asserts that no file under `src/` so much as mentions `UPSTASH_REDIS_REST` —
 * a guard that exists because a `VITE_`-prefixed Redis variable would compile a
 * write credential into the bundle, and the cheapest way to stop that is to keep
 * client source from naming those variables at all. Copy that hard-codes them is
 * one careless refactor away from being the thing the guard is looking for.
 *
 * So the provider module — which already reads the variables — says what they
 * are called, and the page renders whatever it is handed. A NAME is not a
 * credential; the value never leaves this process.
 */
export function notConfigured(configureWith, detail) {
  return { state: 'not_configured', ...(configureWith ? { configureWith } : {}), ...(detail ? { detail } : {}) };
}

/**
 * An HTTP status, classified. The response BODY is deliberately not a parameter:
 * there is no argument this function could make with it that is worth the risk
 * of it reaching a rendered page.
 *
 * 402 and 403 both appear for plan restrictions across these vendors, but 403
 * is far more often a scope problem on a real token, so only 402 is read as a
 * plan restriction here. A provider module that can tell the difference from a
 * documented error code says so itself.
 */
export function classifyStatus(status) {
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'plan_restricted';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}
