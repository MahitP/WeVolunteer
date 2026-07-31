import React from 'react';
import { api } from '../utils/api';

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
export default function DemoBar({ currentUser, refreshAll, addToast }) {
  const isSeedUser = currentUser && SEED_USERS.some(u => u.id === currentUser.id);

  const handleSwitch = async (e) => {
    const seed = SEED_USERS.find(u => u.id === e.target.value);
    if (!seed) return;
    try {
      await api.login(seed.email, 'password123');
      addToast(`Now viewing as ${seed.name}.`, 'success');
      refreshAll();
    } catch (err) {
      addToast(`Could not switch account: ${err.message}`, 'error');
    }
  };

  /**
   * There is deliberately no "Reset data" button here any more.
   *
   * It called `POST /api/auth/reset`, which dropped tables from a
   * hand-maintained list that had drifted 13 tables out of date. The drop died
   * partway through on a foreign-key cascade it could no longer resolve, so the
   * handler never reached the reseed: pressing this button destroyed the demo
   * instead of restoring it, and the only feedback was an error toast. Resetting
   * a development database is now `npm run db:reset:dev`, which cannot half-
   * finish because it recreates the file rather than enumerating tables.
   */

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
    </div>
  );
}
