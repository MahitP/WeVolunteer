import React from 'react';
import { api } from '../utils/api';
import { RotateCcw } from 'lucide-react';

const SEED_USERS = [
  { id: 'user-student-1', name: 'Leo Chen', email: 'leo.chen28@gmail.com', avatar: '🧑‍💻', role: 'Volunteer' },
  { id: 'user-student-2', name: 'Priya Patel', email: 'priya.patel.nhs@outlook.com', avatar: '👩‍⚕️', role: 'Volunteer' },
  { id: 'user-student-3', name: 'Ethan Miller', email: 'emiller2027@gmail.com', avatar: '🧑‍🎨', role: 'Volunteer' },
  { id: 'user-org-1', name: 'Jacquelyn Katzenback', email: 'jkatzenback@vikings.org', avatar: '👩‍💼', role: 'Organizer' },
  { id: 'user-org-pending', name: 'Robert Miller', email: 'rmiller@sbpl.info', avatar: '👨‍🏫', role: 'Organizer, pending' },
  { id: 'user-admin', name: 'System Admin', email: 'admin@example.gov', avatar: '🛠️', role: 'Administrator' }
];

/**
 * Demo-only account switcher. Deliberately recessive: it is scaffolding for
 * exploring the product, not part of the product.
 */
export default function DemoBar({ currentUser, onStateChange, addToast }) {
  const isSeedUser = currentUser && SEED_USERS.some(u => u.id === currentUser.id);

  const handleSwitch = async (e) => {
    const seed = SEED_USERS.find(u => u.id === e.target.value);
    if (!seed) return;
    try {
      await api.login(seed.email, 'password123');
      addToast(`Now viewing as ${seed.name}.`, 'success');
      onStateChange();
    } catch (err) {
      addToast(`Could not switch account: ${err.message}`, 'error');
    }
  };

  const handleReset = async () => {
    const ok = window.confirm(
      'Reset the demo database?\n\nAll events, sign-ups, and hours you created will be replaced with the original sample data.'
    );
    if (!ok) return;
    try {
      await api.resetDatabase();
      await api.login('leo.chen28@gmail.com', 'password123');
      addToast('Demo data restored. Signed in as Leo Chen.', 'success');
      onStateChange();
    } catch (err) {
      addToast(`Could not reset demo data: ${err.message}`, 'error');
    }
  };

  return (
    <div className="demobar">
      <span className="demobar-label">
        <span className="demobar-dot" aria-hidden="true" />
        Demo
      </span>

      <label className="row" style={{ gap: 6 }}>
        <span className="nowrap">Viewing as</span>
        <select
          value={isSeedUser ? currentUser.id : 'custom'}
          onChange={handleSwitch}
          aria-label="Switch demo account"
        >
          {!isSeedUser && currentUser && (
            <option value="custom" disabled>{currentUser.name} (your account)</option>
          )}
          {SEED_USERS.map(u => (
            <option key={u.id} value={u.id}>{u.avatar} {u.name} · {u.role}</option>
          ))}
        </select>
      </label>

      <button onClick={handleReset} title="Restore the original sample data" style={{ marginLeft: 'auto' }}>
        <RotateCcw size={12} /> Reset data
      </button>
    </div>
  );
}
