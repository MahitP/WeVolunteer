import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';

/**
 * Demo-only account switcher. Deliberately recessive: it is scaffolding for
 * exploring the product, not part of the product.
 *
 * ── Why the roster is fetched rather than written here ──
 *
 * It was a literal `SEED_USERS` array, a second copy of the one in `Login.jsx`
 * with different role labels. A literal describes the seed as written, not the
 * database as it is: on the pilot deployment `user-admin` had been deleted, and
 * this switcher went on listing "🛠️ System Admin · Administrator" as somewhere
 * you could go. Choosing it signed you out of nothing and in to nothing —
 * `api.login` answered "No account found with that email address" and the toast
 * blamed the switch.
 *
 * `GET /api/auth/demo-accounts` filters tombstones and internal actors and reads
 * every field live, so this cannot drift again. It is DEMO_MODE-gated
 * server-side; this component only renders under DEMO_MODE anyway.
 */
export default function DemoBar({ currentUser, refreshAll, addToast }) {
  const [seedUsers, setSeedUsers] = useState([]);

  useEffect(() => {
    let live = true;
    api.demoAccounts().then(list => { if (live) setSeedUsers(list); });
    return () => { live = false; };
  }, []);

  const isSeedUser = currentUser && seedUsers.some(u => u.id === currentUser.id);

  const handleSwitch = async (e) => {
    const seed = seedUsers.find(u => u.id === e.target.value);
    if (!seed) return;
    try {
      const result = await api.login(seed.email, 'password123');
      /**
       * A demo account with a second factor cannot be switched into silently.
       *
       * `api.login` returns `{ require2FA: true }` and issues only a pre-auth
       * cookie, so `refreshAll()` would re-read the OLD session and the switcher
       * would sit there claiming to have changed account while nothing had. Say
       * so instead: the sign-in screen is where a second factor can be answered.
       */
      if (result?.require2FA) {
        addToast(
          `${seed.name} has two-factor authentication on — sign in from the sign-in screen to switch to it.`,
          'info'
        );
        return;
      }
      addToast(`Now viewing as ${seed.name}.`, 'success');
      refreshAll();
    } catch (err) {
      addToast(`Could not switch account: ${err.message}`, 'error');
    }
  };

  /* Nothing to switch to — a demo build against a database with no demo
     accounts left. An empty select is worse than no bar. */
  if (!seedUsers.length) return null;

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
          {seedUsers.map(u => (
            <option key={u.id} value={u.id}>{u.avatar} {u.name} · {u.role}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
