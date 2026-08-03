import { REAUTH_CHALLENGE_HEADER } from '../../server/sensitiveActions.js';
import { SENSITIVE_ACTIONS } from '../../server/sensitiveActions.js';
import { api } from './api';

/**
 * The client half of step-up re-authentication.
 *
 * ── Why the wire names come from the server module ──
 *
 * `REAUTH_CHALLENGE_HEADER` and `SENSITIVE_ACTIONS` are imported from
 * `server/sensitiveActions.js`, exactly as `src/authz.js` imports the capability
 * table from `server/authz.js`, and for the same reason: two copies of a
 * protocol constant drift, and the direction they drift in is silent failure.
 *
 * A retyped header name is the worst case. The client presents its grant under a
 * spelling the server never looks for, every request resolves to AAL1, and every
 * sensitive action answers `reauth_required` — which sends the UI back to the
 * verification modal it has just come from, for ever, with no error anywhere.
 * That module imports nothing but `node:crypto`, so it is safe in the bundle, and
 * `server/sensitiveActions.test.js` fails the build on a second definition of the
 * literal.
 *
 * A retyped ACTION name is the same class of bug: an action the registry does not
 * know is refused at `/challenge` with 400 `unknown_action`, and one that is
 * merely the wrong action for the endpoint opens a grant that can never be spent.
 * Reading the names off the shared registry means a typo is a build-time
 * reference error rather than a runtime dead end.
 */

export { REAUTH_CHALLENGE_HEADER };

/**
 * The action names, read off the registry rather than written down again.
 *
 * Frozen so a caller cannot mutate the map other callers read from.
 */
export const STEP_UP = Object.freeze({
  ACCOUNT_DELETE: 'account.delete',
  PASSWORD_CHANGE: 'password.change',
  EMAIL_CHANGE: 'email.change',
  OAUTH_LINK: 'oauth.link',
  OAUTH_UNLINK: 'oauth.unlink',
  DATA_EXPORT: 'data.export',
  DATA_DOWNLOAD: 'data.download'
});

// Fails at module load, not at 403 time. A name that has drifted out of the
// registry cannot produce a grant, so every gated action would refuse every
// caller — and it would look like a server bug from the client side.
for (const [key, action] of Object.entries(STEP_UP)) {
  if (!Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, action)) {
    throw new Error(
      `stepUp: STEP_UP.${key} is '${action}', which is not in SENSITIVE_ACTIONS. `
      + `Known actions: ${Object.keys(SENSITIVE_ACTIONS).sort().join(', ')}.`
    );
  }
}

/** The header a request carries to spend a grant. */
export function reauthHeader(challengeId) {
  return challengeId ? { [REAUTH_CHALLENGE_HEADER]: challengeId } : {};
}

/* ── Surviving the provider round trip ─────────────────────────────────── */

/**
 * The provider leg leaves the site, so nothing in memory survives it.
 *
 * Both records live in `sessionStorage`, never `localStorage`, and the reason is
 * not tidiness. A grant is bound to ONE sign-in and expires in five minutes, so
 * it is worthless in another tab and worthless tomorrow — but a verification id
 * left in `localStorage` would still be sitting on a shared school Chromebook
 * after the student had walked away. `sessionStorage` is scoped to the tab and
 * cleared when it closes, which matches the lifetime of the thing it holds.
 *
 * PENDING is written before the redirect: which provider, which challenge, which
 * action, and where to return. READY is written after the callback grants it, so
 * the page the user comes back to can spend a verification they have already
 * completed rather than asking a second time for the same thing.
 */
const PENDING_KEY = 'wev_reauth_pending';
const READY_KEY = 'wev_reauth_ready';

function readJson(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || 'null');
  } catch {
    // A malformed record is indistinguishable from none, and throwing here would
    // take down whichever screen happened to read it.
    return null;
  }
}

export function savePendingReauth(record) {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(record));
}

/**
 * Reads AND clears the pending record.
 *
 * Clearing on read is deliberate: a callback that fails must not be retryable by
 * reloading the page, because each retry spends an attempt against the account's
 * ceiling with no deliberate user action behind it.
 */
export function takePendingReauth() {
  const record = readJson(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  return record;
}

export function saveReadyGrant({ action, challengeId, expiresAt }) {
  sessionStorage.setItem(READY_KEY, JSON.stringify({ action, challengeId, expiresAt }));
}

/**
 * A grant already earned for `action`, if there is one and it is still alive.
 *
 * Consumed on read, like the pending record: a grant is single-use server-side,
 * so keeping it after one attempt would only produce a `consumed` refusal that
 * looks like a bug. The expiry is checked with a small margin so the client does
 * not confidently spend something that will have died in transit.
 */
export function takeReadyGrant(action) {
  const ready = readJson(READY_KEY);
  if (!ready || ready.action !== action) return null;

  sessionStorage.removeItem(READY_KEY);

  const msLeft = new Date(ready.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(msLeft) || msLeft < 2000) return null;

  return ready.challengeId;
}

export function clearReadyGrant() {
  sessionStorage.removeItem(READY_KEY);
}

/** Everything step-up keeps in the tab. Called on sign-out. */
export function clearStepUpState() {
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(READY_KEY);
}

/**
 * Whether this failure means "prove who you are and try again".
 *
 * `requireAAL2` answers 403 with `code: 'reauth_required'` and names the action,
 * so a caller does not have to know in advance which of its requests are gated —
 * it can ask the error. Matching on the code rather than the status matters: a
 * 403 from a capability gate means "you may never do this", and offering to
 * verify would be a prompt that cannot succeed.
 */
export function needsStepUp(err) {
  return err?.status === 403 && err?.data?.code === 'reauth_required';
}

/** The action a `reauth_required` refusal is asking about, if it named one. */
export function actionFromError(err) {
  return needsStepUp(err) ? (err.data.action ?? null) : null;
}

/**
 * Opens a challenge and reports what this account can answer it with.
 *
 * `params` must carry exactly the keys the registry binds for the action — the
 * server re-derives the hash from the real request when the grant is spent, so a
 * key too many is ignored and a key too few will not match. Pass the value the
 * request will actually carry, unmodified: see the note on `email.change` in
 * `EmailCard`.
 */
export async function openChallenge(action, params = {}) {
  return api.openReauthChallenge(action, params);
}

/**
 * Runs `attempt` and, if the server asks for verification, verifies and retries.
 *
 * ── Why this exists rather than each caller doing it ──
 *
 * There are five gated actions and the sequence is identical for four of them:
 * try, catch `reauth_required`, open a challenge, show the modal, retry with the
 * header. Written out five times, the failure mode is the fifth one that forgets
 * the retry — a user who verifies successfully and is then shown the original
 * error, with the grant they just earned unspent.
 *
 * `attempt` takes the header object so that it goes on the ONE request that
 * needs it, rather than being attached to the client globally. A grant is bound
 * to one action; broadcasting it on every request would spend it on whichever
 * one happened to go first.
 *
 * The fifth action — `oauth.link` — cannot use this, and deliberately does not:
 * its grant is spent inside an OAuth callback that arrives mid-redirect, so the
 * verification has to happen BEFORE the request rather than in response to its
 * refusal. `ConnectedAccounts` calls `openChallenge` directly.
 *
 * ── Why the caller declares the action and params, rather than the error ──
 *
 * The refusal names its action, and it would be tidy to read it from there. But
 * it cannot name the PARAMS: `requireAAL2` runs before the handler and knows only
 * what it was configured with, while the binding has to describe the request that
 * is actually about to be made. Only the caller knows that. Taking the action from
 * the same place keeps the two together, so a caller cannot open a challenge for
 * one action bound to another's arguments.
 *
 * `action` is still checked against the error when the error named one, because a
 * mismatch means this helper is about to open a challenge the endpoint will not
 * accept — a loop, and one that presents as "verification does not work".
 *
 * @param {string} action - a value from STEP_UP
 * @param {object} params - exactly the keys the registry binds for `action`
 * @param {(headers: object) => Promise<any>} attempt
 * @param {(challenge: object) => Promise<string|null>} verify - resolves to a
 *   granted challenge id, or null if the user dismissed the dialog.
 */
export async function withStepUp(action, params, attempt, verify) {
  try {
    // A verification completed at a provider moments ago, on the other side of a
    // redirect. Spending it is the difference between "press the button again"
    // and "prove who you are again for the same thing you just proved".
    const ready = takeReadyGrant(action);
    if (ready) return await attempt(reauthHeader(ready));

    return await attempt({});
  } catch (err) {
    if (!needsStepUp(err)) throw err;

    const asked = actionFromError(err);
    if (asked && asked !== action) {
      throw new Error(
        `stepUp: asked to verify '${asked}' but the caller declared '${action}'. `
        + 'Opening a challenge for the wrong action produces a grant the endpoint '
        + 'will refuse, which reads to the user as verification being broken.'
      );
    }

    const challenge = await openChallenge(action, params);
    const challengeId = await verify(challenge);

    // Dismissed. Not an error: the user declined, and the caller should return
    // to what it was showing without a toast blaming them for it.
    if (!challengeId) return undefined;

    return attempt(reauthHeader(challengeId));
  }
}
