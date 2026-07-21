import React, { useState, useEffect, useRef } from 'react';
import { api } from './utils/api';
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
import {
  LayoutDashboard, Compass, CalendarPlus, ShieldCheck, LogOut, CalendarDays,
  UserCog, CheckCircle2, AlertTriangle, Info, X, ChevronsUpDown, Loader2, Bell, UserRound
} from 'lucide-react';

/* Navigation is defined once and filtered by role, so every role gets the
   same shell instead of a different one. */
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['student', 'organizer'] },
  { id: 'dashboard', label: 'Review queue', icon: ShieldCheck, roles: ['admin'] },
  { id: 'browse', label: 'Opportunities', icon: Compass, roles: ['student', 'organizer', 'admin'] },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, roles: ['student', 'organizer'] },
  { id: 'create', label: 'New event', icon: CalendarPlus, roles: ['organizer'], requiresVerified: true },
  { id: 'notifications', label: 'Notifications', icon: Bell, roles: ['student', 'organizer', 'admin'] },
  { id: 'profile', label: 'My profile', icon: UserRound, roles: ['student'] }
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [currentUser, setCurrentUser] = useState(null);
  const [events, setEvents] = useState([]);
  const [applications, setApplications] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [viewingProfile, setViewingProfile] = useState(null); // { type, id }
  const [notifKey, setNotifKey] = useState(0);
  const [editingProfile, setEditingProfile] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [authScreen, setAuthScreen] = useState('loading');
  const userMenuRef = useRef(null);

  // Verify JWT session on mount and reload data whenever state changes
  useEffect(() => {
    const validateSession = async () => {
      try {
        const user = await api.getMe();
        if (!user) {
          setCurrentUser(null);
          setAuthScreen('login');
          return;
        }
        setCurrentUser(user);
        setAuthScreen('app');
        
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
        setSelectedEvent(prev => (prev ? evs.find(e => e.id === prev.id) || null : null));
      } catch (err) {
        console.error('Session check failed:', err);
        setCurrentUser(null);
        setAuthScreen('login');
      }
    };
    validateSession();
  }, [refreshKey]);

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
    } catch (err) {
      addToast('Could not toggle favorite.', 'error');
    }
  };

  // Keep the active tab valid for the current role
  useEffect(() => {
    if (!currentUser) return;
    const allowed = NAV.filter(n => n.roles.includes(currentUser.role))
      .filter(n => !n.requiresVerified || currentUser.verified)
      .map(n => n.id);
    if (!allowed.includes(activeTab)) setActiveTab('dashboard');
  }, [currentUser, activeTab]);

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
  };

  const handleLogout = () => {
    api.logout();
    setCurrentUser(null);
    setAuthScreen('login');
    setActiveTab('dashboard');
    setEvents([]);
    setApplications([]);
    setUserMenuOpen(false);
  };

  const handleLoginSuccess = () => {
    setAuthScreen('app');
    handleStateChange();
  };

  /* ── Session check ─────────────────────────────────────────── */
  if (authScreen === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div className="stack-sm" style={{ alignItems: 'center' }}>
          <div className="brand-mark" style={{ width: 40, height: 40 }}>SB</div>
          <p className="small dim row" style={{ marginTop: 8 }}>
            <Loader2 size={13} className="spin" /> Signing you in…
          </p>
        </div>
      </div>
    );
  }

  if (authScreen === 'login') {
    return (
      <>
        <Login
          onLoginSuccess={(mode) => (mode === 'signup' ? setAuthScreen('signup') : handleLoginSuccess())}
          addToast={addToast}
        />
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  if (authScreen === 'signup') {
    return (
      <>
        <Signup
          onSignupSuccess={handleLoginSuccess}
          onBackToLogin={() => setAuthScreen('login')}
          addToast={addToast}
        />
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  if (!currentUser) return null;

  /* ── Application shell ─────────────────────────────────────── */
  const navItems = NAV
    .filter(n => n.roles.includes(currentUser.role))
    .filter(n => !n.requiresVerified || currentUser.verified);

  const meta = PAGE_META[currentUser.role]?.[activeTab] || { title: 'SBVolunteers', sub: '' };

  const pendingForMe = currentUser.role === 'organizer'
    ? applications.filter(a => a.status === 'pending' &&
        events.some(e => e.id === a.eventId && e.organizerId === currentUser.id)).length
    : 0;

  const openEventById = (eventId) => {
    const match = events.find(e => e.id === eventId);
    if (match) setSelectedEvent(match);
    else addToast('That event is no longer available.', 'info');
  };

  const viewVolunteer = (person) => {
    const id = typeof person === 'string' ? person : person?.id;
    if (id) setViewingProfile({ type: 'volunteer', id });
  };
  const viewOrganizer = (id) => id && setViewingProfile({ type: 'organizer', id });

  const renderPage = () => {
    // A profile takes over the content area until dismissed
    if (viewingProfile) {
      const back = () => setViewingProfile(null);
      return viewingProfile.type === 'organizer' ? (
        <OrganizerProfile
          userId={viewingProfile.id}
          onBack={back}
          onViewEvent={(id) => { back(); openEventById(id); }}
        />
      ) : (
        <VolunteerProfile
          userId={viewingProfile.id}
          currentUser={currentUser}
          onBack={back}
          onEditProfile={() => setEditingProfile(true)}
          onViewEvent={(id) => { back(); openEventById(id); }}
          addToast={addToast}
        />
      );
    }

    if (activeTab === 'notifications') {
      return (
        <Notifications
          onViewEvent={openEventById}
          onCountChange={() => setNotifKey(k => k + 1)}
        />
      );
    }

    if (activeTab === 'calendar') {
      return (
        <CalendarView
          currentUser={currentUser}
          events={events}
          applications={applications}
          onViewEvent={openEventById}
        />
      );
    }

    if (activeTab === 'profile' && currentUser.role === 'student') {
      return (
        <VolunteerProfile
          userId={currentUser.id}
          currentUser={currentUser}
          onEditProfile={() => setEditingProfile(true)}
          onViewEvent={openEventById}
          addToast={addToast}
        />
      );
    }

    if (activeTab === 'browse') {
      return (
        <BrowseEvents
          currentUser={currentUser}
          events={events}
          applications={applications}
          onViewDetails={setSelectedEvent}
          favorites={favorites}
          onToggleFavorite={handleToggleFavorite}
        />
      );
    }
    if (activeTab === 'create' && currentUser.role === 'organizer' && currentUser.verified) {
      return <CreateEvent onSubmitEvent={handleCreateEvent} addToast={addToast} setActiveTab={setActiveTab} />;
    }
    if (currentUser.role === 'admin') return <AdminDashboard addToast={addToast} />;
    if (currentUser.role === 'student') {
      return (
        <VolunteerDashboard
          currentUser={currentUser}
          events={events}
          applications={applications}
          addToast={addToast}
          setActiveTab={setActiveTab}
          onStateChange={handleStateChange}
          onViewDetails={setSelectedEvent}
        />
      );
    }
    return (
      <OrganizerDashboard
        currentUser={currentUser}
        events={events}
        applications={applications}
        onStateChange={handleStateChange}
        addToast={addToast}
        onViewDetails={setSelectedEvent}
        onViewVolunteerProfile={viewVolunteer}
        setActiveTab={setActiveTab}
      />
    );
  };

  return (
    <div className="app">
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* ── Sidebar (desktop / rail on tablet) ── */}
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(e) => { e.preventDefault(); setActiveTab('dashboard'); }}>
          <span className="brand-mark">SB</span>
          <span className="brand-text">
            <span className="brand-name">SBVolunteers</span>
            <span className="brand-sub">South Brunswick, NJ</span>
          </span>
        </a>

        <nav className="nav" aria-label="Main">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id + label}
              className="nav-item"
              aria-current={activeTab === id ? 'page' : undefined}
              onClick={() => { setViewingProfile(null); setActiveTab(id); }}
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
        <DemoBar currentUser={currentUser} onStateChange={handleStateChange} addToast={addToast} />

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
              onSeeAll={() => { setViewingProfile(null); setActiveTab('notifications'); }}
            />
          </div>
        </header>

        <main className="page" id="main-content" tabIndex={-1}>{renderPage()}</main>
      </div>

      {/* ── Mobile navigation ── */}
      <nav className="mobilenav" aria-label="Main">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id + label}
            className="mobilenav-item"
            aria-current={activeTab === id ? 'page' : undefined}
            onClick={() => { setViewingProfile(null); setActiveTab(id); }}
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
      {selectedEvent && (
        <EventModal
          event={selectedEvent}
          currentUser={currentUser}
          applications={applications}
          onClose={() => setSelectedEvent(null)}
          onStateChange={handleStateChange}
          addToast={addToast}
          onViewVolunteerProfile={(p) => { setSelectedEvent(null); viewVolunteer(p); }}
          onViewOrganizer={(id) => { setSelectedEvent(null); viewOrganizer(id); }}
          isFavorited={favorites.includes(selectedEvent.id)}
          onToggleFavorite={handleToggleFavorite}
        />
      )}
      {editingProfile && (
        <ProfileEditModal
          user={currentUser}
          onClose={() => setEditingProfile(false)}
          onSave={(updated) => { setCurrentUser(updated); handleStateChange(); }}
          addToast={addToast}
        />
      )}

      <Toasts toasts={toasts} onRemove={removeToast} />
    </div>
  );
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
