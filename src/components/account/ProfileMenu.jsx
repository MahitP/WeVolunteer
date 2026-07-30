import React, { useState, useRef, useEffect } from 'react';
import { UserCog, Settings, Bell, LogOut, ChevronsUpDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const ROLE_LABEL = { admin: 'Administrator', organizer: 'Organizer', student: 'Student' };

export default function ProfileMenu({ user, onEditProfile, onSignOut }) {
  const [isOpen, setIsOpen] = useState(false);
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
    : ROLE_LABEL[user.role] || 'Volunteer';

  return (
    <div className="usermenu" ref={menuRef}>
      <button
        className="userchip"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span className="avatar">{user.avatar || '👤'}</span>
        <span className="userchip-text truncate">
          <span className="userchip-name truncate">{user.name}</span>
          <span className="userchip-role">{displayRole}</span>
        </span>
        <ChevronsUpDown size={13} style={{ marginLeft: 'auto', color: 'var(--ink-3)' }} />
      </button>

      {isOpen && (
        <div className="popover menu profile-popover" role="menu">
          <div className="profile-popover-header">
            <span className="avatar lg">{user.avatar || '👤'}</span>
            <div className="profile-popover-info">
              <div className="profile-popover-name truncate">{user.name}</div>
              {user.username && <div className="profile-popover-username truncate">@{user.username}</div>}
              <div className="profile-popover-role">{displayRole}</div>
            </div>
          </div>
          
          <div className="menu-sep" />
          
          <button className="menu-item" role="menuitem" onClick={() => { onEditProfile(); setIsOpen(false); }}>
            <UserCog size={15} /> Edit Profile
          </button>
          
          <button className="menu-item" role="menuitem" onClick={() => handleNavigate('/settings?section=notifications')}>
            <Bell size={15} /> Notifications
          </button>

          <button className="menu-item" role="menuitem" onClick={() => handleNavigate('/settings')}>
            <Settings size={15} /> Settings
          </button>
          
          <div className="menu-sep" />
          
          <button className="menu-item danger" role="menuitem" onClick={() => { onSignOut(); setIsOpen(false); }}>
            <LogOut size={15} /> Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
