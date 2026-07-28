import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, useNavigate, useLocation, useSearchParams, Navigate, useParams } from 'react-router-dom';
import { api } from './utils/api';
import { DEMO_MODE, APP_NAME, SCHOOL_NAME } from './config';
import DemoBar from './components/DemoBar';
import Login from './views/Login';
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
import ErrorBoundary from './components/ErrorBoundary';
import CertificateVerification from './views/CertificateVerification';
import VolunteerPortfolio from './views/VolunteerPortfolio';
import CheckInView from './views/CheckInView';
import {
  LayoutDashboard, Compass, CalendarPlus, ShieldCheck, LogOut, CalendarDays,
  UserCog, CheckCircle2, AlertTriangle, Info, X, ChevronsUpDown, Loader2, Bell, UserRound
} from 'lucide-react';

/* Navigation is defined once and filtered by role, so every role gets the
   same shell instead of a different one. */
const NAV = [
  { id: 'dashboard', path: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['student', 'organizer'] },
  { id: 'dashboard', path: '/', label: 'Review queue', icon: ShieldCheck, roles: ['admin'] },
  { id: 'browse', path: '/events', label: 'Opportunities', icon: Compass, roles: ['student', 'organizer', 'admin'] },
  { id: 'calendar', path: '/calendar', label: 'Calendar', icon: CalendarDays, roles: ['student', 'organizer'] },
  { id: 'create', path: '/events/new', label: 'New event', icon: CalendarPlus, roles: ['organizer'], requiresVerified: true },
  { id: 'notifications', path: '/notifications', label: 'Notifications', icon: Bell, roles: ['student', 'organizer', 'admin'] },
  { id: 'profile', path: '/profile', label: 'My profile', icon: UserRound, roles: ['student'] }
];

const PAGE_META = {
  student: {
    dashboard: { title: 'My volunteering', sub: 'Your shifts, hours, and history' },
    browse: { title: 'Opportunities', sub: 'Find a shift and apply — organizers confirm who attends' },
    calendar: { title: 'Calendar', sub: 'Your shifts and the deadlines that matter' },
    notifications: { title: 'Notifications', sub: 'Replies, reminders, and event updates' },
    profile: { title: 'My profile', sub: 'Your service record, milestones, and certificates' }
  },
  organizer: {
    dashboard: { title: 'My events', sub: 'Manage sign-ups, applicants, and attendance' },
    browse: { title: 'Opportunities', sub: 'Everything posted across the district' },
    calendar: { title: 'Calendar', sub: 'Events you host and when applications close' },
    create: { title: 'New event', sub: 'Build a sign-up sheet with dates and shifts' },
    notifications: { title: 'Notifications', sub: 'Applications, questions, and updates' }
  },
  admin: {
    dashboard: { title: 'Review queue', sub: 'Approve organizers and moderate events' },
    browse: { title: 'All events', sub: 'Everything posted across the district' },
    notifications: { title: 'Notifications', sub: 'Platform activity' }
  }
};

const ROLE_LABEL = { admin: 'Administrator', organizer: 'Organizer', student: 'Volunteer' };

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [currentUser, setCurrentUser] = useState(null);
  const [events, setEvents] = useState([]);
  const [applications, setApplications] = useState([]);
  const [favorites, setFavorites] = useState([]);
  
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

  // Derived state from URL
  const selectedEventId = searchParams.get('event');
  const selectedEvent = selectedEventId ? events.find(e => e.id === selectedEventId) || null : null;
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

  // Verify JWT session on mount and reload data whenever state changes
  useEffect(() => {
    const validateSession = async () => {
      try {
        if (searchParams.has('verify')) {
          const token = searchParams.get('verify');
          
          // Clear it from URL immediately
          const newParams = new URLSearchParams(searchParams);
          newParams.delete('verify');
          setSearchParams(newParams, { replace: true });
          
          try {
            await api.verifyEmail(token);
            addToast('Email verified successfully!', 'success');
          } catch (err) {
            addToast(err.message || 'Failed to verify email', 'error');
          }
        }

        const user = await api.getMe();
        if (!user) {
          setCurrentUser(null);
          setIsCheckingSession(false);
          return;
        }
        setCurrentUser(user);
        
        const promises = [api.fetchEvents(), api.fetchApplications()];
        if (user.role === 'student') {
          promises.push(api.fetchFavorites().catch(() => []));
        }

        const [evs, apps, favs] = await Promise.all(promises);
        setEvents(evs);
        setApplications(apps);
        if (user.role === 'student' && favs) {
          setFavorites(favs.map(f => f.event_id || f.eventId));
        }
        setIsCheckingSession(false);
      } catch (err) {
        console.error('Session check failed:', err);
        setCurrentUser(null);
        setIsCheckingSession(false);
      }
    };
    validateSession();
  }, [refreshKey, searchParams, setSearchParams]);

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

  const handleStateChange = () => setRefreshKey(prev => prev + 1);

  const addToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  };
  const removeToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  const handleCreateEvent = async (eventData) => {
    await api.createEvent(eventData);
    handleStateChange();
    navigate('/');
  };

  const handleLogout = async () => {
    await api.logout();
    setCurrentUser(null);
    setEvents([]);
    setApplications([]);
    setUserMenuOpen(false);
    navigate('/login');
  };

  const handleLoginSuccess = () => {
    handleStateChange();
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
    const match = id && events.find(e => e.id === id);
    if (match) setSelectedEventState(id);
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
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div className="stack-sm" style={{ alignItems: 'center' }}>
          <div className="brand-mark" style={{ width: 40, height: 40 }}>WV</div>
          <p className="small dim row" style={{ marginTop: 8 }}>
            <Loader2 size={13} className="spin" /> Loading…
          </p>
        </div>
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

  if (!currentUser) {
    return (
      <>
        <Routes>
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
          <Route path="/reset-password" element={
            <ResetPassword
              token={searchParams.get('token')}
              onSuccess={() => {
                addToast('Password updated successfully. Please sign in.', 'success');
                navigate('/login');
              }}
              onCancel={() => navigate('/login')}
            />
          } />
          <Route
            path="*"
            element={
              searchParams.has('reset')
                ? <Navigate to={`/reset-password?token=${encodeURIComponent(searchParams.get('reset'))}`} replace />
                : <Navigate to="/login" replace />
            }
          />
        </Routes>
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  if (!currentUser.emailVerified) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 'var(--s4)' }}>
        <div className="card" style={{ maxWidth: 440, width: '100%', textAlign: 'center', padding: 'var(--s6)' }}>
          <div className="brand-mark" style={{ width: 48, height: 48, margin: '0 auto var(--s5)' }}>WV</div>
          <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--s3)' }}>Verify your email</h1>
          <p className="lead" style={{ marginBottom: 'var(--s5)' }}>
            We've sent a verification link to <strong>{currentUser.email}</strong>.
            Please click the link to verify your account and continue.
          </p>
          <button 
            className="btn btn-primary btn-block"
            onClick={async (e) => {
              const btn = e.target;
              btn.disabled = true;
              btn.textContent = 'Sending...';
              try {
                await api.resendVerification();
                addToast('Verification email resent', 'success');
              } catch (err) {
                addToast(err.message || 'Failed to resend email', 'error');
              } finally {
                btn.disabled = false;
                btn.textContent = 'Resend verification email';
              }
            }}
          >
            Resend verification email
          </button>
          
          <button 
            className="btn btn-text btn-block" 
            style={{ marginTop: 'var(--s3)' }}
            onClick={handleLogout}
          >
            Sign out
          </button>
        </div>
        <Toasts toasts={toasts} onRemove={removeToast} />
      </div>
    );
  }

  /* ── Application shell ─────────────────────────────────────── */
  const navItems = NAV
    .filter(n => n.roles.includes(currentUser.role))
    .filter(n => !n.requiresVerified || currentUser.verified);

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
          <div className="usermenu" ref={userMenuRef}>
            <button
              className="userchip"
              onClick={() => setUserMenuOpen(o => !o)}
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
            >
              <span className="avatar">{currentUser.avatar || '👤'}</span>
              <span className="userchip-text truncate">
                <span className="userchip-name truncate">{currentUser.name}</span>
                <span className="userchip-role">
                  {currentUser.role === 'organizer' && !currentUser.verified
                    ? 'Pending approval'
                    : ROLE_LABEL[currentUser.role]}
                </span>
              </span>
              <ChevronsUpDown size={13} style={{ marginLeft: 'auto', color: 'var(--ink-3)' }} />
            </button>

            {userMenuOpen && (
              <div className="popover menu" role="menu" style={{ bottom: '100%', left: 0, right: 0, marginBottom: 6 }}>
                <button className="menu-item" role="menuitem" onClick={() => { setEditingProfile(true); setUserMenuOpen(false); }}>
                  <UserCog size={15} /> Edit profile
                </button>
                <div className="menu-sep" />
                <button className="menu-item danger" role="menuitem" onClick={handleLogout}>
                  <LogOut size={15} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ── Content column ── */}
      <div className="content">
        {DEMO_MODE && (
          <DemoBar currentUser={currentUser} onStateChange={handleStateChange} addToast={addToast} />
        )}

        <header className="topbar">
          <div className="truncate">
            <h1 className="topbar-title truncate">{meta.title}</h1>
            {meta.sub && <div className="topbar-sub truncate">{meta.sub}</div>}
          </div>
          <div className="topbar-actions">
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
                    onStateChange={handleStateChange}
                    onViewDetails={openEventById}
                  />
                ) : (
                  <OrganizerDashboard
                    currentUser={currentUser}
                    events={events}
                    applications={applications}
                    onStateChange={handleStateChange}
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
                  events={events}
                  applications={applications}
                  onViewDetails={openEventById}
                  favorites={favorites}
                  onToggleFavorite={handleToggleFavorite}
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
              
              <Route path="/profile" element={
                currentUser.role === 'student' ? (
                  <VolunteerProfile
                    userId={currentUser.id}
                    currentUser={currentUser}
                    onEditProfile={() => setEditingProfile(true)}
                    onViewEvent={openEventById}
                    addToast={addToast}
                  />
                ) : <Navigate to="/" replace />
              } />
              
              <Route path="/portfolio" element={
                currentUser.role === 'student' ? (
                  <VolunteerPortfolio currentUser={currentUser} />
                ) : <Navigate to="/" replace />
              } />
              
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
          </ErrorBoundary>
        </main>
      </div>

      {/* ── Mobile navigation ── */}
      <nav className="mobilenav" aria-label="Main">
        {navItems.map(({ id, path, label, icon: Icon }) => (
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
        {currentUser.role !== 'student' && (
          <button className="mobilenav-item" onClick={() => setEditingProfile(true)}>
            <UserCog size={19} strokeWidth={2} />
            Profile
          </button>
        )}
      </nav>

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
            onStateChange={handleStateChange}
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
          onSave={(updated) => { setCurrentUser(updated); handleStateChange(); }}
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
