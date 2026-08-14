import * as amplitude from '@amplitude/unified';

/**
 * Amplitude, behind a seam.
 *
 * ── Why an abstraction at all ──
 *
 * So that `amplitude.track(...)` appears in exactly one file. The alternative —
 * the SDK imported directly wherever somebody wants an event — makes the
 * privacy question unanswerable: you can no longer read one module and say what
 * this application sends. On a platform whose users are minors that is the
 * whole ballgame, and it is much easier to keep than to recover.
 *
 * It is deliberately small. Two functions, no queue, no wrapper types, no
 * event registry. There is one event today.
 *
 * ── Sits beside errorReporting.js on purpose ──
 *
 * That module is this application's other outbound telemetry, and it already
 * settled the questions this one has to answer: never throw into the caller,
 * cap what leaves, and stay silent when unconfigured. Same directory, same
 * contract.
 */

/**
 * The ingestion key.
 *
 * Public by design — it is compiled into the bundle and visible to anybody who
 * opens the network tab, which is true of every client-side analytics key. It
 * is in an environment variable anyway, because this repository keeps
 * development, staging and production configuration separate, and a key baked
 * into tracked source is the same key in all three.
 *
 * `import.meta.env` is inlined by Vite at BUILD time. A variable that is unset
 * when the bundle is built is not a runtime lookup that fails later — it is the
 * literal `undefined` in the shipped file. That is why the guard below warns
 * rather than silently doing nothing: a deploy that forgot the variable looks
 * identical to a deploy with analytics deliberately switched off.
 */
const API_KEY = import.meta.env.VITE_AMPLITUDE_API_KEY;

/**
 * One initialization, ever.
 *
 * `main.jsx` renders inside `<StrictMode>`, which in development mounts every
 * component twice on purpose. Anything that initialises from an effect runs
 * twice, and this module is imported by more than one place over the life of
 * the bundle. A module-scope flag is what makes "exactly once" a property of
 * the module rather than of who happens to call it.
 */
let started = false;

/** Whether analytics is configured at all. Also the test seam's read. */
export const isAnalyticsConfigured = () => Boolean(API_KEY);

/**
 * Which build this is, sent as an ordinary event property.
 *
 * `import.meta.env.MODE` is Vite's own value — `development` under `npm run
 * dev`, `production` under `npm run build`. It is a plain string on the event,
 * not an Amplitude configuration option, because inventing an SDK option that
 * does not exist is how an installation silently stops reporting.
 *
 * This is a MARKER, not isolation. Two environments writing to one Amplitude
 * project still share a dataset, and a chart that forgets to filter counts
 * developer clicks as student activity. Real separation is a separate Amplitude
 * project per environment — a different `VITE_AMPLITUDE_API_KEY` per `.env` —
 * which is recorded as a production decision rather than assumed here.
 */
const environment = import.meta.env.MODE;

/**
 * Starts Amplitude, once, in the browser.
 *
 * Never throws. An analytics SDK that can break the page it measures is worse
 * than no analytics: WeVolunteer has to keep working when Amplitude is
 * unreachable, blocked by an extension, or refused by a Content Security
 * Policy — all three of which are ordinary, not exceptional.
 *
 * @returns {boolean} whether Amplitude is running after this call
 */
export function initializeAmplitude() {
  if (started) return true;

  /* Browser only. This module is imported by tests running under Node and must
     not reach for `window` there — and the server never imports it at all. */
  if (typeof window === 'undefined') return false;

  if (!API_KEY) {
    console.warn('Amplitude API key missing — analytics disabled');
    return false;
  }

  try {
    /* `initAll`, not `init`. They are different entry points: `init` is
       analytics only and does not start Session Replay. This package does not
       even export `init`, so the mistake would be a runtime TypeError rather
       than a quiet half-installation. */
    amplitude.initAll(API_KEY, {
      analytics: { autocapture: true },
      sessionReplay: { sampleRate: 1 },
    });
    started = true;
    return true;
  } catch (err) {
    /* Swallowed deliberately, and logged so it is not invisible. */
    console.warn('Amplitude failed to initialize — analytics disabled:', err?.message);
    return false;
  }
}

/**
 * Records one event.
 *
 * A no-op when Amplitude is not configured or did not start, so a caller never
 * has to ask. Properties are the caller's business, with one rule this module
 * enforces by convention and the review enforces by reading: nothing
 * identifying a person goes in them. No names, no addresses, no school, no
 * year group, no tokens, no free text a user typed.
 *
 * @param {string} name  Title Case, past tense
 * @param {object} [properties]
 */
export function trackAmplitudeEvent(name, properties = {}) {
  if (!started) return;
  try {
    amplitude.track(name, { ...properties, environment });
  } catch (err) {
    /* An event that cannot be sent must never reach the caller as an
       exception. The caller is a render path or a click handler. */
    console.warn('Amplitude event could not be recorded:', err?.message);
  }
}

/** Test seam. Lets a suite assert the once-only behaviour from a clean slate. */
export function __resetAnalyticsForTests() {
  started = false;
}
