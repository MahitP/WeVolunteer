import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { useStepUp } from '../auth/useStepUp';
import { STEP_UP } from '../../utils/stepUp';
import { Shield, Mail, Key } from 'lucide-react';

export default function TwoFactorSetup({ currentUser, addToast, onSetupComplete }) {
  const [loading, setLoading] = useState(false);
  const [setupData, setSetupData] = useState(null);
  const [token, setToken] = useState('');
  const [newRecoveryCodes, setNewRecoveryCodes] = useState(null);
  
  const [status, setStatus] = useState({
    methods: { totp: false, email: false },
    recoveryCodesRemaining: 0
  });

  const { run, modal } = useStepUp();

  const fetchStatus = async () => {
    try {
      const data = await api.apiFetch('/api/2fa/status');
      setStatus(data);
    } catch (err) {
      addToast('Could not load 2FA status.', 'error');
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleStartSetup = async () => {
    setLoading(true);
    try {
      const data = await run(STEP_UP.GENERATE_2FA, {}, headers => 
        api.apiFetch('/api/2fa/generate', { method: 'POST', headers })
      );
      setSetupData(data);
    } catch (err) {
      if (err?.message !== 'Cancelled') {
        addToast(err.message || 'Could not start 2FA setup.', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async (e) => {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    try {
      const data = await run(STEP_UP.ENABLE_2FA, {}, headers => 
        api.apiFetch('/api/2fa/enable', { 
          method: 'POST', 
          headers,
          body: JSON.stringify({ token: token.trim() }) 
        })
      );
      setNewRecoveryCodes(data.recoveryCodes);
      setSetupData(null);
      await fetchStatus();
      addToast('Authenticator App enabled!', 'success');
      if (onSetupComplete) onSetupComplete();
    } catch (err) {
      addToast(err.message || 'Invalid code. Try again.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDisableTotp = async () => {
    const code = prompt('Enter a 2FA code to disable Authenticator App:');
    if (!code) return;
    
    setLoading(true);
    try {
      await run(STEP_UP.DISABLE_2FA, {}, headers => 
        api.apiFetch('/api/2fa/disable', { 
          method: 'POST', 
          headers,
          body: JSON.stringify({ token: code }) 
        })
      );
      await fetchStatus();
      addToast('Authenticator App disabled.', 'info');
    } catch (err) {
      addToast(err.message || 'Could not disable 2FA. Invalid code.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEnableEmail = async () => {
    setLoading(true);
    try {
      const data = await run(STEP_UP.ENABLE_2FA, {}, headers => 
        api.apiFetch('/api/2fa/email/enable', { method: 'POST', headers })
      );
      if (data.recoveryCodes) setNewRecoveryCodes(data.recoveryCodes);
      await fetchStatus();
      addToast('Email Verification enabled!', 'success');
      if (onSetupComplete) onSetupComplete();
    } catch (err) {
      if (err?.message !== 'Cancelled') {
        addToast(err.message || 'Could not enable Email 2FA.', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDisableEmail = async () => {
    setLoading(true);
    try {
      await run(STEP_UP.DISABLE_2FA, {}, headers => 
        api.apiFetch('/api/2fa/email/disable', { method: 'POST', headers })
      );
      await fetchStatus();
      addToast('Email Verification disabled.', 'info');
    } catch (err) {
      if (err?.message !== 'Cancelled') {
        addToast(err.message || 'Could not disable Email 2FA.', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerateRecovery = async () => {
    if (!window.confirm('This will invalidate all existing recovery codes. Continue?')) return;
    setLoading(true);
    try {
      const data = await run(STEP_UP.GENERATE_2FA, {}, headers => 
        api.apiFetch('/api/2fa/recovery-codes/regenerate', { method: 'POST', headers })
      );
      setNewRecoveryCodes(data.recoveryCodes);
      await fetchStatus();
      addToast('Recovery codes regenerated.', 'success');
    } catch (err) {
      if (err?.message !== 'Cancelled') {
        addToast(err.message || 'Could not regenerate recovery codes.', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
      {modal}
      <h3 style={{ marginBottom: 'var(--s2)' }}>Two-Factor Authentication (2FA)</h3>
      <p className="dim small" style={{ marginBottom: 'var(--s4)' }}>
        Protect your account with an extra layer of security.
      </p>

      {newRecoveryCodes ? (
        <div>
          <div className="alert alert-info" style={{ marginBottom: 'var(--s4)' }}>
            <strong>Recovery Codes Generated!</strong> Please save these recovery codes in a safe place. You won't see them again.
          </div>
          <div className="card card-body" style={{ background: 'var(--surface-2)', fontFamily: 'monospace' }}>
            <div className="grid grid-2">
              {newRecoveryCodes.map(c => <div key={c}>{c}</div>)}
            </div>
          </div>
          <button className="btn btn-secondary" style={{ marginTop: 'var(--s4)' }} onClick={() => setNewRecoveryCodes(null)}>
            I have saved these codes
          </button>
        </div>
      ) : setupData ? (
        <form onSubmit={handleEnable} style={{ marginBottom: 'var(--s4)' }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s6)' }}>
            <div style={{ background: 'white', padding: 8, borderRadius: 8 }}>
              <img src={setupData.qr} alt="QR Code for 2FA" width={150} height={150} />
            </div>
            <div className="stack-xs">
              <span className="strong">1. Scan this QR Code</span>
              <span className="dim small">Use an app like Google Authenticator or Authy.</span>
              
              <span className="strong" style={{ marginTop: 'var(--s2)' }}>2. Enter the code</span>
              <input 
                className="input" 
                value={token} 
                onChange={e => setToken(e.target.value)} 
                placeholder="000000" 
                maxLength={6}
                required
              />
              <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
                <button type="submit" className="btn btn-primary" disabled={loading}>Verify & Enable</button>
                <button type="button" className="btn btn-ghost" onClick={() => setSetupData(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </form>
      ) : (
        <div className="stack-md">
          {/* TOTP Section */}
          <div style={{ paddingBottom: 'var(--s4)', borderBottom: '1px solid var(--border)' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s2)' }}>
              <div className="row">
                <Shield size={18} />
                <span className="strong">Authenticator App</span>
                {status.methods.totp ? <span className="tag tag-ok">Enabled</span> : null}
              </div>
            </div>
            <p className="dim small" style={{ marginBottom: 'var(--s3)' }}>Get codes from an app like Google Authenticator or Authy.</p>
            {status.methods.totp ? (
              <button className="btn btn-danger" onClick={handleDisableTotp} disabled={loading}>
                Disable
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={handleStartSetup} disabled={loading}>
                Set Up Authenticator
              </button>
            )}
          </div>

          {/* Email 2FA Section */}
          <div style={{ paddingBottom: 'var(--s4)', borderBottom: '1px solid var(--border)' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s2)' }}>
              <div className="row">
                <Mail size={18} />
                <span className="strong">Email Verification</span>
                {status.methods.email ? <span className="tag tag-ok">Enabled</span> : null}
              </div>
            </div>
            <p className="dim small" style={{ marginBottom: 'var(--s3)' }}>Email verification requires a verified email address. TOTP is recommended as the stronger option.</p>
            {status.methods.email ? (
              <button className="btn btn-danger" onClick={handleDisableEmail} disabled={loading}>
                Disable
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={handleEnableEmail} disabled={loading}>
                Enable Email 2FA
              </button>
            )}
          </div>

          {/* Recovery Codes Section */}
          {(status.methods.totp || status.methods.email) && (
            <div>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s2)' }}>
                <div className="row">
                  <Key size={18} />
                  <span className="strong">Recovery Codes</span>
                  <span className="dim small">{status.recoveryCodesRemaining} remaining</span>
                </div>
              </div>
              <p className="dim small" style={{ marginBottom: 'var(--s3)' }}>Use these to access your account if you lose your 2FA device.</p>
              <button className="btn btn-secondary" onClick={handleRegenerateRecovery} disabled={loading}>
                Regenerate Recovery Codes
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

