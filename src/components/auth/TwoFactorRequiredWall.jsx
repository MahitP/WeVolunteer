import { useState } from 'react';
import { Shield } from 'lucide-react';
import TwoFactorSetup from '../../components/account/TwoFactorSetup';
import { useSession } from '../../session/SessionProvider';
import { api } from '../../utils/api';

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
        </p>
        
        <TwoFactorSetup currentUser={currentUser} addToast={addToast} onSetupComplete={refresh} />
        
        <p className="auth-footer">
          <button className="auth-link" onClick={handleSignOut}>Sign out</button>
        </p>
      </main>
    </div>
  );
}
