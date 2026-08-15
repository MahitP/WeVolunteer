import { useEffect, useRef } from 'react';
import { applyAnalyticsConsent, trackAmplitudeEvent } from '../utils/analytics.js';

/**
 * Keeps Amplitude in step with what this person agreed to.
 *
 * ── Why this is a hook and not a line in `main.jsx` ──
 *
 * Analytics used to start at module scope, before React mounted. That is right
 * for something unconditional and wrong for something that depends on an
 * answer stored against an account: at module scope there is no account. So the
 * decision has to happen where the session is, and it has to happen AGAIN
 * whenever the session changes — a person signing out, a different person
 * signing in on a shared library machine, or the switch being turned off in
 * Settings two seconds ago.
 *
 * ── The three states, and why `null` is not a no ──
 *
 * `analyticsConsent` is `true`, `false`, or `null` for "never asked". Only
 * `true` starts anything. `null` and `false` behave identically here — both
 * collect nothing — and they are kept distinct because Settings renders them
 * differently and because re-prompting somebody who already declined is the
 * behaviour a consent control exists to prevent.
 *
 * ── Signed out ──
 *
 * `user` is null, so `undefined !== true`, so nothing runs. A visitor who has
 * not signed in is never measured, which is the only defensible reading of
 * consent: they have not been asked.
 */
export function useAnalyticsConsent(user) {
  const consented = user?.analyticsConsent === true;

  /**
   * The one explicit event, fired at most once per page load.
   *
   * A ref rather than module state because the thing being guarded is "this
   * mounted tree has already sent it". `<StrictMode>` mounts twice in
   * development and this effect's dependency can legitimately change more than
   * once in a session (sign out, sign back in), neither of which should produce
   * a second copy of the same landing event.
   */
  const sent = useRef(false);

  useEffect(() => {
    /* Async because the SDK is fetched on demand — see `sdk` in analytics.js.
       `cancelled` rather than an AbortController: there is nothing to abort, and
       the only thing that must not happen is sending an event for a session that
       has already been replaced. */
    let cancelled = false;

    applyAnalyticsConsent(consented).then((running) => {
      if (cancelled || !running || sent.current) return;

    /**
     * `Viewed Home Page` — the installation's verification marker.
     *
     * Gated on the path for the reason it always was: an event with that name
     * firing on `/settings` is a lie in the dataset. What HAS changed is when
     * the check happens. It used to run at module scope, on a page load, before
     * anyone was known; it now runs the moment analytics is switched on, which
     * for a consenting signed-in user is the first render after their session
     * resolves.
     *
     * The practical consequence is worth stating plainly: a signed-out visitor
     * on the landing page has given no consent, so this event no longer fires
     * for them at all. It fires for a consenting member who arrives at `/`.
     */
      const path = window.location?.pathname;
      if (path === '/' || path === '/welcome') {
        trackAmplitudeEvent('Viewed Home Page', { prompt_version: 'BA400.4' });
        sent.current = true;
      }
    });

    return () => { cancelled = true; };
  }, [consented]);
}

export default useAnalyticsConsent;
