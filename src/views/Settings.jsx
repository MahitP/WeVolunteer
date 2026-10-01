import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
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
import AISettingsCard from '../components/account/AISettingsCard';
import AccessibilitySettingsCard from '../components/account/AccessibilitySettingsCard';
import { api } from '../utils/api';
import { useTheme } from '../hooks/useTheme';
import { APP_NAME, SCHOOL_NAME, STUDENT_GUIDE_URL, ORGANIZER_GUIDE_URL } from '../config';
import { can } from '../authz';
import { Sun, Moon, SunMoon, ExternalLink, Scale, Info, FileSignature, LifeBuoy } from 'lucide-react';
import InstallAppCard from '../components/account/InstallAppCard';

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
  /* Default 'public' to match the column default and the server's read rule:
     anything that is not exactly 'private' is public. A client that defaulted
     to 'private' would show the switch in a state the server disagrees with. */
  const [hoursVisibility, setHoursVisibility] = useState(currentUser?.hoursVisibility || 'public');
  const [certificatesVisibility, setCertificatesVisibility] =
    useState(currentUser?.certificatesVisibility || 'public');
  const [friendActivityVisible, setFriendActivityVisible] = useState(currentUser?.friendActivityVisible !== false);
  /* `null` means never asked, and it is not consent — so anything but an
     explicit `true` renders the switch off. */
  const [analyticsConsent, setAnalyticsConsent] = useState(currentUser?.analyticsConsent === true);

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

  const handleHoursVisibility = (next) => {
    const previous = hoursVisibility;
    setHoursVisibility(next);
    savePrivacy({ hoursVisibility: next }, setHoursVisibility, previous,
      next === 'public'
        ? 'Your service history is visible on your profile.'
        : 'Your service history is now only visible to you.');
  };

  const handleCertificatesVisibility = (next) => {
    const previous = certificatesVisibility;
    setCertificatesVisibility(next);
    savePrivacy({ certificatesVisibility: next }, setCertificatesVisibility, previous,
      next === 'public'
        ? 'Your certificates are visible on your profile.'
        : 'Your certificates are now only visible to you.');
  };

  const handleFriendActivityToggle = (next) => {
    const previous = friendActivityVisible;
    setFriendActivityVisible(next);
    savePrivacy({ friendActivityVisible: next }, setFriendActivityVisible, previous,
      next ? 'Friends will be told when you sign up for something.'
        : 'Friends will no longer be told when you sign up.');
  };

  /**
   * Consent to analytics.
   *
   * Sent as a real boolean rather than a coerced one — the server refuses
   * anything else, because a consent record that accepts `'false'` (truthy)
   * would store a yes nobody gave. `analyticsConsent` is `null` until it is
   * answered, and `null` is not consent, so the control starts off.
   */
  const handleAnalyticsToggle = (next) => {
    const previous = analyticsConsent;
    setAnalyticsConsent(next);
    savePrivacy({ analyticsConsent: next }, setAnalyticsConsent, previous,
      next
        ? 'Thank you — usage analytics are on. You can turn this off at any time.'
        : 'Analytics are off. Nothing more will be recorded.');
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
              
              {/**
                * `aria-pressed`, because `.active` is a colour.
                *
                * These three buttons are a mutually exclusive choice and the
                * selected one was marked only by a class. Sighted readers saw
                * which theme was on; assistive technology met three identically
                * named buttons with no indication which one was current, and a
                * keyboard user could not tell what pressing one would change.
                *
                * `aria-pressed` rather than a radiogroup: these are buttons that
                * take effect immediately, not a form choice to be submitted, and
                * converting them would mean rewriting working markup to gain
                * nothing a state does not already give.
                */}
              <div
                className="theme-options"
                role="group"
                aria-label="Theme"
                style={{ display: 'flex', gap: 'var(--s4)', flexWrap: 'wrap' }}
              >
                {['light', 'system', 'dark'].map((t) => (
                  <button 
                    key={t}
                    type="button"
                    aria-pressed={theme === t}
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
            {/* "Add to Home Screen" (ruling 9). Renders nothing on a browser
                that offers no install and is not an iPhone or iPad. */}
            <InstallAppCard />
          </SettingsSection>
        );
      case 'accessibility':
        return (
          <SettingsSection title="Accessibility" isMobile={isMobile} onBack={handleBack}>
            <AccessibilitySettingsCard />
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
              <h3 style={{ marginBottom: 'var(--s4)' }}>Usage analytics</h3>
              {/**
                * Off unless someone says otherwise.
                *
                * The other switches on this screen control who among PEOPLE can
                * see something. This one controls whether an outside company
                * sees anything at all, which is a different kind of question and
                * is why the copy names the company rather than saying
                * "analytics" and leaving the reader to guess who has the data.
                *
                * There is deliberately no prompt, banner or nudge anywhere in
                * the app. A consent control that chases people produces consent
                * from people who wanted the dialog to go away, and on a platform
                * whose users are minors that is worth less than no data.
                */}
              <label className="row" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={analyticsConsent}
                  disabled={savingPrivacy}
                  onChange={e => handleAnalyticsToggle(e.target.checked)}
                />
                <div className="stack-xs" style={{ flex: 1 }}>
                  <span className="strong">Help improve WeVolunteer</span>
                  <span className="dim small">
                    Shares how you use the app — the pages you open and a recording of what
                    the screen looked like — with Amplitude, an analytics company, so we can
                    find what is confusing or broken. Your name, email and messages are never
                    sent, and text on the page is hidden before the recording leaves your
                    device. <strong>Off unless you turn it on</strong>, and turning it off
                    stops the recording straight away. See the{' '}
                    <Link to="/legal/cookie-and-tracking-notice">Cookie and Tracking Notice</Link>.
                  </span>
                </div>
              </label>
            </div>

            {/**
              * Sits with the privacy controls because every question it raises
              * is a privacy question: what is downloaded, from whom, what stays
              * on the device, and how to remove it.
              *
              * Unlike its neighbours, its settings never reach the server —
              * they describe this browser, not what other people can see.
              * Renders nothing at all in a build without VITE_LOCAL_AI.
              */}
            <AISettingsCard addToast={addToast} />

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
              <h3 style={{ marginBottom: 'var(--s4)' }}>Your service record</h3>
              {/**
                * Two questions, two answers.
                *
                * They are separate because they disclose different things. The
                * hours are a total; a certificate carries a full name, the
                * organization that issued it and the dates somebody was there.
                * A student may reasonably want the school to see one and not
                * the other, in either direction.
                *
                * Both default to "Anyone at your school" — that is what the
                * column defaults to and what the server treats an unset value
                * as, so the control cannot show a state the server disagrees
                * with. The wording says who, rather than "allow others to…",
                * because the existing visibility control on this same screen
                * asks "Who can see my school and year?" and a screen that asks
                * the same question two ways is a screen that gets misread.
                */}
              <div className="field">
                <label htmlFor="hours-visibility">Who can see my service history?</label>
                <select
                  id="hours-visibility"
                  className="select"
                  value={hoursVisibility}
                  disabled={savingPrivacy}
                  onChange={e => handleHoursVisibility(e.target.value)}
                >
                  <option value="public">Anyone at your school</option>
                  <option value="private">Only me</option>
                </select>
                <span className="field-hint">
                  Your total hours, the kinds of service you have done, and the badges you have
                  earned. The individual events you attended — where you were and when — are
                  never shown to other students, whichever you choose.
                </span>
              </div>

              <div className="field" style={{ marginTop: 'var(--s4)' }}>
                <label htmlFor="certificates-visibility">Who can see my certificates?</label>
                <select
                  id="certificates-visibility"
                  className="select"
                  value={certificatesVisibility}
                  disabled={savingPrivacy}
                  onChange={e => handleCertificatesVisibility(e.target.value)}
                >
                  <option value="public">Anyone at your school</option>
                  <option value="private">Only me</option>
                </select>
                <span className="field-hint">
                  Other people can see which certificates you have earned. Only you can open or
                  print one, and only you can see your transcript.
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
          /**
           * An in-app page, not a `mailto:`.
           *
           * This was `mailto:support@…`. The markup was correct and nothing
           * intercepted it — but a `mailto:` does something only if the reader's
           * device has a mail client registered for the scheme, and on a school
           * Chromebook or a browser where webmail was never made the handler,
           * clicking it does nothing whatsoever. No error, no window, nothing.
           *
           * On the screen somebody reaches when they are already stuck, a
           * control that silently does nothing is the worst outcome available —
           * which is the same reasoning the comment above gives for removing the
           * four dead `href="#"` links this list used to contain.
           *
           * Unconditional, unlike the guide links: the destination is served by
           * this application, so it is always real.
           */
          {
            label: 'Report a problem',
            description: 'Something broken, confusing, wrong, or unsafe',
            href: '/report-issue',
            internal: true,
            Icon: LifeBuoy
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
           *
           * ── One entry, named for the destination ──
           *
           * This read "Terms, privacy and safety policies" — a list of contents
           * standing in for a place. The page it opens has been a hub with ten
           * documents, its own search and its own grouping since v1.2; naming it
           * after three of its documents made the other seven invisible from the
           * only durable route to them, and left the product with no word for the
           * thing it actually built. The description line carries the examples
           * now, which is where an example belongs.
           */
          {
            label: 'Legal Center',
            description: 'View our Terms, Privacy Policy, and other legal documents.',
            href: '/legal', internal: true, Icon: Scale
          },
          /**
           * Owner only, and hidden rather than disabled for everyone else.
           *
           * `can()` here is UX — it decides whether a link is drawn. The route
           * refuses anyone without `legal.edit`, and so does every endpoint the
           * page calls; `legal.edit` is SUPER_ONLY, so it cannot even be granted.
           * A reader who guesses the URL gets a refusal from the server, not from
           * this array.
           *
           * Placed directly beneath the Legal Center rather than at the end of
           * the list, because it edits the entry above it and a control separated
           * from its subject has to be explained. Kept out of the primary
           * navigation for the same reason the six other owner pages are: a rail
           * entry that renders for one account on the platform is clutter for
           * everybody else.
           */
          can(currentUser, 'legal.edit') && {
            label: 'Edit Legal Center',
            description: 'Owner access — publish new versions of these documents.',
            href: '/admin/legal', internal: true, Icon: FileSignature
          },
          /**
           * ── One About Us, and not a heart ──
           *
           * `Heart` was the wrong glyph twice over. It reads as "favourite" or
           * "like" everywhere else in this product's vocabulary — `BrowseEvents`
           * uses a heart for starring an opportunity — so the same shape meant
           * two different things on two screens, and on this one it meant the
           * one it does NOT do: nothing here is saved, liked or favourited.
           * `Info` says what the destination is, and sits in the same outline
           * family as `Scale` above it, which is what makes the two read as a
           * pair of places rather than as a place and a decoration.
           *
           * There is exactly ONE entry pointing at `/about`, asserted in
           * Settings.help.test.jsx. Two links to one destination in a list this
           * short is the kind of thing that arrives when a section is edited
           * twice and nobody re-reads the whole array.
           */
          {
            label: 'About Us',
            description: 'Why WeVolunteer exists, and what we are trying to do.',
            href: '/about', internal: true, Icon: Info
          }
        ].filter(Boolean);

        return (
          <SettingsSection title="Help & Support" isMobile={isMobile} onBack={handleBack}>
            {links.length > 0 ? (
              <div className="card">
                <div className="nav">
                  {links.map(({ label, description, href, external, internal, Icon }, i) => {
                    /**
                     * Internal destinations are client-side navigations.
                     *
                     * They were `<a href>` and did a full page reload — a blank
                     * screen and a fresh bundle parse to move between two screens
                     * of the same app. Harmless on a laptop, and the reason the
                     * Legal Center felt slow on the phones most of these readers
                     * are holding.
                     */
                    const Tag = internal ? Link : 'a';
                    const target = internal ? { to: href } : { href };
                    return (
                      <Tag
                        key={label}
                        className={`nav-item settings-help-link${i === links.length - 1 ? ' is-last' : ''}`}
                        {...target}
                        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                      >
                        <span className="settings-help-text">
                          <span className="settings-help-label">{label}</span>
                          {/* The second line is not decoration: "Legal Center" and
                              "About Us" are both places, and without it the only
                              way to learn which one holds the Privacy Policy is to
                              open both. */}
                          {description && (
                            <span className="settings-help-description">{description}</span>
                          )}
                        </span>
                        {/* The icon says what will happen: a new tab, an email
                            client, or a page in this app. Three destinations that
                            behave differently should not look identical. */}
                        {external
                          ? <>
                              {/* The text carries it, not the icon. lucide renders a
                                  bare <svg>, and whether an aria-label on one is
                                  exposed varies by browser — VoiceOver drops it. The
                                  new-tab warning is the part of this row that must
                                  survive that. */}
                              <span className="sr-only">Opens in a new tab</span>
                              <ExternalLink size={16} className="dim" aria-hidden="true" />
                            </>
                          : <Icon size={16} className="dim" aria-hidden="true" />}
                      </Tag>
                    );
                  })}
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

            {/**
              * "This community", not "About".
              *
              * This card predates the About Us page and was headed "About". Now
              * that an "About Us" row sits directly above it, two adjacent things
              * called About is a reader asking which one is which — and the answer
              * is unguessable, because the row is a link to prose about the product
              * and the card is a static line naming which school this installation
              * serves. Retitled for what it actually says rather than removed: the
              * community name appears nowhere else in Settings.
              */}
            <div className="card card-pad settings-card-spaced">
              <h3 className="stack-heading">This community</h3>
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
