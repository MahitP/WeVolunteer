import React from 'react';
import { UserCog, Palette, Bell, Shield, Lock, MessageSquare, HelpCircle, ChevronRight } from 'lucide-react';

const SECTIONS = [
  // Account first: it holds the two things a person is most likely to have
  // come here to fix — the email address on the account and their username.
  { id: 'account', label: 'Account', icon: UserCog },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'privacy', label: 'Privacy', icon: Shield },
  { id: 'security', label: 'Security', icon: Lock },
  { id: 'messaging', label: 'Messaging', icon: MessageSquare },
  { id: 'help', label: 'Help', icon: HelpCircle },
];

export default function SettingsSidebar({ activeSection, onSelectSection, isMobile, showSidebarOnMobile }) {
  if (isMobile && !showSidebarOnMobile) {
    return null;
  }

  return (
    <nav className="settings-sidebar" aria-label="Settings">
      {!isMobile && <h2 className="settings-sidebar-title">Settings</h2>}
      {isMobile && (
        <div className="settings-mobile-header">
           <h2 className="topbar-title">Settings</h2>
        </div>
      )}
      <ul className="settings-nav-list stack-xs">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <li key={id}>
            <button
              className={`settings-nav-item ${activeSection === id ? 'active' : ''}`}
              onClick={() => onSelectSection(id)}
              aria-current={activeSection === id ? 'page' : undefined}
            >
              <Icon size={18} className="settings-nav-icon" />
              <span>{label}</span>
              <ChevronRight size={16} className="settings-nav-chevron" />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
