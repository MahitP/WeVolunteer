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

/**
 * The SDK itself, once somebody has consented — and not before.
 *
 * ── Why this is a dynamic import ──
 *
 * `import * as amplitude from '@amplitude/unified'` is a static import, so the
 * whole package was compiled into the main bundle and every visitor downloaded
 * it whether or not it ever ran. Measured on a production build: `rrweb-record`
 * 180 kB and `rrweb-plugin-console-record` 124 kB as separate chunks, plus the
 * analytics core inside an 841 kB main chunk that Vite already warns about.
 *
 * That was defensible when analytics was on for everyone. It stopped being
 * defensible the moment it became opt-in and OFF by default: the common case is
 * now a student who never consents, and charging them ~300 kB on school
 * cellular for a recorder that will never start is the wrong trade.
 *
 * `await import()` moves the whole package into a chunk fetched at the moment
 * consent is granted. Nobody who declines pays for it, and nobody signed out
 * pays for it either.
 *
 * The cost is that everything here becomes async, which is why
 * `applyAnalyticsConsent` returns a promise and the caller is an effect rather
 * than a module-scope call. That is a fair price and it matches what the code
 * already had to be once the answer lived on an account.
 */
let sdk = null;

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
 * The attribute that removes a subtree from the recording entirely.
 *
 * Not a class, because a class is a styling hook and somebody will eventually
 * refactor one away without knowing it was load-bearing. An attribute that
 * exists for one reason and has that reason in its name survives a redesign.
 *
 * `blockSelector` is stronger than masking: rrweb replaces the element with an
 * empty placeholder and records nothing inside it — no text, no attributes, no
 * child nodes. Masking only replaces visible characters.
 */
export const REPLAY_BLOCK_ATTRIBUTE = 'data-replay-block';

/**
 * URLs whose query string carries a live credential, rewritten before the
 * recorder stores them.
 *
 * ── Why this is necessary at all ──
 *
 * `server/email.js` builds `?verify=<token>` and `?reset=<token>`, and
 * `App.jsx` forwards the latter to `/reset-password?token=<token>`. Those are
 * single-use credentials sitting in `location.href`, and Session Replay records
 * `location.href` on the initial snapshot, on every URL change, and on click
 * and scroll events.
 *
 * This application already decided that these must not be written down:
 * `server/app.js` strips query strings from the access log and
 * `server/errorReporter.js` normalises the route before storing it, both with
 * these exact URLs named in the comment. A recorder that captures them anyway
 * would quietly undo a decision taken twice elsewhere.
 *
 * ── Why the shape is what it is ──
 *
 * The rules are matched against the FULL href (`getPageUrl(location.href, …)`),
 * and `validateUGCFilterRules` rejects any pattern that does not begin with `/`
 * or `http`. So each rule is written twice, once per scheme — `http` is not
 * only development, it is also what a misconfigured proxy would produce, and a
 * rule that silently fails to match is the worst outcome here.
 *
 * `*` becomes `.*` and the whole pattern is anchored, so `https://*?reset=*`
 * matches any host and any token. Verified against the installed SDK rather
 * than assumed: the glob compiler turns `?` into a single-character wildcard,
 * which still matches the literal `?` that separates the query string.
 *
 * An invalid rule makes the SDK THROW, which `initializeAmplitude` would then
 * swallow — turning a typo here into silently disabled analytics rather than a
 * visible failure. That is why these are pinned by a test.
 */
export const REDACTED_URL_RULES = Object.freeze([
  { selector: 'https://*?reset=*', replacement: 'https://[redacted]/?reset=[redacted]' },
  { selector: 'http://*?reset=*', replacement: 'http://[redacted]/?reset=[redacted]' },
  { selector: 'https://*?verify=*', replacement: 'https://[redacted]/?verify=[redacted]' },
  { selector: 'http://*?verify=*', replacement: 'http://[redacted]/?verify=[redacted]' },
  { selector: 'https://*?token=*', replacement: 'https://[redacted]/?token=[redacted]' },
  { selector: 'http://*?token=*', replacement: 'http://[redacted]/?token=[redacted]' },
  /* `/appeal/:token` puts the credential in a path segment rather than a query
     string, so the rules above cannot see it. */
  { selector: 'https://*/appeal/*', replacement: 'https://[redacted]/appeal/[redacted]' },
  { selector: 'http://*/appeal/*', replacement: 'http://[redacted]/appeal/[redacted]' },
]);

/**
 * What Session Replay is allowed to record.
 *
 * ── The default was wrong for this application ──
 *
 * Amplitude's `DEFAULT_MASK_LEVEL` is `medium`, which the SDK's own source
 * documents as: "All inputs (form fields), text is NOT masked". That is a
 * reasonable default for a product whose sensitive data is typed into forms.
 * It is the wrong default here, because WeVolunteer's sensitive data is
 * RENDERED, not typed: service hours, transcripts, certificates, message
 * threads, the admin roster, moderation notes, ban reasons, appeal text — and,
 * most sharply, the two-factor secret and the recovery codes, which are a
 * `<code>` element and a list of `<li>`s.
 *
 * `conservative` masks all inputs AND all text. It is the only level under
 * which "a screen nobody remembered to annotate" fails closed.
 *
 * ── Why the block selector is not merely belt-and-braces ──
 *
 * Masking replaces visible CHARACTERS. The enrolment QR code is an `<img>`
 * whose `src` is a data URL encoding the `otpauth://` URI — which contains the
 * shared secret. No mask level touches an image's `src` attribute, so the
 * secret would still leave the browser with `conservative` set. Blocking the
 * subtree is what actually removes it.
 *
 * It also keeps the protection on the 2FA screen independent of the global
 * level, so relaxing that level later for product reasons cannot silently
 * re-expose the one screen that must never be recorded.
 */
const PRIVACY_CONFIG = {
  defaultMaskLevel: 'conservative',
  blockSelector: [`[${REPLAY_BLOCK_ATTRIBUTE}]`],
};

/**
 * Interaction tracking, switched on for one specific reason.
 *
 * `ugcFilterRules` live under `interactionConfig`, and the SDK applies them to
 * the recorded `href` only when `enabled` is true — `session-replay.js` reads
 * `interactionConfig?.enabled && interactionConfig.ugcFilterRules ? … : []`.
 * With it left off, the URL-tracking plugin still redacts navigations but the
 * INITIAL snapshot's href is stored raw, and the initial href is precisely the
 * one that carries the token, because it is the link out of the email.
 *
 * So this is not a decision to collect more; it is the switch that makes the
 * redaction apply to the one URL that matters. `batch` is the SDK's own
 * batching path for click events and is the cheaper of the two.
 */
const INTERACTION_CONFIG = {
  enabled: true,
  batch: true,
  ugcFilterRules: [...REDACTED_URL_RULES],
};

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
export async function initializeAmplitude() {
  if (started) return true;

  /* Browser only. This module is imported by tests running under Node and must
     not reach for `window` there — and the server never imports it at all. */
  if (typeof window === 'undefined') return false;

  if (!API_KEY) {
    console.warn('Amplitude API key missing — analytics disabled');
    return false;
  }

  try {
    /* Fetched here, not at page load. See `sdk` above. A failure to load — an
       offline network, a blocking extension, a CSP — lands in the same catch as
       a failure to initialise, and is handled the same way: silently, with the
       application unaffected. */
    sdk = await import('@amplitude/unified');

    /* `initAll`, not `init`. They are different entry points: `init` is
       analytics only and does not start Session Replay. This package does not
       even export `init`, so the mistake would be a runtime TypeError rather
       than a quiet half-installation. */
    sdk.initAll(API_KEY, {
      analytics: { autocapture: true },
      sessionReplay: {
        sampleRate: 1,
        privacyConfig: PRIVACY_CONFIG,
        interactionConfig: INTERACTION_CONFIG,
      },
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
 * Turns analytics on or off to match what this person actually agreed to.
 *
 * ── Why initialisation moved out of `main.jsx` ──
 *
 * It used to run at module scope, before React mounted anything. That is the
 * right place for something unconditional and the wrong place for something
 * conditional: the answer lives on the account, and at module scope there is no
 * account yet. So the call now happens once the session is known, which means
 * a signed-out visitor is never measured — correct, because nobody who has not
 * signed in has been asked.
 *
 * ── Why revocation uses `setOptOut` rather than doing nothing ──
 *
 * Amplitude cannot be un-initialised. Somebody who turns the switch off in
 * Settings expects recording to stop in the tab they are sitting in, not at the
 * next reload — and Session Replay is capturing continuously, so "next reload"
 * could be an hour of recording they withdrew consent for. `setOptOut(true)`
 * is the SDK's own answer and it takes effect immediately.
 *
 * Idempotent and safe to call on every session change, which is how it is used.
 *
 * @param {boolean} consented `true` only for an explicit yes. `null` — meaning
 *   the person has not been asked — is not consent.
 * @returns {boolean} whether analytics is running after this call
 */
export async function applyAnalyticsConsent(consented) {
  if (consented !== true) {
    if (started && sdk) {
      try {
        sdk.setOptOut(true);
      } catch (err) {
        console.warn('Amplitude could not be switched off:', err?.message);
      }
    }
    return false;
  }

  if (!started) return initializeAmplitude();

  /* Consent given back after being withdrawn, in the same tab. */
  try {
    sdk.setOptOut(false);
  } catch (err) {
    console.warn('Amplitude could not be switched on:', err?.message);
    return false;
  }
  return true;
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
  if (!started || !sdk) return;
  try {
    sdk.track(name, { ...properties, environment });
  } catch (err) {
    /* An event that cannot be sent must never reach the caller as an
       exception. The caller is a render path or a click handler. */
    console.warn('Amplitude event could not be recorded:', err?.message);
  }
}

/** Test seam. Lets a suite assert the once-only behaviour from a clean slate. */
export function __resetAnalyticsForTests() {
  started = false;
  sdk = null;
}
