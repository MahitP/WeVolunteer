import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import SettingsSidebar from '../components/account/SettingsSidebar';
import SettingsSection from '../components/account/SettingsSection';
import NotificationPreferences from '../components/NotificationPreferences';
import DeleteAccountModal from '../components/account/DeleteAccountModal';
import DataExportCard from '../components/account/DataExportCard';
import ConnectedAccounts from '../components/account/ConnectedAccounts';
import PasswordCard from '../components/account/PasswordCard';
import EmailCard from '../components/account/EmailCard';
import UsernameCard from '../components/account/UsernameCard';
import { api } from '../utils/api';
import { useTheme } from '../hooks/useTheme';
import { Sun, Moon, SunMoon, ExternalLink } from 'lucide-react';

export default function Settings({ currentUser, addToast, onProfileChange }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [leaderboardOptIn, setLeaderboardOptIn] = useState(Boolean(currentUser?.leaderboardOptIn));

  useEffect(() => {
    setLeaderboardOptIn(Boolean(currentUser?.leaderboardOptIn));
  }, [currentUser?.leaderboardOptIn]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const activeSection = searchParams.get('section') || (isMobile ? null : 'appearance');

  const handleSelectSection = (sectionId) => {
    setSearchParams({ section: sectionId });
  };

  const handleBack = () => {
    setSearchParams({});
  };

  /**
   * Actually invalidate other sessions.
   *
   * The previous handler's whole body was `addToast('Signed out of all other
   * devices', 'success')` inside a try/catch that could not throw. Someone
   * acting on a suspicion that another person had their session was told it
   * had been dealt with, and nothing had happened — the worst possible outcome
   * for a security control, because it stops them taking a real step.
   */
  const handleSignOutOthers = async () => {
    const confirmed = window.confirm(
      'Sign out everywhere else?\n\nAnyone signed in as you on another phone, tablet or computer '
      + 'will be signed out immediately. This device stays signed in.'
    );
    if (!confirmed) return;

    setSigningOut(true);
    try {
      await api.signOutOtherDevices();
      addToast('Signed out on all your other devices.', 'success');
    } catch (err) {
      addToast(err.message || 'Could not sign out your other devices. Please try again.', 'error');
    } finally {
      setSigningOut(false);
    }
  };

  /**
   * The leaderboard toggle was an uncontrolled `defaultChecked` checkbox
   * wired to nothing: it always rendered as on regardless of the account's
   * real setting, and moving it saved nothing. For a control that governs
   * whether a minor's name and hours appear on a public board, showing the
   * wrong state is worse than showing no control.
   */
  const handleLeaderboardToggle = async (nextValue) => {
    const previous = leaderboardOptIn;
    setLeaderboardOptIn(nextValue);
    setSavingPrivacy(true);
    try {
      await api.updateProfile({ leaderboardOptIn: nextValue });
      onProfileChange?.();
      addToast(nextValue ? 'Your hours can now appear on the leaderboard.' : 'Your hours are hidden from the leaderboard.', 'success');
    } catch (err) {
      setLeaderboardOptIn(previous);
      addToast(err.message || 'Could not save that preference.', 'error');
    } finally {
      setSavingPrivacy(false);
    }
  };

  const renderSection = () => {
    switch (activeSection) {
      case 'account':
        return (
          <SettingsSection title="Account" isMobile={isMobile} onBack={handleBack}>
            <EmailCard currentUser={currentUser} addToast={addToast} onProfileChange={onProfileChange} />
            <UsernameCard currentUser={currentUser} addToast={addToast} onProfileChange={onProfileChange} />
          </SettingsSection>
        );
      case 'appearance':
        return (
          <SettingsSection title="Appearance" isMobile={isMobile} onBack={handleBack}>
            <div className="card card-pad">
              <h3 style={{ marginBottom: 'var(--s2)' }}>Theme</h3>
              <p className="dim" style={{ marginBottom: 'var(--s4)' }}>Choose how WeVolunteer looks to you.</p>
              
              <div className="theme-options" style={{ display: 'flex', gap: 'var(--s4)', flexWrap: 'wrap' }}>
                {['light', 'system', 'dark'].map((t) => (
                  <button 
                    key={t}
                    className={`theme-option ${theme === t ? 'active' : ''}`}
                    onClick={() => setTheme(t)}
                  >
                    <div className="theme-option-icon">
                      {t === 'light' ? <Sun size={24} /> : t === 'dark' ? <Moon size={24} /> : <SunMoon size={24} />}
                    </div>
                    <span style={{ textTransform: 'capitalize', fontWeight: 500 }}>{t}</span>
                  </button>
                ))}
              </div>
            </div>
          </SettingsSection>
        );
      case 'notifications':
        return (
          <SettingsSection title="Notifications" isMobile={isMobile} onBack={handleBack}>
            <NotificationPreferences addToast={addToast} />
          </SettingsSection>
        );
      case 'privacy':
        return (
          <SettingsSection title="Privacy" isMobile={isMobile} onBack={handleBack}>
            <div className="card card-pad">
              <h3 style={{ marginBottom: 'var(--s4)' }}>Leaderboard visibility</h3>
              <label className="row" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={leaderboardOptIn}
                  disabled={savingPrivacy}
                  onChange={e => handleLeaderboardToggle(e.target.checked)}
                />
                <div className="stack-xs" style={{ flex: 1 }}>
                  <span className="strong">Show my volunteer hours publicly</span>
                  <span className="dim small">
                    Adds your name and total hours to the school leaderboard. Off by default —
                    turning it off again removes you immediately.
                  </span>
                </div>
              </label>
            </div>

            <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
              <h3 style={{ marginBottom: 'var(--s4)' }}>Profile visibility</h3>
              <label className="row" style={{ alignItems: 'flex-start' }}>
                <div className="stack-xs" style={{ flex: 1 }}>
                  <span className="strong">Who can view my information?</span>
                  <span className="dim small">Only verified organizers and school administrators can view your full profile and contact information. Other students can only see your name and avatar on shared shifts.</span>
                </div>
              </label>
            </div>

            <DataExportCard addToast={addToast} />
          </SettingsSection>
        );
      case 'security':
        return (
          <SettingsSection title="Security" isMobile={isMobile} onBack={handleBack}>
            <PasswordCard currentUser={currentUser} addToast={addToast} />

            <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
              <h3 style={{ marginBottom: 'var(--s2)' }}>Sessions</h3>
              {/*
                No per-device list. The old card showed a hardcoded
                "Mac OS • Web Browser • Active now" row to everyone regardless
                of what they were actually using, and the server keeps no
                session records to build a real one from — sessions are
                stateless JWTs invalidated in bulk by token_version. Inventing
                device rows on a security screen is worse than omitting them.
              */}
              <p className="dim small" style={{ marginBottom: 'var(--s4)' }}>
                If you have signed in on a shared or lost device, sign out everywhere else.
                You will stay signed in here.
              </p>
              <button className="btn btn-danger" onClick={handleSignOutOthers} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out on all other devices'}
              </button>
            </div>

            <ConnectedAccounts addToast={addToast} currentUser={currentUser} />

            <div className="card card-pad" style={{ marginTop: 'var(--s4)', border: '1px solid var(--warn-border)' }}>
              <h3 style={{ marginBottom: 'var(--s4)', color: 'var(--warn-ink)' }}>Danger Zone</h3>

              <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="stack-xs" style={{ flex: 1, marginRight: 'var(--s4)' }}>
                  <span className="strong" style={{ color: 'var(--warn-ink)' }}>Delete account</span>
                  <span className="dim small">Permanently remove your account and personal information.</span>
                </div>
                <button className="btn btn-danger" onClick={() => setShowDeleteModal(true)}>
                  Delete Account
                </button>
              </div>
            </div>

            {showDeleteModal && (
              <DeleteAccountModal
                onClose={() => setShowDeleteModal(false)}
                hasPassword={currentUser?.hasPassword}
                username={currentUser?.username}
                onSuccess={() => {
                  window.location.href = '/login';
                }}
              />
            )}
          </SettingsSection>
        );
      case 'messaging':
        return (
          <SettingsSection title="Messaging" isMobile={isMobile} onBack={handleBack}>
            {/*
              This card held three `defaultChecked` checkboxes — message
              notifications, read receipts and typing indicators — none of
              which was wired to anything. All three always rendered as on
              whatever the account's real setting was, and moving one saved
              nothing.

              Message notifications are a real preference and now live with
              every other one under Notifications, driven by the same
              /api/user/preferences endpoint. Read receipts and typing
              indicators have no server-side support at all, so they are gone
              rather than mocked: a privacy control that claims to be off while
              being on is worse than no control.
            */}
            <div className="card card-pad">
              <h3 style={{ marginBottom: 'var(--s2)' }}>Message alerts</h3>
              <p className="dim small" style={{ marginBottom: 'var(--s4)' }}>
                Choose how you hear about new direct messages alongside your other notifications.
              </p>
              <button className="btn btn-secondary" onClick={() => handleSelectSection('notifications')}>
                Open notification settings
              </button>
            </div>
          </SettingsSection>
        );
      case 'help':
        return (
          <SettingsSection title="Help & Support" isMobile={isMobile} onBack={handleBack}>
            <div className="card">
              <div className="nav">
                <a href="#" className="nav-item" style={{ padding: 'var(--s4)', borderRadius: 0, borderBottom: '1px solid var(--rule)' }}>
                  <span style={{ flex: 1, color: 'var(--ink)' }}>Student Guide</span>
                  <ExternalLink size={16} className="dim" />
                </a>
                <a href="#" className="nav-item" style={{ padding: 'var(--s4)', borderRadius: 0, borderBottom: '1px solid var(--rule)' }}>
                  <span style={{ flex: 1, color: 'var(--ink)' }}>Organizer Guide</span>
                  <ExternalLink size={16} className="dim" />
                </a>
                <a href="#" className="nav-item" style={{ padding: 'var(--s4)', borderRadius: 0, borderBottom: '1px solid var(--rule)' }}>
                  <span style={{ flex: 1, color: 'var(--ink)' }}>Report a Problem</span>
                  <ExternalLink size={16} className="dim" />
                </a>
                <a href="#" className="nav-item" style={{ padding: 'var(--s4)', borderRadius: 0 }}>
                  <span style={{ flex: 1, color: 'var(--ink)' }}>About WeVolunteer</span>
                  <ExternalLink size={16} className="dim" />
                </a>
              </div>
            </div>
          </SettingsSection>
        );
      default:
        return null;
    }
  };

  return (
    <div className="settings-layout">
      <SettingsSidebar 
        activeSection={activeSection} 
        onSelectSection={handleSelectSection} 
        isMobile={isMobile}
        showSidebarOnMobile={!activeSection}
      />
      <div className="settings-content">
        {(!isMobile || activeSection) && renderSection()}
      </div>
    </div>
  );
}
