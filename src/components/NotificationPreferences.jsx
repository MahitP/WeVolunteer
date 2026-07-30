import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import LoadingSkeleton from './common/LoadingSkeleton';
import { Mail, Smartphone } from 'lucide-react';
import { NOTIFICATION_CATEGORIES } from '../utils/notifications';

const CATEGORIES = [
  { id: 'EVENT', label: 'Event Updates & Reminders', desc: 'When an event you applied to changes, or to remind you of a shift.' },
  { id: 'APPLICATION', label: 'Applications', desc: 'When your application is accepted, declined, or waitlisted.' },
  { id: 'VOLUNTEER', label: 'Volunteering', desc: 'When your hours are approved or certificates become available.' },
  { id: 'MESSAGES', label: 'Messages & Comments', desc: 'When someone messages you directly or comments on an event.' },
  { id: 'ACCOUNT', label: 'Account & Security', desc: 'Password changes, email verifications, and account approvals.' },
  { id: 'SYSTEM', label: 'System Alerts', desc: 'Important announcements and maintenance notices.' }
];

export default function NotificationPreferences({ addToast }) {
  const [prefs, setPrefs] = useState([]);
  const [globalEmail, setGlobalEmail] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchUserPreferences().then(res => {
      setPrefs(res.preferences || []);
      setGlobalEmail(!res.globalEmailOptOut); // internal is opt-out, UI is opt-in
      setLoading(false);
    }).catch(err => {
      addToast('Failed to load preferences: ' + err.message, 'error');
      setLoading(false);
    });
  }, [addToast]);

  const toggleGlobalEmail = async (enabled) => {
    const original = globalEmail;
    setGlobalEmail(enabled);
    try {
      await api.updateUserPreference('global', 'email', enabled);
      addToast(enabled ? 'Email notifications enabled' : 'Email notifications paused', 'success');
    } catch (err) {
      setGlobalEmail(original);
      addToast('Could not save preference', 'error');
    }
  };

  const togglePref = async (category, channel, enabled) => {
    // Optimistic update
    const prev = [...prefs];
    let found = false;
    const next = prefs.map(p => {
      if (p.category === category && p.channel === channel) {
        found = true;
        return { ...p, enabled: enabled ? 1 : 0 };
      }
      return p;
    });
    if (!found) {
      next.push({ category, channel, enabled: enabled ? 1 : 0 });
    }
    setPrefs(next);

    try {
      await api.updateUserPreference(category, channel, enabled);
    } catch (err) {
      setPrefs(prev);
      addToast('Could not save preference', 'error');
    }
  };

  const isEnabled = (category, channel) => {
    const p = prefs.find(p => p.category === category && p.channel === channel);
    return p ? p.enabled === 1 : true; // Default true
  };

  if (loading) {
    return <div className="stack"><LoadingSkeleton heights={[80, 400]} /></div>;
  }

  return (
    <div className="stack-lg">
      <div className="global-email-banner">
        <div className="global-email-info">
          <h3>Email Notifications</h3>
          <p>Receive updates and reminders directly to your inbox.</p>
        </div>
        <label className="premium-switch">
          <input 
            type="checkbox" 
            checked={globalEmail} 
            onChange={(e) => toggleGlobalEmail(e.target.checked)} 
          />
          <span className="premium-slider"></span>
        </label>
      </div>

      <div className="premium-pref-card">
        {CATEGORIES.map(c => {
          const meta = NOTIFICATION_CATEGORIES[c.id] || NOTIFICATION_CATEGORIES.SYSTEM;
          const Icon = meta.icon;
          return (
            <div className="premium-pref-row" key={c.id}>
              <div className={`premium-pref-icon tone-${meta.tone}`} style={{ color: `var(--${meta.tone})`, background: `var(--${meta.tone}-bg)` }}>
                <Icon size={20} />
              </div>
              <div className="premium-pref-info">
                <div className="premium-pref-title">{c.label}</div>
                <div className="premium-pref-desc">{c.desc}</div>
              </div>
              
              <div className="premium-pref-toggles">
                <div className="premium-pref-toggle-group">
                  <span className="premium-pref-toggle-label"><Smartphone size={14} style={{marginBottom: 4}}/> In-App</span>
                  <label className="premium-switch">
                    <input 
                      type="checkbox" 
                      checked={isEnabled(c.id, 'inapp')} 
                      onChange={e => togglePref(c.id, 'inapp', e.target.checked)}
                    />
                    <span className="premium-slider"></span>
                  </label>
                </div>
                
                <div className="premium-pref-toggle-group" style={{ opacity: globalEmail ? 1 : 0.5 }}>
                  <span className="premium-pref-toggle-label"><Mail size={14} style={{marginBottom: 4}}/> Email</span>
                  <label className="premium-switch" title={!globalEmail ? "Emails are disabled globally" : ""}>
                    <input 
                      type="checkbox" 
                      checked={isEnabled(c.id, 'email')} 
                      onChange={e => togglePref(c.id, 'email', e.target.checked)}
                      disabled={!globalEmail}
                    />
                    <span className="premium-slider"></span>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
