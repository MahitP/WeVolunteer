import React, { useState, useRef, useEffect } from 'react';
import { UserRound, Bell, LogOut, ChevronsUpDown } from 'lucide-react';
import { can } from '../../authz';
import { ACCOUNT_MENU_ITEMS } from '../../accountMenu';
import { useNavigate } from 'react-router-dom';

/**
 * How a role is named in the sidebar chip.
 *
 * A lookup keyed by role — the correct way to *label* a role, as opposed to
 * comparing one. Deliberately still separate from App.jsx's ROLE_LABEL: the two
 * disagree on `student` ('Student' here, 'Volunteer' in the mobile sheet) and
 * merging them would change what a student reads in one of the two places.
 *
 * Every role in ROLES has an entry, so the `||` below is defence rather than
 * the silent default that rendered the platform owner as "Volunteer".
 */
const ROLE_LABEL = {
  admin: 'Administrator',
  organizer: 'Organizer',
  student: 'Student',
  super_admin: 'Platform administrator',
  partner: 'Partner'
};

/**
 * The picture, or the emoji when the picture will not display.
 *
 * ── Why there is a fallback at all ──
 *
 * "I can edit my avatar successfully, but it does not appear in the bottom-left
 * corner." The picture had been written to a directory nothing served, so the URL
 * resolved to Vite's SPA fallback — 200, `content-type: text/html`. An `<img>`
 * handed HTML fires `error` and draws nothing, and with no handler on it that is
 * the end of the story: an empty circle, no emoji, no message, and nothing on
 * screen connecting the empty corner to a profile screen that had just reported
 * success.
 *
 * The serving defect is fixed on the server (server/app.js mounts `/uploads` in
 * every environment now, from the same constant the upload handler writes to).
 * This stays because "the picture will not load" has more causes than that one:
 * an offline moment, a deployment whose uploads directory did not come across, a
 * file removed behind the user's back. The emoji is the declared fallback — the
 * field in ProfileEditModal is labelled "Emoji Avatar (Fallback)" — so use it.
 *
 * ── Keyed by URL, not a boolean ──
 *
 * `failedUrl` remembers WHICH picture failed. A boolean would latch: replacing a
 * broken photograph mints a new filename, and the user would upload a good one
 * and still see the emoji until the next full reload. Storing the URL means the
 * state resets itself the moment a different one arrives, with no effect to keep
 * in sync.
 *
 * ── alt="" ──
 *
 * Decorative, deliberately. This image sits inside a button whose accessible name
 * is already assembled from the name and role rendered beside it, so `alt="Avatar"`
 * made that name "Avatar Alice Rivera Student" — a word describing the widget,
 * announced ahead of the person, on the only sign-out control the desktop shell
 * has. The person's name would be no better: it is already there, twice over. The
 * emoji span is `aria-hidden` for the same reason — otherwise a screen reader
 * reads "fox" into the middle of the button's name.
 */
function Avatar({ user, className, failedUrl, onFailed }) {
  const url = user.profile_picture_url;

  if (url && failedUrl !== url) {
    return <img src={url} alt="" className={className} onError={() => onFailed(url)} />;
  }
  return <span className={className} aria-hidden="true">{user.avatar || '👤'}</span>;
}

/**
 * ── The menu offers Profile, not Edit Profile ──
 *
 * It used to open the edit MODAL directly, which meant the only way to reach
 * your own profile from the account menu was through a form for changing it —
 * and there was no way at all to simply look at it. Worse, the menu was the one
 * place editing was offered to an organizer or an administrator, so "where do I
 * see my profile" and "where do I change it" had the same answer and it was the
 * wrong one for the first question.
 *
 * `/profile` renders the reader's own profile for their role (see SELF_PROFILE
 * in App.jsx), and every one of those views carries its own Edit profile
 * button. Viewing and editing are then one step apart in the direction people
 * actually travel — look first, change if you meant to — instead of the reverse.
 */
export default function ProfileMenu({ user, onSignOut }) {
  const [isOpen, setIsOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState(null);
  const navigate = useNavigate();
  const menuRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setIsOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setIsOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  const handleNavigate = (path) => {
    navigate(path);
    setIsOpen(false);
  };

  const displayRole = user.role === 'organizer' && !user.verified
    ? 'Pending approval'
    : ROLE_LABEL[user.role] || 'Member';

  return (
    <div className="usermenu" ref={menuRef}>
      <button
        className="userchip"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Avatar user={user} className="avatar" failedUrl={failedUrl} onFailed={setFailedUrl} />
        <span className="userchip-text truncate">
          <span className="userchip-name truncate">{user.name}</span>
          <span className="userchip-role">{displayRole}</span>
        </span>
        <ChevronsUpDown size={13} style={{ marginLeft: 'auto', color: 'var(--ink-3)' }} />
      </button>

      {isOpen && (
        <div className="popover menu profile-popover" role="menu">
          <div className="profile-popover-header">
            <Avatar user={user} className="avatar lg" failedUrl={failedUrl} onFailed={setFailedUrl} />
            <div className="profile-popover-info">
              <div className="profile-popover-name truncate">{user.name}</div>
              {user.username && <div className="profile-popover-username truncate">@{user.username}</div>}
              <div className="profile-popover-role">{displayRole}</div>
            </div>
          </div>
          
          <div className="menu-sep" />
          
          <button className="menu-item" role="menuitem" onClick={() => handleNavigate('/profile')}>
            <UserRound size={15} /> Profile
          </button>
          
          <button className="menu-item" role="menuitem" onClick={() => handleNavigate('/settings?section=notifications')}>
            <Bell size={15} /> Notifications
          </button>

          {/**
            * The shared account destinations — "My hours" and Settings.
            *
            * They come AFTER Profile and Notifications, which is also the shape
            * the `⋯` sheet has: the two entries that mirror NAV first, then the
            * shared account destinations. The two controls therefore agree on
            * order as well as on contents, which they did not before.
            *
            *
            * Read from `src/accountMenu.js` rather than written out here,
            * because the `⋯` sheet on a phone IS this control at that width and
            * had its own copy of the list. Settings already existed twice, in
            * two files, with nothing asserting they agreed; "My hours" was
            * added here and measured missing from the sheet at 375px, which is
            * a destination that exists on a laptop and not on a phone.
            *
            * Presentation stays local — `menu-item` and a 15px icon here, a
            * `mobile-more-btn` and a 20px icon there — because that is what
            * actually differs. Only the list is shared.
            */}
          {ACCOUNT_MENU_ITEMS
            .filter(item => !item.requiredCap || can(user, item.requiredCap))
            .map(({ id, path, label, icon: Icon }) => (
              <button key={id} className="menu-item" role="menuitem" onClick={() => handleNavigate(path)}>
                <Icon size={15} /> {label}
              </button>
            ))}

          <div className="menu-sep" />
          
          <button className="menu-item danger" role="menuitem" onClick={() => { onSignOut(); setIsOpen(false); }}>
            <LogOut size={15} /> Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
