import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, useNavigate, useLocation, useSearchParams, Navigate, useParams } from 'react-router-dom';
import { api } from './utils/api';
import { DEMO_MODE, APP_NAME, SCHOOL_NAME } from './config';
import DemoBar from './components/DemoBar';
import Login from './views/Login';
import Welcome from './views/Welcome';
import Signup from './views/Signup';
import BrowseEvents from './views/BrowseEvents';
import CreateEvent from './views/CreateEvent';
import VolunteerDashboard from './views/VolunteerDashboard';
import OrganizerDashboard from './views/OrganizerDashboard';
import AdminDashboard from './views/AdminDashboard';
import Notifications from './views/Notifications';
import CalendarView from './views/CalendarView';
import VolunteerProfile from './views/VolunteerProfile';
import OrganizerProfile from './views/OrganizerProfile';
import EventModal from './components/EventModal';
import NotificationsBell from './components/NotificationsBell';
import ProfileEditModal from './components/ProfileEditModal';
import ResetPassword from './views/ResetPassword';
import OAuthCallback from './views/OAuthCallback';
import ErrorBoundary from './components/ErrorBoundary';
import LoadingSkeleton from './components/common/LoadingSkeleton';
import CertificateVerification from './views/CertificateVerification';
import VolunteerPortfolio from './views/VolunteerPortfolio';
import CheckInView from './views/CheckInView';
import ThemeToggle from './components/ThemeToggle';
import Messages from './views/Messages';
import ProfileMenu from './components/account/ProfileMenu';
import Settings from './views/Settings';
import { connectSocket, disconnectSocket } from './services/socket';
import {
  LayoutDashboard, Compass, CalendarPlus, ShieldCheck, LogOut, CalendarDays,
  UserCog, CheckCircle2, AlertTriangle, Info, X, ChevronsUpDown, Loader2, Bell, UserRound, MessageSquare, MoreHorizontal, Mail, Settings as SettingsIcon
} from 'lucide-react';

/* Navigation is defined once and filtered by role, so every role gets the
   same shell instead of a different one. */
const NAV = [
  { id: 'dashboard', path: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['student', 'organizer'] },
  { id: 'dashboard', path: '/', label: 'Review queue', icon: ShieldCheck, roles: ['admin'] },
  { id: 'browse', path: '/events', label: 'Opportunities', icon: Compass, roles: ['student', 'organizer', 'admin'] },
  { id: 'calendar', path: '/calendar', label: 'Calendar', icon: CalendarDays, roles: ['student', 'organizer'] },
  { id: 'messages', path: '/messages', label: 'Messages', icon: MessageSquare, roles: ['student', 'organizer'] },
  { id: 'create', path: '/events/new', label: 'New event', icon: CalendarPlus, roles: ['organizer'], requiresVerified: true },
  { id: 'notifications', path: '/notifications', label: 'Notifications', icon: Bell, roles: ['student', 'organizer', 'admin'] },
  { id: 'profile', path: '/profile', label: 'My profile', icon: UserRound, roles: ['student', 'organizer'] }
];

const PAGE_META = {
  student: {
    dashboard: { title: 'Dashboard', sub: 'Your shifts, hours, and history' },
    browse: { title: 'Opportunities', sub: 'Find a shift and apply — organizers confirm who attends' },
    calendar: { title: 'Calendar', sub: 'Your shifts and the deadlines that matter' },
    messages: { title: 'Messages', sub: 'Coordinate directly with organizers regarding your shifts' },
    notifications: { title: 'Notifications', sub: 'Replies, reminders, and event updates' },
    profile: { title: 'My profile', sub: 'Your service record, milestones, and certificates' }
  },
  organizer: {
    dashboard: { title: 'Dashboard', sub: 'Track your volunteers, hours, and pending reviews' },
    browse: { title: 'Recruit', sub: 'All events visible to volunteers on the network' },
    calendar: { title: 'Calendar', sub: 'Events you host and when applications close' },
    messages: { title: 'Messages', sub: 'Coordinate directly with volunteers regarding your events' },
    notifications: { title: 'Notifications', sub: 'Application updates and community alerts' },
    profile: { title: 'My profile', sub: 'Your public track record and organizer status' }
  },
  admin: {
    dashboard: { title: 'Review queue', sub: 'Approve organizers and moderate events' },
    browse: { title: 'All events', sub: 'Everything posted across the district' },
    notifications: { title: 'Notifications', sub: 'Platform activity' }
  }
};

const ROLE_LABEL = { admin: 'Administrator', organizer: 'Organizer', student: 'Volunteer' };

/**
 * Paths that arrive as a link from an email or an OAuth provider, and so must
 * resolve whether or not a session exists. Handled ahead of the session
 * branches in App — see the comment at the check itself.
 */
const AUTH_FLOW_PATHS = ['/oauth/callback', '/reset-password'];

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [events, setEvents] = useState([]);
  const [applications, setApplications] = useState([]);
  const [favorites, setFavorites] = useState([]);
  
  // Global intercept for password reset links
  useEffect(() => {
    if (searchParams.has('reset') && location.pathname !== '/reset-password') {
      navigate(`/reset-password?token=${encodeURIComponent(searchParams.get('reset'))}`, { replace: true });
    }
  }, [searchParams, location.pathname, navigate]);

  const [showMobileMore, setShowMobileMore] = useState(false);
  const mobileNavRef = useRef(null);
  const setActiveTab = (tab) => {
    const map = {
      dashboard: '/',
      browse: '/events',
      create: '/events/new',
      calendar: '/calendar',
      notifications: '/notifications',
      profile: '/profile'
    };
    if (map[tab]) navigate(map[tab]);
  };

  const [notifKey, setNotifKey] = useState(0);
  const [editingProfile, setEditingProfile] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const userMenuRef = useRef(null);

  /**
   * Events seen outside the index, keyed by id.
   *
   * BrowseEvents now fetches its own filtered pages, so it can show an event the
   * index does not contain — one the user neither hosts nor has applied to.
   * `events.find` alone would then fail to open it and the user would be told
   * "That event is no longer available" about something they are looking at.
   * Anything browse renders is recorded here so the modal can still resolve it.
   */
  const [seenEvents, setSeenEvents] = useState({});
  const rememberEvents = React.useCallback((list) => {
    if (!list?.length) return;
    setSeenEvents(prev => {
      let changed = false;
      const next = { ...prev };
      for (const e of list) {
        if (e?.id && next[e.id] !== e) { next[e.id] = e; changed = true; }
      }
      return changed ? next : prev;
    });
  }, []);

  // Derived state from URL
  const selectedEventId = searchParams.get('event');
  const selectedEvent = selectedEventId
    ? (events.find(e => e.id === selectedEventId) || seenEvents[selectedEventId] || null)
    : null;
  const profileId = searchParams.get('profile');
  const profileType = searchParams.get('type');
  const viewingProfile = profileId && profileType ? { type: profileType, id: profileId } : null;

  // Determine active tab for UI selection
  const currentPath = location.pathname;
  let activeTab = 'dashboard';
  if (currentPath.startsWith('/events/new')) activeTab = 'create';
  else if (currentPath.startsWith('/events')) activeTab = 'browse';
  else if (currentPath.startsWith('/calendar')) activeTab = 'calendar';
  else if (currentPath.startsWith('/notifications')) activeTab = 'notifications';
  else if (currentPath.startsWith('/profile')) activeTab = 'profile';
  else if (currentPath.startsWith('/settings')) activeTab = 'settings';
  else if (currentPath.startsWith('/messages')) activeTab = 'messages';

  // Auto-scroll the active item into view on mobile
  useEffect(() => {
    if (mobileNavRef.current) {
      const activeBtn = mobileNavRef.current.querySelector('[aria-current="page"]');
      if (activeBtn) {
        // center the button in the view
        const scrollLeft = activeBtn.offsetLeft - (mobileNavRef.current.offsetWidth / 2) + (activeBtn.offsetWidth / 2);
        mobileNavRef.current.scrollTo({ left: scrollLeft, behavior: 'smooth' });
      }
    }
  }, [activeTab]);

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
   *   and reading the stale state there would send `mine=true` for an admin on
   *   the first load.
   */
  const loadEvents = async (role) => {
    const generation = ++eventsLoadGeneration.current;
    const isCurrent = () => eventsLoadGeneration.current === generation;

    setEventsLoading(true);
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
         * one small request instead of the whole table. Admins are excluded
         * because the review queue legitimately moderates everything, and it
         * already makes its own separate call.
         */
        params: (role ?? currentUser?.role) === 'admin' ? {} : { mine: 'true' },
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

        const promises = [api.fetchApplications()];
        if (user.role === 'student') {
          promises.push(api.fetchFavorites().catch(() => []));
        }
        const [apps, favs] = await Promise.all(promises);
        setApplications(apps);
        if (user.role === 'student' && favs) {
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

  useEffect(() => {
    if (!userMenuOpen) return;
    const onClick = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setUserMenuOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);


  const addToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  };
  const removeToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  const handleCreateEvent = async (eventData) => {
    await api.createEvent(eventData);
    refreshEvents();
    navigate('/');
  };

  const handleLogout = async () => {
    await api.logout();
    setCurrentUser(null);
    disconnectSocket();
    setEvents([]);
    setApplications([]);
    setFavorites([]);
    setUserMenuOpen(false);
    // Otherwise the next person to sign in in this tab — a second student on a
    // shared computer — has their unread-notification greeting suppressed by
    // the previous user's flag.
    sessionStorage.removeItem('notif_toast_shown');
    navigate('/login');
  };

  const handleLoginSuccess = () => {
    refreshAll();
    navigate('/');
  };

  const setViewingProfileState = (profile) => {
    if (profile === null) {
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('profile');
      newParams.delete('type');
      setSearchParams(newParams);
    } else {
      const newParams = new URLSearchParams(searchParams);
      newParams.set('profile', profile.id);
      newParams.set('type', profile.type);
      setSearchParams(newParams);
    }
  };

  const setSelectedEventState = (eventId) => {
    if (eventId === null) {
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('event');
      setSearchParams(newParams);
    } else {
      const newParams = new URLSearchParams(searchParams);
      newParams.set('event', eventId);
      setSearchParams(newParams);
    }
  };

  // Callers pass either an event object (cards, dashboards) or an id string
  // (notifications, calendar, profiles). Normalise here rather than at nine
  // call sites — `viewVolunteer` below already takes the same approach.
  const openEventById = (eventOrId) => {
    const id = typeof eventOrId === 'string' ? eventOrId : eventOrId?.id;
    if (!id) return addToast('That event is no longer available.', 'info');

    // Given the whole object — which is what a card passes — trust it and record
    // it, rather than insisting it also be in the index. Browse pages are
    // filtered server-side now and legitimately contain events the index does not.
    if (typeof eventOrId === 'object' && eventOrId) rememberEvents([eventOrId]);

    const known = events.some(e => e.id === id) || !!seenEvents[id] || typeof eventOrId === 'object';
    if (known) setSelectedEventState(id);
    else addToast('That event is no longer available.', 'info');
  };

  const viewVolunteer = (person) => {
    const id = typeof person === 'string' ? person : person?.id;
    if (id) setViewingProfileState({ type: 'volunteer', id });
  };
  const viewOrganizer = (id) => id && setViewingProfileState({ type: 'organizer', id });

  /* ── Session check ─────────────────────────────────────────── */
  if (isCheckingSession) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', paddingTop: 'var(--s8)' }}>
        <LoadingSkeleton heights={[40, 120, 300, 100]} />
      </div>
    );
  }

  // Public Routes (like certificate verification) bypass auth checks
  if (currentPath.startsWith('/verify/')) {
    return (
      <Routes>
        <Route path="/verify/:code" element={<CertificateVerification />} />
      </Routes>
    );
  }

  /**
   * Screens reached by a link from outside the app, handled BEFORE the session
   * branches below.
   *
   * Both of these used to live only in the signed-out route table, which meant
   * the authenticated shell's `*` catch-all swallowed them:
   *
   *   • /oauth/callback — pressing "Connect" in Settings sent the user to
   *     Google and brought them back to a path that redirected to the
   *     dashboard. The authorization code was never exchanged, so nothing was
   *     linked, and nothing said so. The server's entire `auto_linked` branch
   *     was unreachable in practice.
   *   • /reset-password — a user already signed in on their phone who tapped
   *     the reset link in their email landed on the dashboard instead.
   *
   * Neither is a "signed-out screen". The sender of the link cannot know
   * whether a session exists, so the route has to resolve in all three states
   * (no session, unconfirmed session, confirmed session).
   */
  if (AUTH_FLOW_PATHS.includes(currentPath)) {
    return (
      <>
        <Routes>
          <Route path="/oauth/callback" element={
            <OAuthCallback
              onLoginSuccess={handleLoginSuccess}
              /* Someone who started this from Settings wants to end up back in
                 Settings, not on the dashboard. */
              onLinked={() => { refreshAll(); navigate('/settings?section=security', { replace: true }); }}
              addToast={addToast}
            />
          } />
          <Route path="/reset-password" element={
            <ResetPassword
              token={searchParams.get('token')}
              onSuccess={() => {
                /**
                 * A reset bumps token_version, so any session this tab still
                 * holds is already dead and `currentUser` in memory is stale.
                 * A hard navigation is the honest move: it drops the stale
                 * state in both session states rather than letting a soft
                 * route change render an authenticated shell that will 401 on
                 * its first request.
                 */
                addToast('Password updated. Please sign in.', 'success');
                window.location.assign('/login');
              }}
              onCancel={() => navigate('/login', { replace: true })}
            />
          } />
        </Routes>
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  if (!currentUser) {
    return (
      <>
        <Routes>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/login" element={
            <Login
              onLoginSuccess={(mode) => (mode === 'signup' ? navigate('/signup') : handleLoginSuccess())}
              addToast={addToast}
            />
          } />
          <Route path="/signup" element={
            <Signup
              onSignupSuccess={handleLoginSuccess}
              onBackToLogin={() => navigate('/login')}
              addToast={addToast}
            />
          } />
          {/* /reset-password and /oauth/callback are handled above, before the
              session branches, because both are reached by a link from outside
              the app and must work in every session state. */}
          <Route
            path="*"
            element={
              searchParams.has('reset')
                ? <Navigate to={`/reset-password?token=${encodeURIComponent(searchParams.get('reset'))}`} replace />
                : <Navigate to="/welcome" replace />
            }
          />
        </Routes>
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  if (!currentUser.emailVerified) {
    return (
      <>
        <VerifyEmailWall
          user={currentUser}
          addToast={addToast}
          onSignOut={handleLogout}
          onVerified={refreshAll}
        />
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  /* ── Application shell ─────────────────────────────────────── */
  const navItems = NAV
    .filter(n => n.roles.includes(currentUser.role))
    .filter(n => !n.requiresVerified || currentUser.verified);

  const primaryNavItems = navItems.slice(0, 4);
  const secondaryNavItems = navItems.slice(4);

  const meta = PAGE_META[currentUser.role]?.[activeTab] || { title: APP_NAME, sub: '' };

  const pendingForMe = currentUser.role === 'organizer'
    ? applications.filter(a => a.status === 'pending' &&
        events.some(e => e.id === a.eventId && e.organizerId === currentUser.id)).length
    : 0;

  return (
    <div className="app">
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* ── Sidebar (desktop / rail on tablet) ── */}
      <aside className="sidebar">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
          <span className="brand-mark">WV</span>
          <span className="brand-text">
            <span className="brand-name">{APP_NAME}</span>
            <span className="brand-sub">{SCHOOL_NAME}</span>
          </span>
        </a>

        <nav className="nav" aria-label="Main">
          {navItems.map(({ id, path, label, icon: Icon }) => (
            <button
              key={id + label}
              className="nav-item"
              aria-current={activeTab === id ? 'page' : undefined}
              onClick={() => { setViewingProfileState(null); navigate(path); }}
            >
              <Icon size={17} strokeWidth={2} />
              <span>{label}</span>
              {id === 'dashboard' && pendingForMe > 0 && (
                <span className="nav-count is-urgent">{pendingForMe}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <ProfileMenu 
            user={currentUser} 
            onEditProfile={() => setEditingProfile(true)} 
            onSignOut={handleLogout} 
          />
        </div>
      </aside>

      {/* ── Content column ── */}
      <div className="content">
        {DEMO_MODE && (
          <DemoBar currentUser={currentUser} refreshAll={refreshAll} addToast={addToast} />
        )}

        <header className="topbar">
          <div className="truncate">
            <h1 className="topbar-title truncate">{meta.title}</h1>
            {meta.sub && <div className="topbar-sub truncate">{meta.sub}</div>}
          </div>
          <div className="topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
            <ThemeToggle />
            <NotificationsBell
              key={currentUser.id}
              refreshKey={notifKey}
              onViewEvent={openEventById}
              onSeeAll={() => { setViewingProfileState(null); navigate('/notifications'); }}
            />
          </div>
        </header>

        <main className="page" id="main-content" tabIndex={-1}>
          {/* Scoped to the routed content so a failure inside a view leaves the
              navigation, the notification bell, and sign-out still working —
              the user can move somewhere else instead of being stuck. resetKey
              clears a caught error once they do. */}
          <ErrorBoundary
            resetKey={`${currentPath}:${selectedEventId || ''}:${profileId || ''}`}
            title="This page didn't load"
            message="Something went wrong displaying this page. Your data is safe — nothing was changed. Try another tab, or reload."
          >
          {viewingProfile ? (
            viewingProfile.type === 'organizer' ? (
              <OrganizerProfile
                userId={viewingProfile.id}
                onBack={() => setViewingProfileState(null)}
                onViewEvent={(id) => { setViewingProfileState(null); openEventById(id); }}
              />
            ) : (
              <VolunteerProfile
                userId={viewingProfile.id}
                currentUser={currentUser}
                onBack={() => setViewingProfileState(null)}
                onEditProfile={() => setEditingProfile(true)}
                onViewEvent={(id) => { setViewingProfileState(null); openEventById(id); }}
                addToast={addToast}
              />
            )
          ) : (
            <Routes>
              <Route path="/" element={
                currentUser.role === 'admin' ? <AdminDashboard addToast={addToast} /> :
                currentUser.role === 'student' ? (
                  <VolunteerDashboard
                    currentUser={currentUser}
                    events={events}
                    applications={applications}
                    addToast={addToast}
                    setActiveTab={setActiveTab}
                    refreshEvents={refreshEvents}
                    refreshApplications={refreshApplications}
                    onViewDetails={openEventById}
                  />
                ) : (
                  <OrganizerDashboard
                    currentUser={currentUser}
                    events={events}
                    applications={applications}
                    refreshEvents={refreshEvents}
                    refreshApplications={refreshApplications}
                    addToast={addToast}
                    setActiveTab={setActiveTab}
                    onViewDetails={openEventById}
                    onViewVolunteerProfile={viewVolunteer}
                  />
                )
              } />
              
              <Route path="/events" element={
                <BrowseEvents
                  currentUser={currentUser}
                  applications={applications}
                  onViewDetails={openEventById}
                  favorites={favorites}
                  onToggleFavorite={handleToggleFavorite}
                  /* Browse fetches its own server-filtered pages, so it no longer
                     takes the index. Anything it renders is recorded so the event
                     modal can resolve an event the index does not hold. */
                  onEventsSeen={rememberEvents}
                />
              } />
              
              <Route path="/events/new" element={
                currentUser.role === 'organizer' && currentUser.verified ? (
                  <CreateEvent onSubmitEvent={handleCreateEvent} addToast={addToast} setActiveTab={setActiveTab} />
                ) : <Navigate to="/" replace />
              } />
              
              {/* /events/:id/edit used to render a blank CreateEvent whose submit
                  handler called api.createEvent — so an organizer who reached it
                  (bookmark, browser autocomplete, back button, or guessing the URL
                  from /events/new) saw an empty form that PUBLISHED A SECOND EVENT
                  instead of editing the one they asked for. Nothing in the app ever
                  linked here; editing lives in EventModal. Redirect to the real
                  event so the URL does the thing its path promises. */}
              <Route path="/events/:id/edit" element={<RedirectToEvent />} />

              <Route path="/checkin/:eventId" element={
                currentUser.role === 'organizer' ? (
                  <CheckInView currentUser={currentUser} />
                ) : <Navigate to="/" replace />
              } />
              
              <Route path="/calendar" element={
                <CalendarView
                  currentUser={currentUser}
                  events={events}
                  applications={applications}
                  onViewEvent={openEventById}
                />
              } />
              
              <Route path="/notifications" element={
                <Notifications
                  onViewEvent={openEventById}
                  onCountChange={() => setNotifKey(k => k + 1)}
                />
              } />
              
              <Route path="/messages" element={
                (currentUser.role === 'student' || currentUser.role === 'organizer') ? (
                  <Messages />
                ) : <Navigate to="/" replace />
              } />

              <Route path="/profile" element={
                currentUser.role === 'student' ? (
                  <VolunteerProfile
                    userId={currentUser.id}
                    currentUser={currentUser}
                    onEditProfile={() => setEditingProfile(true)}
                    onViewEvent={openEventById}
                    addToast={addToast}
                  />
                ) : currentUser.role === 'organizer' ? (
                  <OrganizerProfile
                    userId={currentUser.id}
                    onViewEvent={openEventById}
                  />
                ) : <Navigate to="/" replace />
              } />
              
              <Route path="/portfolio" element={
                currentUser.role === 'student' ? (
                  <VolunteerPortfolio currentUser={currentUser} />
                ) : <Navigate to="/" replace />
              } />

              <Route path="/settings" element={
                <Settings currentUser={currentUser} addToast={addToast} onProfileChange={refreshAll} />
              } />
              
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
          </ErrorBoundary>
        </main>
      </div>

      {/* ── Mobile navigation ── */}
      <nav className="mobilenav" aria-label="Main" ref={mobileNavRef}>
        {primaryNavItems.map(({ id, path, label, icon: Icon }) => (
          <button
            key={id + label}
            className="mobilenav-item"
            aria-current={activeTab === id ? 'page' : undefined}
            onClick={() => { setViewingProfileState(null); navigate(path); }}
          >
            <Icon size={19} strokeWidth={2} />
            {label}
          </button>
        ))}
        {secondaryNavItems.length > 0 && (
          <button
            className="mobilenav-item"
            aria-current={showMobileMore ? 'page' : undefined}
            onClick={() => setShowMobileMore(true)}
          >
            <MoreHorizontal size={19} strokeWidth={2} />
            More
          </button>
        )}
      </nav>

      {/* Mobile More Sheet */}
      {showMobileMore && (
        <>
          <div className="mobile-more-backdrop" onClick={() => setShowMobileMore(false)} />
          <div className="mobile-more-sheet">
            <div className="mobile-more-header" style={{ alignItems: 'flex-start', paddingBottom: 'var(--s4)' }}>
              <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center' }}>
                <span className="avatar lg">{currentUser.avatar || '👤'}</span>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span className="mobile-more-title truncate">{currentUser.name}</span>
                  <span style={{ fontSize: '0.875rem', color: 'var(--ink-2)' }}>{ROLE_LABEL[currentUser.role] || 'Volunteer'}</span>
                </div>
              </div>
              <button className="btn btn-ghost btn-icon" style={{ marginTop: '-4px', marginRight: '-4px' }} onClick={() => setShowMobileMore(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="mobile-more-menu">
              {secondaryNavItems.map(({ id, path, label, icon: Icon }) => (
                <button
                  key={id + label}
                  className="mobile-more-btn"
                  onClick={() => {
                    setShowMobileMore(false);
                    setViewingProfileState(null);
                    navigate(path);
                  }}
                >
                  <Icon size={20} />
                  <span>{label}</span>
                </button>
              ))}
              {currentUser.role !== 'student' && (
                <button
                  className="mobile-more-btn"
                  onClick={() => {
                    setShowMobileMore(false);
                    setEditingProfile(true);
                  }}
                >
                  <UserCog size={20} />
                  <span>Edit Profile</span>
                </button>
              )}
              
              <button
                className="mobile-more-btn"
                onClick={() => {
                  setShowMobileMore(false);
                  navigate('/settings');
                }}
              >
                <SettingsIcon size={20} />
                <span>Settings</span>
              </button>
              
              <div className="menu-sep" style={{ margin: 'var(--s2) 0' }} />
              
              <button
                className="mobile-more-btn danger"
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  setShowMobileMore(false);
                  handleLogout();
                }}
              >
                <LogOut size={20} />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Modals ── */}
      {/* EventModal is 1,500+ lines covering viewing, editing, applicant review,
          Auto Select, check-in and attendance. It is where nearly every
          organizer action happens, and it renders data from six endpoints — so
          it has the most ways to meet a shape it does not expect. Its own
          boundary means a failure in there is a closeable panel, not a blank
          application. */}
      {selectedEvent && (
        <ErrorBoundary
          resetKey={selectedEvent.id}
          title="This event didn't load"
          message="Something went wrong displaying this event. Nothing was changed. Close this and try again — if it keeps happening, reload the page."
          onDismiss={() => setSelectedEventState(null)}
          dismissLabel="Close event"
        >
          <EventModal
            event={selectedEvent}
            currentUser={currentUser}
            applications={applications}
            onClose={() => setSelectedEventState(null)}
            refreshEvents={refreshEvents}
            refreshApplications={refreshApplications}
            addToast={addToast}
            onViewVolunteerProfile={(p) => { setSelectedEventState(null); viewVolunteer(p); }}
            onViewOrganizer={(id) => { setSelectedEventState(null); viewOrganizer(id); }}
            isFavorited={favorites.includes(selectedEvent.id)}
            onToggleFavorite={handleToggleFavorite}
          />
        </ErrorBoundary>
      )}
      {editingProfile && (
        <ProfileEditModal
          user={currentUser}
          onClose={() => setEditingProfile(false)}
          onSave={(updated) => { setCurrentUser(updated); refreshEvents(); }}
          addToast={addToast}
          onSignOut={() => { setEditingProfile(false); handleLogout(); }}
        />
      )}

      <Toasts toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

/**
 * Sends /events/:id/edit to the event itself, which is where editing actually
 * happens (EventModal's edit mode). Kept as a redirect rather than deleted so
 * an organizer who bookmarked the URL lands somewhere useful instead of on a
 * 404 or, as before, on a form that quietly created a duplicate event.
 */
function RedirectToEvent() {
  const { id } = useParams();
  return <Navigate to={id ? `/events?event=${encodeURIComponent(id)}` : '/events'} replace />;
}

const TOAST_ICON = { success: CheckCircle2, error: AlertTriangle, info: Info };

function Toasts({ toasts, onRemove }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(toast => {
        const Icon = TOAST_ICON[toast.type] || Info;
        return (
          <div key={toast.id} className={`toast ${toast.type}`}>
            <Icon size={16} />
            <span className="toast-msg">{toast.message}</span>
            <button onClick={() => onRemove(toast.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The wall an account sees until it confirms its email address.
 *
 * Replaces an inline block that mutated the DOM directly inside its own click
 * handler — `btn.disabled = true; btn.textContent = 'Sending...'` — which
 * React then overwrote on the next render, so the button could flip back to
 * its idle label mid-request. It also offered exactly two ways out (resend,
 * sign out) and no acknowledgement that the most likely reason for being
 * stuck here is a mistyped address, which neither of them fixes.
 */
function VerifyEmailWall({ user, addToast, onSignOut, onVerified }) {
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sentAt, setSentAt] = useState(null);

  /**
   * Correcting the address, from behind the wall.
   *
   * This is the case the wall exists for and the one it used to handle worst.
   * The old copy said: if the address is wrong, "sign out and create your
   * account again with the right address" — which cannot work, because the
   * abandoned account still holds that email AND that username, so the second
   * attempt can reuse neither and the first is unusable forever.
   *
   * /api/auth/change-email is on the email-gate allowlist precisely so this
   * screen can reach it.
   */
  const [fixing, setFixing] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fixError, setFixError] = useState('');
  const [pending, setPending] = useState(null);
  const needsPassword = user.hasPassword !== false;

  const submitFix = async (e) => {
    e.preventDefault();
    setFixError('');
    setSending(true);
    try {
      const res = await api.changeEmail(newEmail.trim(), password);
      setPending(res.pending);
      setFixing(false);
      setNewEmail('');
      setPassword('');
      addToast(`Confirmation link sent to ${res.pending}.`, 'success');
    } catch (err) {
      setFixError(err.message || 'Could not change that address.');
    } finally {
      setSending(false);
    }
  };

  const resend = async () => {
    setSending(true);
    try {
      await api.resendVerification();
      setSentAt(Date.now());
      addToast('Sent. Give it a minute to arrive.', 'success');
    } catch (err) {
      addToast(err.message || 'Could not resend that link.', 'error');
    } finally {
      setSending(false);
    }
  };

  /* Confirming happens in whichever tab the email opened, which may not be
     this one. Rather than making the user guess, let them re-check here. */
  const recheck = async () => {
    setChecking(true);
    try {
      const me = await api.getMe();
      if (me?.emailVerified) await onVerified();
      else addToast('Not confirmed yet. Open the link in the email first.', 'info');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="auth">
      <main className="auth-form auth-form-narrow auth-centered" aria-labelledby="verify-heading">
        <div className="auth-icon" aria-hidden="true"><Mail size={26} /></div>

        <h1 id="verify-heading" className="auth-title">Confirm your email</h1>
        <p className="auth-subtitle">
          We sent a link to <strong>{pending || user.email}</strong>. Open it to finish setting up
          your account. The link expires 24 hours after it is sent.
        </p>

        {pending && (
          <div className="alert alert-info" role="status">
            <Mail size={16} aria-hidden="true" />
            <span>
              Your account address is still <strong>{user.email}</strong> until you open the
              link we just sent to <strong>{pending}</strong>.
            </span>
          </div>
        )}

        {!fixing ? (
          <>
            <div className="auth-actions stack-sm">
              <button className="btn btn-primary btn-block btn-lg" onClick={recheck} disabled={checking}>
                {checking ? 'Checking…' : "I've confirmed — continue"}
              </button>
              <button className="btn btn-secondary btn-block" onClick={resend} disabled={sending}>
                {sending ? 'Sending…' : sentAt ? 'Send it again' : 'Resend the link'}
              </button>
              <button className="btn btn-ghost btn-block" onClick={() => setFixing(true)}>
                That address is wrong — change it
              </button>
              <button className="btn btn-ghost btn-block" onClick={onSignOut}>
                Sign out
              </button>
            </div>

            <p className="auth-footer">
              Nothing arriving? Check your spam folder first — confirmation mail often
              lands there. If <strong>{user.email}</strong> has a typo in it, change it
              above rather than starting again: this account is holding that address and
              your username.
            </p>
          </>
        ) : (
          <form onSubmit={submitFix} className="stack-md auth-form-inner" noValidate>
            <p className="auth-subtitle">
              Enter the right address and we will send the link there instead. Nothing
              changes until you open it.
            </p>

            {fixError && (
              <div className="alert alert-danger" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{fixError}</span>
              </div>
            )}

            <div className="field">
              <label htmlFor="fix-email">Your email address</label>
              <div className="input-affix">
                <Mail size={16} aria-hidden="true" />
                <input
                  id="fix-email"
                  type="email"
                  className="input input-lg"
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  placeholder="you@example.com"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  disabled={sending}
                  autoFocus
                  required
                />
              </div>
            </div>

            {needsPassword && (
              <div className="field">
                <label htmlFor="fix-password">Your password</label>
                <input
                  id="fix-password"
                  type="password"
                  className="input input-lg"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={sending}
                  required
                />
              </div>
            )}

            <div className="auth-actions stack-sm">
              <button
                type="submit"
                className="btn btn-primary btn-block btn-lg"
                disabled={sending || !newEmail.trim() || (needsPassword && !password)}
              >
                {sending ? 'Sending…' : 'Send the link here instead'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => { setFixing(false); setFixError(''); }}
                disabled={sending}
              >
                Never mind
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
