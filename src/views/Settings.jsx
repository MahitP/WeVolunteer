import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import SettingsSidebar from '../components/account/SettingsSidebar';
import SettingsSection from '../components/account/SettingsSection';
import NotificationPreferences from '../components/NotificationPreferences';
import DeleteAccountModal from '../components/account/DeleteAccountModal';
import DataExportCard from '../components/account/DataExportCard';
import ConnectedAccounts from '../components/account/ConnectedAccounts';
import PasswordCard from '../components/account/PasswordCard';
import TwoFactorSetup from '../components/account/TwoFactorSetup';
import ConfirmDialog from '../components/common/ConfirmDialog';
import EmailCard from '../components/account/EmailCard';
import UsernameCard from '../components/account/UsernameCard';
import { api } from '../utils/api';
import { useTheme } from '../hooks/useTheme';
import { APP_NAME, SCHOOL_NAME, SUPPORT_EMAIL, STUDENT_GUIDE_URL, ORGANIZER_GUIDE_URL } from '../config';
import { Sun, Moon, SunMoon, ExternalLink, Mail, Scale } from 'lucide-react';

export default function Settings({ currentUser, addToast, onProfileChange }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [confirmSignOutOthers, setConfirmSignOutOthers] = useState(false);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [leaderboardOptIn, setLeaderboardOptIn] = useState(Boolean(currentUser?.leaderboardOptIn));
  const [profileVisibility, setProfileVisibility] = useState(currentUser?.profileVisibility || 'private');
  const [friendActivityVisible, setFriendActivityVisible] = useState(currentUser?.friendActivityVisible !== false);

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
    setSigningOut(true);
    try {
      await api.signOutOtherDevices();
      addToast('Signed out on all your other devices.', 'success');
      setConfirmSignOutOthers(false);
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
  /**
   * One handler for both v1.3 privacy switches.
   *
   * Optimistic, with a rollback on failure, matching the leaderboard toggle
   * beside it — a switch that visibly moves and then silently did not save is
   * the worst outcome for a privacy control.
   */
  const savePrivacy = async (patch, setter, previous, message) => {
    setSavingPrivacy(true);
    try {
      await api.updateProfile(patch);
      onProfileChange?.();
      addToast(message, 'success');
    } catch (err) {
      setter(previous);
      addToast(err.message || 'Could not save that preference.', 'error');
    } finally {
      setSavingPrivacy(false);
    }
  };

  const handleVisibilityChange = (next) => {
    const previous = profileVisibility;
    setProfileVisibility(next);
    savePrivacy({ profileVisibility: next }, setProfileVisibility, previous,
      next === 'public' ? 'Your school and year are now visible on your profile.'
        : next === 'friends' ? 'Your school and year are visible to friends only.'
          : 'Your school and year are now hidden.');
  };

  const handleFriendActivityToggle = (next) => {
    const previous = friendActivityVisible;
    setFriendActivityVisible(next);
    savePrivacy({ friendActivityVisible: next }, setFriendActivityVisible, previous,
      next ? 'Friends will be told when you sign up for something.'
        : 'Friends will no longer be told when you sign up.');
  };

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
              {/**
                * The copy here used to say that only organizers and
                * administrators could see a profile. That stopped being true in
                * v1.3, when profiles became findable by every member — and a
                * privacy screen that describes a protection the product no
                * longer provides is worse than one that says nothing.
                *
                * What the setting now controls is which FIELDS are shown, not
                * whether the profile exists. That is stated plainly, including
                * the part students most need to know: the baseline is visible
                * either way.
                */}
              <div className="field">
                <label htmlFor="pv-select">Who can see my school and year?</label>
                <select
                  id="pv-select"
                  className="select"
                  value={profileVisibility}
                  disabled={savingPrivacy}
                  onChange={e => handleVisibilityChange(e.target.value)}
                >
                  <option value="private">Only me and school staff</option>
                  <option value="friends">My friends</option>
                  <option value="public">Any WeVolunteer member</option>
                </select>
                <span className="field-hint">
                  Your name, general area, hobbies, skills and volunteering totals are always
                  visible to signed-in members so they can find you. This setting controls your
                  school, year group and bio. Your email address is never shown to other students.
                </span>
              </div>
            </div>

            <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
              <h3 style={{ marginBottom: 'var(--s4)' }}>Friend activity</h3>
              <label className="row" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={friendActivityVisible}
                  disabled={savingPrivacy}
                  onChange={e => handleFriendActivityToggle(e.target.checked)}
                />
                <div className="stack-xs" style={{ flex: 1 }}>
                  <span className="strong">Tell my friends when I sign up for something</span>
                  <span className="dim small">
                    Friends you have accepted get a notification naming the opportunity, so they
                    can consider signing up too. It never says when or where you will be. Turning
                    this off stops the notification being created at all.
                  </span>
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
            <TwoFactorSetup currentUser={currentUser} addToast={addToast} />

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
              <button className="btn btn-danger" onClick={() => setConfirmSignOutOthers(true)} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out on all other devices'}
              </button>

              {confirmSignOutOthers && (
                <ConfirmDialog
                  title="Sign out everywhere else?"
                  confirmLabel="Sign out other devices"
                  destructive
                  busy={signingOut}
                  onConfirm={handleSignOutOthers}
                  onCancel={() => setConfirmSignOutOthers(false)}
                >
                  <p>
                    Anyone signed in as you on another phone, tablet or computer will be
                    signed out immediately.
                  </p>
                  <p className="dim small">This device stays signed in.</p>
                </ConfirmDialog>
              )}
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
      case 'help': {
        /**
         * Only real destinations are listed.
         *
         * This screen previously showed four `<a href="#">` items — Student
         * Guide, Organizer Guide, Report a Problem, About — every one of which
         * scrolled the page and did nothing. Next to "Report a Problem" in
         * particular, on a screen someone reaches when they are already stuck,
         * a control that silently fails is worse than an absent one.
         */
        const links = [
          STUDENT_GUIDE_URL && { label: 'Student guide', href: STUDENT_GUIDE_URL, external: true },
          ORGANIZER_GUIDE_URL && { label: 'Organizer guide', href: ORGANIZER_GUIDE_URL, external: true },
          SUPPORT_EMAIL && {
            label: 'Report a problem',
            href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${APP_NAME} problem report`)}`,
            external: false
          },
          /**
           * Unconditional, unlike the three above.
           *
           * The others depend on a school publishing a URL, and the comment above
           * explains why an unset one is omitted rather than shown dead. The Legal
           * Center has no such dependency — it is served by this application from
           * documents in this repository, so it is always a real destination.
           *
           * It also has to be reachable from somewhere durable. A user looking for
           * "what did I agree to" after signup has no other route to it: the
           * signup links are behind an account they already made.
           */
          { label: 'Terms, privacy and safety policies', href: '/legal', external: false, internal: true }
        ].filter(Boolean);

        return (
          <SettingsSection title="Help & Support" isMobile={isMobile} onBack={handleBack}>
            {links.length > 0 ? (
              <div className="card">
                <div className="nav">
                  {links.map(({ label, href, external, internal }, i) => (
                    <a
                      key={label}
                      className={`nav-item settings-help-link${i === links.length - 1 ? ' is-last' : ''}`}
                      href={href}
                      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    >
                      <span className="settings-help-label">{label}</span>
                      {/* The icon says what will happen: a new tab, an email
                          client, or a page in this app. Three destinations that
                          behave differently should not look identical. */}
                      {external
                        ? <ExternalLink size={16} className="dim" aria-label="Opens in a new tab" />
                        : internal
                          ? <Scale size={16} className="dim" aria-hidden="true" />
                          : <Mail size={16} className="dim" aria-hidden="true" />}
                    </a>
                  ))}
                </div>
              </div>
            ) : (
              <div className="card card-pad">
                <h3 className="stack-heading">Getting help</h3>
                <p className="dim small">
                  Your school has not published support links yet. Ask the staff member
                  who runs {APP_NAME} at your school — for volunteer shifts, the
                  organizer of the event is usually the fastest person to reach.
                </p>
              </div>
            )}

            <div className="card card-pad settings-card-spaced">
              <h3 className="stack-heading">About</h3>
              <p className="dim small">{APP_NAME} — volunteer coordination for {SCHOOL_NAME}.</p>
            </div>
          </SettingsSection>
        );
      }
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
