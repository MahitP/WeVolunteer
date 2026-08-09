import { Shield } from 'lucide-react';
import TwoFactorSetup from '../../components/account/TwoFactorSetup';
import { useSession } from '../../session/SessionProvider';
import { api } from '../../utils/api';

/**
 * The screen an administrator with no second factor sees instead of the app.
 *
 * `REQUIRE_ADMIN_2FA` defaults on, so this is the first thing most
 * administrators meet, and enrolling from here is the most-travelled path
 * through `TwoFactorSetup`. Two things about that are worth stating:
 *
 *   • Enrolment asks for the account password once, part-way through, and a
 *     password prompt nobody was expecting reads as a phishing attempt. The
 *     subtitle says it is coming before it arrives; `VerifyIdentityModal` then
 *     says why.
 *
 *   • `onSetupComplete` is `refresh`, and a refresh clears
 *     `currentUser.tfaRequired` — which makes `App.jsx` render the application
 *     shell instead of this screen and unmounts everything here. So
 *     `TwoFactorSetup` calls it only once the recovery codes have been
 *     acknowledged. It is deliberately not called when enrolment succeeds; see
 *     the docstring there.
 */
export default function TwoFactorRequiredWall({ addToast }) {
  const { currentUser, refresh } = useSession();

  const handleSignOut = async () => {
    try {
      await api.logout();
      window.location.href = '/login';
    } catch (err) {
      addToast(err.message || 'Could not sign out.', 'error');
    }
  };

  return (
    <div className="auth">
      <main className="auth-form auth-form-wide auth-centered" aria-labelledby="tfa-wall-heading">
        <div className="auth-icon" aria-hidden="true"><Shield size={32} /></div>
        <h1 id="tfa-wall-heading" className="auth-title">Set up two-factor authentication</h1>
        <p className="auth-subtitle">
          Your role as {currentUser.role === 'super_admin' ? 'platform owner' : 'administrator'} requires
          two-factor authentication to protect your account and the accounts you manage.
          You will be asked for your password once along the way, to prove it is you
          adding the second factor and not someone using your signed-in browser.
        </p>

        <TwoFactorSetup currentUser={currentUser} addToast={addToast} onSetupComplete={refresh} />

        <p className="auth-footer">
          <button className="auth-link" onClick={handleSignOut}>Sign out</button>
        </p>
      </main>
    </div>
  );
}
