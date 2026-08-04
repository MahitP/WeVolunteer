import { useEffect, useState } from 'react';

/**
 * Whether the browser currently has a network connection.
 *
 * The app had no network detection at all before this: a volunteer on a school
 * bus with one bar got the same silent, empty screens as someone whose session
 * had expired, with nothing to distinguish "we cannot reach the server" from
 * "there is nothing here". Those need different words and different advice.
 *
 * ── What `navigator.onLine` is and is not ──
 *
 * `false` is reliable — the browser knows when it has no interface. `true` only
 * means an interface exists, not that anything is reachable, so this is used to
 * explain a failure the app already met, never to predict one. Nothing here
 * blocks a request on it.
 *
 * The state is re-read inside the effect as well as in the initialiser: the
 * connection can drop between the first render and the listeners attaching, and
 * that gap is exactly when someone is most likely to be walking out of range.
 */
export default function useOnline() {
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine ?? true);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    setOnline(globalThis.navigator?.onLine ?? true);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
