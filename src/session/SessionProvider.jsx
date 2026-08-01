import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { can } from '../authz.js';
import { connectSocket, disconnectSocket } from '../services/socket';

const SessionContext = createContext(null);

/**
 * Who is signed in, and the page data that arrives with them.
 *
 * Moved out of App.jsx unchanged. App.jsx held routing, the session bootstrap and
 * ~15 role ternaries in one 1,286-line component, and the entanglement was the
 * direct cause of TD-9: `/oauth/callback` waited on the whole bootstrap — getMe
 * plus the progressive fetch of events, applications and favourites, 380–514 ms
 * measured — before it rendered anything, which pushed a Testing Library wait
 * past its 1,000 ms budget about one run in four.
 *
 * The fix lives in App.jsx (AUTH_FLOW_PATHS is checked *above* the
 * `isCheckingSession` gate) and this provider deliberately does not gate its
 * children on `isCheckingSession`: it renders them on the first frame and lets
 * the consumer decide what to do while the session is still unknown. Do not add
 * an early return here.
 *
 * Everything in here is a move, not a rewrite. The progressive event fetch, the
 * order of the awaits in `refresh`, the single-presentation refs on the two token
 * effects, and the dependency arrays are all load-bearing — see the comments at
 * each, `fetchEventsProgressive.test.js`, and `App.authRoutes.test.jsx`.
 *
 * `addToast` is a prop rather than something this file owns: the toast queue is
 * presentation and lives with the component that renders it. The bootstrap needs
 * to be able to say "some of your information could not be loaded", which is the
 * only reason it is passed in.
 */
export function SessionProvider({ addToast, children }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [events, setEvents] = useState([]);
  const [applications, setApplications] = useState([]);
  const [favorites, setFavorites] = useState([]);

  /**
   * Whether an event load is still filling in, so screens can say so rather
   * than looking finished while pages are still arriving.
   */
  const [eventsLoading, setEventsLoading] = useState(false);

  /**
   * Discards a superseded load.
   *
   * Two refreshes can overlap — a socket event and a manual action, or a
   * StrictMode double-invoke — and a progressive load applies state after every
   * page. Without a generation check, an older walk's later pages would land on
   * top of a newer walk's results and the list would flicker back to stale data.
   * Each load captures the generation it started in and stops applying the moment
   * it is no longer current.
   */
  const eventsLoadGeneration = useRef(0);

  /**
   * @param {string} [role] the signed-in user's role, when the caller already
   *   knows it. refreshAll has it in hand before `currentUser` state has settled,
   *   and reading the stale state there would send `mine=true` for a moderator
   *   on the first load.
   */
  const loadEvents = async (role) => {
    const generation = ++eventsLoadGeneration.current;
    const isCurrent = () => eventsLoadGeneration.current === generation;

    setEventsLoading(true);
    /* The caller may hand us a role before `currentUser` state has settled;
       spread the known user so any per-user grants it carries still count. */
    const actor = { ...(currentUser || {}), role: role ?? currentUser?.role };
    try {
      await api.fetchEventsProgressive({
        // The server's maximum, deliberately. A deployment whose whole event list
        // fits in one page makes exactly one request — identical to the behaviour
        // this replaced — so paging costs nothing until the data is genuinely
        // large. See EVENTS_MAX_LIMIT in server/routes/eventRoutes.js for the
        // measurements behind that.
        pageSize: 500,
        /**
         * Only events this user is involved in.
         *
         * This is the change that makes the whole exercise worthwhile. The index
         * exists so the calendar can resolve each application to its event and
         * the dashboards can filter for their own — none of which needs the
         * district's entire history. Bounded by the user's own activity, it is
         * one small request instead of the whole table. Anyone who can moderate
         * events is excluded, because the review queue legitimately moderates
         * everything and it already makes its own separate call — that is
         * `event.moderate`, which admin and super_admin hold and nobody else
         * does. It was `role === 'admin'`, which handed the platform owner the
         * narrow index its review queue cannot work from.
         */
        params: can(actor, 'event.moderate') ? {} : { mine: 'true' },
        shouldContinue: isCurrent,
        // Applied per page, so the first screenful renders without waiting for
        // the whole table. `slice()` because the accumulator is mutated in place.
        onPage: (eventsSoFar) => { if (isCurrent()) setEvents(eventsSoFar.slice()); }
      });
    } catch (err) {
      console.error('Failed to refresh events:', err);
    } finally {
      if (isCurrent()) setEventsLoading(false);
    }
  };

  const refreshEvents = loadEvents;

  const refreshApplications = async () => {
    try { setApplications(await api.fetchApplications()); } catch (err) { console.error('Failed to refresh applications:', err); }
  };

  const refreshAll = async () => {
    setIsCheckingSession(true);
    try {
      const user = await api.getMe();
      if (!user) {
        setCurrentUser(null);
        disconnectSocket();
        return;
      }
      setCurrentUser(user);

      /**
       * Stop here for an account that has not confirmed its address.
       *
       * authenticateToken confines an unconfirmed session to a small allowlist,
       * so every call below answers 403 — and the catch at the bottom of this
       * function reads that as a dead session and signs the user out. The
       * result would be an endless bounce back to the sign-in screen for
       * exactly the people who need to reach the "resend confirmation" button.
       *
       * The verification wall renders from `currentUser` alone and needs none
       * of this data.
       */
      if (user.emailVerified === false) {
        setIsCheckingSession(false);
        return;
      }

      connectSocket();

      /**
       * A failure loading page data is not a failure of the session.
       *
       * These fetches used to sit under the same catch as `getMe`, which set
       * `currentUser` to null — so a single 500 from /api/events, or a dropped
       * connection mid-refresh, silently signed the user out and dumped them on
       * the sign-in screen. The session was fine; only the data was missing.
       *
       * `getMe` above is the authority on whether the session is alive, and it
       * already returns null (rather than throwing) for a 401. Everything below
       * degrades to empty state and says so.
       */
      try {
        /**
         * Events load progressively; applications and favourites do not.
         *
         * `loadEvents` applies state after each page, so it is started rather
         * than awaited alongside the others — awaiting it here would put the
         * whole walk back on the critical path and undo the reason for paging.
         * The small fixed-size fetches still run in parallel with it.
         */
        const eventsDone = loadEvents(user.role);

        /* Favouriting is a volunteer's shortlist of events to apply to, so
           `event.apply` is the capability that makes the list mean anything.
           Held by student (unchanged) and, through the wildcard, super_admin;
           GET /api/favorites is scoped to the caller's own rows for every
           role, so fetching it can never widen what anyone sees. */
        const canFavorite = can(user, 'event.apply');
        const promises = [api.fetchApplications()];
        if (canFavorite) {
          promises.push(api.fetchFavorites().catch(() => []));
        }
        const [apps, favs] = await Promise.all(promises);
        setApplications(apps);
        if (canFavorite && favs) {
          setFavorites(favs.map(f => f.event_id || f.eventId));
        }

        // Awaited last so the session-check spinner clears on a complete index —
        // the calendar and dashboards resolve applications against it, and
        // showing them a half-filled list would render a wrong calendar rather
        // than an incomplete one.
        await eventsDone;
      } catch (err) {
        console.error('Failed to load page data:', err);
        addToast('Some of your information could not be loaded. Reload to try again.', 'error');
      }

      try {
        const notifs = await api.fetchNotifications(10);
        if (notifs.unreadCount > 0 && !sessionStorage.getItem('notif_toast_shown')) {
          if (notifs.unreadCount === 1 && notifs.notifications.length > 0) {
            addToast(notifs.notifications[0].body, 'info');
          } else {
            addToast(`You have ${notifs.unreadCount} new notifications. Check your notifications center.`, 'info');
          }
          sessionStorage.setItem('notif_toast_shown', 'true');
        }
      } catch (err) {
        console.error('Failed to fetch notifications for toast', err);
      }
    } catch (err) {
      console.error('Session check failed:', err);
      setCurrentUser(null);
    } finally {
      setIsCheckingSession(false);
    }
  };

  const verifyToken = searchParams.get('verify');
  const emailChangeToken = searchParams.get('emailchange');

  /**
   * Confirming a new email address, from the link sent to that address.
   *
   * Single-presentation for the same three reasons the `verify` handler below
   * documents: StrictMode double-invokes effects, stripping the parameter
   * re-triggers the effect that reads it, and the token is single use — so
   * without the ref a successful confirmation is immediately painted over with
   * "that link is not valid".
   */
  const emailChangeAttempted = useRef(false);

  useEffect(() => {
    if (!emailChangeToken || emailChangeAttempted.current) return;
    emailChangeAttempted.current = true;

    (async () => {
      try {
        await api.confirmEmailChange(emailChangeToken);
        addToast('Email address confirmed. This is now the address on your account.', 'success');
      } catch (err) {
        addToast(err.message || 'That link did not work. Request the change again from Settings.', 'error');
      } finally {
        const newParams = new URLSearchParams(searchParams);
        newParams.delete('emailchange');
        setSearchParams(newParams, { replace: true });
        // Confirming bumps token_version and issues a fresh cookie, so the
        // in-memory user is stale either way — re-read it rather than guess.
        await refreshAll();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailChangeToken]);

  /**
   * A confirmation token is single use, so it must be presented exactly once.
   *
   * Three things previously conspired to present it twice: StrictMode
   * double-invokes effects in development; `setSearchParams` inside the effect
   * changed `verifyToken`, which is the effect's own dependency, re-running
   * it; and each run raced the other. The second attempt always failed, so a
   * successful confirmation was immediately overwritten with the toast "That
   * confirmation link is not valid."
   */
  const verifyAttempted = useRef(false);

  useEffect(() => {
    const init = async () => {
      if (verifyToken && !verifyAttempted.current) {
        verifyAttempted.current = true;
        try {
          await api.verifyEmail(verifyToken);
          addToast('Email confirmed. Welcome to WeVolunteer.', 'success');
        } catch (err) {
          addToast(err.message || 'That confirmation link did not work. Request a new one.', 'error');
        } finally {
          // Strip the token only after it has been spent, so a reload during
          // the request does not silently drop it.
          const newParams = new URLSearchParams(searchParams);
          newParams.delete('verify');
          setSearchParams(newParams, { replace: true });
        }
      }
      await refreshAll();
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyToken]);

  const handleToggleFavorite = async (eventId) => {
    try {
      const res = await api.toggleFavorite(eventId);
      if (res.favorited) {
        setFavorites(prev => [...prev, eventId]);
        addToast('Added to favorites.', 'success');
      } else {
        setFavorites(prev => prev.filter(id => id !== eventId));
        addToast('Removed from favorites.', 'info');
      }
    } catch {
      addToast('Could not toggle favorite.', 'error');
    }
  };

  const signOut = async () => {
    await api.logout();
    setCurrentUser(null);
    disconnectSocket();
    setEvents([]);
    setApplications([]);
    setFavorites([]);
    // Otherwise the next person to sign in in this tab — a second student on a
    // shared computer — has their unread-notification greeting suppressed by
    // the previous user's flag.
    sessionStorage.removeItem('notif_toast_shown');
    navigate('/login');
  };

  const value = {
    currentUser, setCurrentUser, isCheckingSession, refresh: refreshAll, signOut,
    // The page data the bootstrap loads alongside the user. It lives here
    // because `refresh` is what fills it in, and the dashboards, the calendar
    // and the event modal all read it.
    events, applications, favorites, eventsLoading,
    refreshEvents, refreshApplications, toggleFavorite: handleToggleFavorite
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
