import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

const LocationContext = createContext(null);

/**
 * Three different states, which used to be one.
 *
 * ── The bug ──
 *
 * This asked `sessionStorage.getItem('wv_asked_location')` and treated the
 * answer as "does the browser have permission?". Those coincide only inside a
 * single tab's lifetime. `sessionStorage` is per top-level browsing context, so
 * every new tab, every new window and every browser restart started empty — and
 * the banner was shown again to somebody whose browser had already granted
 * permission permanently, for whom `getCurrentPosition` would resolve instantly
 * with no dialog at all. That is the "it asks me every single time" complaint.
 *
 * ── The three states, kept apart ──
 *
 *   BROWSER PERMISSION — granted / denied / prompt. Owned by the browser,
 *     survives everything, and is the only authority on whether asking will
 *     even produce a dialog. Read through the Permissions API.
 *
 *   BANNER DISMISSAL — "not now". A courtesy, remembered for this session only,
 *     because a permanent dismissal would leave somebody who changed their mind
 *     with no way back to the affordance.
 *
 *   POSITION — the coordinates themselves, held in memory for the page's life
 *     and never persisted anywhere.
 *
 * Conflating the first two is what produced the bug: a dismissal was written
 * into the same key that stood in for permission, so dismissing once also
 * recorded `granted = false` about somebody who had never denied anything.
 */

/** Remembered for the tab, deliberately: see BANNER DISMISSAL above. */
const DISMISSED_KEY = 'wv_location_dismissed';

/**
 * The browser's own answer, or `null` when it will not say.
 *
 * Safari has historically not supported `permissions.query` for geolocation,
 * and a query can reject on some engines rather than resolving to a state.
 * `null` means "unknown", and the caller falls back to the old behaviour of
 * offering the banner — which is correct, because an unknown permission is
 * exactly the case where asking is worthwhile.
 */
export async function readGeolocationPermission(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav?.permissions?.query) return null;
  try {
    const status = await nav.permissions.query({ name: 'geolocation' });
    return status?.state ?? null;
  } catch {
    return null;
  }
}

export function LocationProvider({ children }) {
  const [location, setLocation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  /* `requestLocation` is referenced by the mount effect below, which runs
     before the `useCallback` on the next line has been assigned in source
     order. A ref keeps the effect free of a dependency it cannot have yet. */
  const requestRef = useRef(null);

  const requestLocation = useCallback((silent = false) => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser.');
      return;
    }

    setLoading(true);
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
        setLoading(false);
        setPermissionDenied(false);
        setShowPrompt(false);
      },
      (err) => {
        setLoading(false);
        if (err.code === err.PERMISSION_DENIED) {
          setPermissionDenied(true);
          if (!silent) setError('Location access was denied.');
          /**
           * Denied, so the banner stays available.
           *
           * Pressing it will not raise a dialog — the browser suppresses that —
           * but the banner is the only thing on the page that tells somebody
           * location exists and can be turned back on in their browser
           * settings. Hiding it would leave the feature permanently invisible
           * to the people most likely to want it back.
           */
          setShowPrompt(!sessionStorage.getItem(DISMISSED_KEY));
        } else {
          /* A timeout or a position-unavailable is not an answer about
             permission, so it does not change whether the banner shows. */
          if (!silent) setError(err.message || 'Failed to get location.');
          setShowPrompt(false);
        }
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000 // 5 minutes
      }
    );
  }, []);
  requestRef.current = requestLocation;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const state = await readGeolocationPermission();
      if (cancelled) return;

      /**
       * Already granted: use it, say nothing.
       *
       * This is the whole fix. `getCurrentPosition` resolves without a dialog
       * for an account the browser already trusts, so there is nothing to ask
       * and nothing to show.
       */
      if (state === 'granted') {
        requestRef.current?.(true);
        return;
      }

      if (state === 'denied') {
        setPermissionDenied(true);
      }

      /* 'prompt', 'denied', or an engine that will not say — offer the banner
         unless they have waved it away in this session. */
      if (!sessionStorage.getItem(DISMISSED_KEY)) setShowPrompt(true);
    })();

    return () => { cancelled = true; };
  }, []);

  /**
   * "Not now."
   *
   * Records only that the banner was waved away, and only for this tab. It
   * deliberately does NOT record anything about permission — the previous
   * version wrote `granted = false` here, asserting a denial from somebody who
   * had merely not answered.
   */
  const dismissPrompt = useCallback(() => {
    sessionStorage.setItem(DISMISSED_KEY, 'true');
    setShowPrompt(false);
  }, []);

  const clearLocation = useCallback(() => {
    setLocation(null);
    setError(null);
    setPermissionDenied(false);
  }, []);

  return (
    <LocationContext.Provider value={{
      location,
      loading,
      error,
      permissionDenied,
      showPrompt,
      requestLocation,
      dismissPrompt,
      clearLocation
    }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocationContext() {
  return useContext(LocationContext);
}
