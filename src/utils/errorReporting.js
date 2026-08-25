/**
 * Tells the server about a client crash — and, mostly, decides not to.
 *
 * ── This module's job is restraint ──
 *
 * Sending an error is three lines. Everything else here exists because the
 * three-line version has four known ways of turning one bad afternoon into a
 * much worse one, and all four fire hardest exactly when the app is already
 * broken:
 *
 *   1. Reporting the reporter. The POST fails; that failure is an error; it is
 *      reported; it fails. Unbounded, at network speed, from every open tab.
 *   2. A render loop. React re-renders a throwing tree many times a second and
 *      each pass is a fresh `componentDidCatch`.
 *   3. Offline. A whole school's worth of buses lose signal in the same dead
 *      spot every afternoon. None of it is a defect and all of it would bury
 *      the defects.
 *   4. Throwing. A reporter that throws inside an error boundary converts a
 *      CAUGHT error into an uncaught one — breaking the recovery it was added
 *      to observe.
 *
 * The server has its own defences and they do not cover these. Its rate limiter
 * bounds one IP and does nothing about a thousand; its client-group ceiling
 * bounds rows and does nothing about request volume. Every one of the four
 * above originates on the client, so it has to be stopped on the client.
 *
 * ── Fire and forget, always ──
 *
 * Nothing here is awaited and nothing here can throw. The caller is an error
 * path; it has already failed once and must not be given a second way to fail.
 * The endpoint answers 202 to everything for the same reason.
 */

/**
 * Reports allowed per page load.
 *
 * Five is enough to see a cascade (a crash, the retry, the knock-on) and few
 * enough that a render loop cannot outrun it. Past this the client goes quiet:
 * the server already holds the fingerprint and the occurrence counter keeps
 * climbing there, so nothing is learned from the sixth copy that was not in the
 * first.
 */
export const MAX_REPORTS_PER_LOAD = 5;

const ENDPOINT = '/api/errors/report';

/* Module scope, so it is per page load — which is the unit the cap is defined
   in. A per-component counter would reset on the remount that the crash itself
   causes, which is precisely the loop being defended against. */
let sentThisLoad = 0;
let seen = new Set();

/**
 * True while a report is in flight.
 *
 * This is the loop breaker, and it is deliberately a plain boolean rather than
 * a queue: anything that fails DURING reporting is either the transport itself
 * or a consequence of it, and neither is worth the risk of describing. Held
 * across the synchronous call into `fetch` only — the promise is not awaited,
 * so this does not serialise reports, it just refuses re-entry.
 */
let reporting = false;

/**
 * The first stack frame, which is what makes two identical messages different
 * problems. Returns '' when there is no usable stack, so dedupe falls back to
 * the message alone rather than treating every stackless error as distinct.
 */
function firstFrame(stack) {
  if (typeof stack !== 'string') return '';
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('at ')) return trimmed;
  }
  return '';
}

/**
 * Whether this is worth telling anyone about.
 *
 * `isNetworkError` is the one exclusion, and it is a judgement about the READER
 * of the dashboard rather than about the user: a request that never reached a
 * server tells us nothing we can act on, and there will be thousands of them.
 * A 5xx is the opposite — it reached us and we failed.
 */
function worthReporting(error) {
  return !(error && error.isNetworkError === true);
}

/**
 * Report a client-side failure. Never throws, never awaits, never repeats.
 *
 * @param {unknown} error            whatever was thrown — not necessarily an Error
 * @param {object}  [meta]
 * @param {string}  [meta.kind]      'crash' | 'chunk' | …; the situation, not a status code
 * @param {string}  [meta.route]     the screen it happened on; normalised server-side
 */
/**
 * The server request id an error carries, if it came from a failed API call.
 *
 * Only `ApiError` has one, and only when the request reached this application.
 * Read defensively and shape-checked before it is sent: this runs on an error
 * path, and a value that is not a plain id is not worth a second failure.
 */
function requestIdOf(error) {
  try {
    const id = error?.requestId;
    return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

export function reportClientError(error, { kind, route } = {}) {
  try {
    if (!error) return;
    if (reporting) return;                       // (1) never report the reporter
    if (sentThisLoad >= MAX_REPORTS_PER_LOAD) return;  // (2) never outrun a render loop
    if (!worthReporting(error)) return;          // (3) never report the bus

    /* Read through getters that may themselves throw — a rejected value is not
       always an Error, and `error.message` is attacker-influenced in the sense
       that it can be any object at all. */
    const message = String(error.message ?? error);
    const stack = typeof error.stack === 'string' ? error.stack : undefined;

    const key = `${message}\0${firstFrame(stack)}`;
    if (seen.has(key)) return;
    seen.add(key);
    sentThisLoad += 1;

    reporting = true;
    try {
      /* `source`, `release`, `status`, `fingerprint` and `user_hash` are
         deliberately absent: the server assigns every one of them and ignores a
         client that sends them. A report claiming `source: 'server'` would
         otherwise escape the client-group ceiling entirely.

         `requestId` is the exception, and it is safe for the opposite reason:
         it is a value the SERVER minted and handed back on `X-Request-Id`, so a
         client echoing it can at worst point at a request that already exists.
         It is what joins this crash to the API call that caused it — see
         `requestIdOf` in api.js. Absent for a crash with no failed request
         behind it, which is most of them. */
      const body = JSON.stringify({ kind, message, stack, route, requestId: requestIdOf(error) });

      /* `.catch` rather than try/catch: the rejection arrives on a later tick,
         where a throw would be an unhandled rejection — which our own
         `unhandledrejection` listener would then try to report. The loop
         breaker has been released by then, so this is the one that would
         actually close the circle. */
      globalThis.fetch?.(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        credentials: 'include',
        /* This is diagnostics. It must never delay the page unloading, and it
           must never be the reason a navigation is held open. */
        keepalive: true,
      })?.catch(() => { /* (4) a failed report is not news. */ });
    } finally {
      reporting = false;
    }
  } catch {
    /* Nothing above is allowed to reach the caller: it is already handling a
       failure, and a second one here is how a caught error becomes a blank
       page. */
  }
}

/** Test seam: forget this load's cap and dedupe set. */
export function __resetReporter() {
  sentThisLoad = 0;
  seen = new Set();
  reporting = false;
}
