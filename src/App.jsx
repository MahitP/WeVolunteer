import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, useNavigate, useLocation, useSearchParams, Navigate } from 'react-router-dom';
import { api } from './utils/api';
import { DEMO_MODE, APP_NAME, SCHOOL_NAME } from './config';
import DemoBar from './components/DemoBar';
import NotificationsBell from './components/NotificationsBell';
import ErrorBoundary from './components/ErrorBoundary';
import LoadingSkeleton from './components/common/LoadingSkeleton';
import ThemeToggle from './components/ThemeToggle';
import ProfileMenu from './components/account/ProfileMenu';
import Toasts from './components/common/Toasts';
import VerifyEmailWall from './components/account/VerifyEmailWall';
import { Can } from './components/common/Can.jsx';
import { SessionProvider, useSession } from './session/SessionProvider.jsx';
import {
  APP_ROUTES, SIGNED_OUT_ROUTES, PUBLIC_ROUTES,
  AdminDashboard, VolunteerDashboard, OrganizerDashboard,
  VolunteerProfile, OrganizerProfile, OAuthCallback, ResetPassword
} from './routes/index.jsx';
import {
  LayoutDashboard, Compass, CalendarPlus, ShieldCheck, LogOut, CalendarDays,
  UserCog, X, Bell, UserRound, MessageSquare, MoreHorizontal, Settings as SettingsIcon
} from 'lucide-react';

// The two heaviest modals. EventModal pulls in the whole organizer surface —
// applicant review, shifts, attendance, announcements, comments, the location
// card — and is only opened on demand, so it has no business in the entry chunk.
// The routed views are split the same way, in src/routes/index.jsx.
const EventModal = React.lazy(() => import('./components/EventModal'));
const ProfileEditModal = React.lazy(() => import('./components/ProfileEditModal'));

/**
 * Fallback for a route whose chunk is still arriving.
 *
 * The padding is inline with a spacing token rather than a new class, because
 * the signed-out and public branches render this OUTSIDE `.page` (which supplies
 * padding in the authenticated shell) and would otherwise show a skeleton flush
 * against the viewport edge.
 */
const RouteFallback = () => (
  <div style={{ padding: 'var(--s6)' }}><LoadingSkeleton heights={[200, 400]} /></div>
);

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
 * branches in AppShell — see the comment at the check itself.
 */
const AUTH_FLOW_PATHS = ['/oauth/callback', '/reset-password'];

/**
 * The toast queue, and the session everything else reads.
 *
 * `addToast` is passed into SessionProvider because the bootstrap has to be able
 * to report a partial load, and the queue itself is presentation that belongs
 * with the component rendering it.
 */
export default function App() {
  const [toasts, setToasts] = useState([]);

  const addToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  };
  const removeToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  return (
    <SessionProvider addToast={addToast}>
      <AppShell toasts={toasts} addToast={addToast} removeToast={removeToast} />
    </SessionProvider>
  );
}

function AppShell({ toasts, addToast, removeToast }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    currentUser, setCurrentUser, isCheckingSession, refresh: refreshAll, signOut,
    events, applications, favorites, refreshEvents, refreshApplications, toggleFavorite
  } = useSession();

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

  const handleCreateEvent = async (eventData) => {
    await api.createEvent(eventData);
    refreshEvents();
    navigate('/');
  };

  // Session teardown lives in SessionProvider.signOut; the menu this closes is
  // shell state, so it stays here.
  const handleLogout = async () => {
    setUserMenuOpen(false);
    await signOut();
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

  /**
   * A route's element with the shell props that route needs.
   *
   * The table in src/routes/index.jsx declares elements without props, because
   * the props close over this component's state and handlers. Cloning here keeps
   * the table readable as data instead of turning it into a second copy of the
   * shell.
   */
  const withProps = (route, propsByPath) => React.cloneElement(route.element, propsByPath[route.path]);

  if (AUTH_FLOW_PATHS.includes(currentPath)) {
    return (
      <>
        <React.Suspense fallback={<RouteFallback />}>
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
        </React.Suspense>
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

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
      <React.Suspense fallback={<RouteFallback />}>
        <Routes>
          {PUBLIC_ROUTES.map(route => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
        </Routes>
      </React.Suspense>
    );
  }

  if (!currentUser) {
    const signedOutProps = {
      '/welcome': {},
      '/login': {
        onLoginSuccess: (mode) => (mode === 'signup' ? navigate('/signup') : handleLoginSuccess()),
        addToast
      },
      '/signup': {
        onSignupSuccess: handleLoginSuccess,
        onBackToLogin: () => navigate('/login'),
        addToast
      }
    };

    return (
      <>
        <React.Suspense fallback={<RouteFallback />}>
        <Routes>
          {SIGNED_OUT_ROUTES.map(route => (
            <Route key={route.path} path={route.path} element={withProps(route, signedOutProps)} />
          ))}
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
        </React.Suspense>
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

  /** What each routed view in APP_ROUTES needs from the shell. */
  const appRouteProps = {
    '/events': {
      currentUser,
      applications,
      onViewDetails: openEventById,
      favorites,
      onToggleFavorite: toggleFavorite,
      /* Browse fetches its own server-filtered pages, so it no longer
         takes the index. Anything it renders is recorded so the event
         modal can resolve an event the index does not hold. */
      onEventsSeen: rememberEvents
    },
    '/events/new': { onSubmitEvent: handleCreateEvent, addToast, setActiveTab },
    '/events/:id/edit': {},
    '/checkin/:eventId': { currentUser },
    '/calendar': { currentUser, events, applications, onViewEvent: openEventById },
    '/notifications': { onViewEvent: openEventById, onCountChange: () => setNotifKey(k => k + 1) },
    '/messages': {},
    '/portfolio': { currentUser },
    '/settings': { currentUser, addToast, onProfileChange: refreshAll }
  };

  /** Where a route the user cannot reach sends them. Unchanged from the ternaries. */
  const denied = <Navigate to="/" replace />;

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
          {/* Inside the ErrorBoundary, so a chunk that fails to load is caught
              by the same boundary as a view that throws while rendering — and
              covering both arms of the ternary below, since the profile views
              are lazy too. */}
          <React.Suspense fallback={<RouteFallback />}>
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
              {/* `/` stays here rather than in the table: it is a different
                  dashboard per role, not one view behind a capability. */}
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

              {/* The route table. `requiredCap` is what the role ternaries that
                  used to sit here became; `requiresVerified` is the second
                  condition /events/new carried, which no capability expresses. */}
              {APP_ROUTES.map((route) => (
                <Route
                  key={route.path}
                  path={route.path}
                  element={
                    route.requiresVerified && !currentUser.verified
                      ? denied
                      : route.requiredCap
                        ? (
                          <Can user={currentUser} cap={route.requiredCap} fallback={denied}>
                            {withProps(route, appRouteProps)}
                          </Can>
                        )
                        : withProps(route, appRouteProps)
                  }
                />
              ))}

              {/* Also a different component per role, so it stays out of the
                  table alongside `/`. */}
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
                ) : denied
              } />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
          </React.Suspense>
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
          {/* `null` rather than a skeleton: the modal animates in over the page,
              and a skeleton shaped like a panel that is about to be replaced
              reads as a flicker. The chunk is small and usually already cached
              by the time anyone opens a second event. */}
          <React.Suspense fallback={null}>
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
            onToggleFavorite={toggleFavorite}
          />
          </React.Suspense>
        </ErrorBoundary>
      )}
      {editingProfile && (
        <React.Suspense fallback={null}>
          <ProfileEditModal
            user={currentUser}
            onClose={() => setEditingProfile(false)}
            onSave={(updated) => { setCurrentUser(updated); refreshEvents(); }}
            addToast={addToast}
            onSignOut={() => { setEditingProfile(false); handleLogout(); }}
          />
        </React.Suspense>
      )}

      <Toasts toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
