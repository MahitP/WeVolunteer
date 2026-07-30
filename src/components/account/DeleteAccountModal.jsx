import React, { useState } from 'react';
import { api } from '../../utils/api';
import { AlertTriangle, Trash2 } from 'lucide-react';

export default function DeleteAccountModal({ onClose, onSuccess, hasPassword, username }) {
  const [deleteText, setDeleteText] = useState('');
  const [password, setPassword] = useState('');
  const [confirmUsername, setConfirmUsername] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * A provider-only account has no password to re-prove with, and the server
   * previously asked such an account for nothing at all — one request against
   * a live session irreversibly anonymised it. Typing the account's own
   * username is not a credential, but it is a deliberate act the server can
   * actually check, unlike the "DELETE" box, which is client-side only.
   */
  const needsUsername = !hasPassword;

  const handleDelete = async (e) => {
    e.preventDefault();
    if (deleteText !== 'DELETE') {
      setError('Type DELETE to confirm.');
      return;
    }
    if (hasPassword && !password) {
      setError('Enter your password to confirm.');
      return;
    }
    if (needsUsername && confirmUsername.trim().toLowerCase() !== String(username || '').toLowerCase()) {
      setError(`Type your username (${username}) exactly to confirm.`);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await api.deleteAccount({
        password: hasPassword ? password : undefined,
        confirmUsername: needsUsername ? confirmUsername.trim() : undefined
      });
      if (result.success) onSuccess();
    } catch (err) {
      setError(err.message || 'Failed to delete account');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: '540px' }}>
        <div className="modal-head" style={{ borderBottom: 'none', paddingBottom: 0 }}>
          <button className="modal-close" onClick={onClose} disabled={isSubmitting}>×</button>
        </div>
        
        <div className="modal-body" style={{ paddingTop: 0 }}>
          <div className="stack-lg">
            <div style={{ textAlign: 'center', marginBottom: 'var(--s2)' }}>
              <div style={{ background: 'var(--danger-tint)', padding: 'var(--s4)', borderRadius: 'var(--r-full)', display: 'inline-block', marginBottom: 'var(--s4)' }}>
                <AlertTriangle size={40} color="var(--danger)" />
              </div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: '700', color: 'var(--ink)' }}>Delete Account?</h2>
              <p className="lead" style={{ marginTop: 'var(--s3)', margin: 'var(--s3) auto 0' }}>
                Deleting your account removes your profile, settings, and login access.
                Your verified volunteer records and certificates may be preserved for verification purposes.
              </p>
            </div>

            <div className="card" style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-md)' }}>
              <div className="card-pad stack-md">
                <p className="strong" style={{ marginBottom: 'var(--s2)' }}>Before deleting:</p>
                
                <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s6)' }}>
                  <div className="stack-sm" style={{ flex: 1 }}>
                    <p className="strong small" style={{ color: 'var(--danger)' }}>Removed</p>
                    <ul className="small dim" style={{ paddingLeft: 'var(--s4)', margin: 0, lineHeight: 1.6 }}>
                      <li>Profile information</li>
                      <li>Preferences</li>
                      <li>Login access</li>
                    </ul>
                  </div>
                  
                  <div className="stack-sm" style={{ flex: 1 }}>
                    <p className="strong small" style={{ color: 'var(--ok)' }}>Preserved</p>
                    <ul className="small dim" style={{ paddingLeft: 'var(--s4)', margin: 0, lineHeight: 1.6 }}>
                      <li>Certificates</li>
                      <li>Verified volunteer hours</li>
                      <li>Historical records</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <div style={{ background: 'var(--danger-tint)', padding: 'var(--s3)', borderRadius: 'var(--r-sm)', border: '1px solid var(--danger-border)' }}>
                <p className="small" style={{ color: 'var(--danger-ink)', margin: 0, textAlign: 'center' }}>
                  {error}
                </p>
              </div>
            )}

            <form id="delete-form" onSubmit={handleDelete} className="stack-md" style={{ marginTop: 'var(--s2)' }}>
              <div className="stack-sm">
                <label className="strong small">To continue, type: DELETE</label>
                <input 
                  type="text" 
                  className="input" 
                  value={deleteText}
                  onChange={(e) => setDeleteText(e.target.value)}
                  placeholder="DELETE"
                  disabled={isSubmitting}
                />
              </div>

              {hasPassword && (
                <div className="stack-sm">
                  <label className="strong small" htmlFor="delete-password">Enter your password</label>
                  <input
                    id="delete-password"
                    type="password"
                    className="input"
                    autoComplete="current-password"
                    placeholder="Current password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              )}

              {needsUsername && (
                <div className="stack-sm">
                  <label className="strong small" htmlFor="delete-username">
                    Type your username <code>{username}</code> to confirm
                  </label>
                  <input
                    id="delete-username"
                    type="text"
                    className="input"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck="false"
                    placeholder={username}
                    value={confirmUsername}
                    onChange={(e) => setConfirmUsername(e.target.value)}
                    disabled={isSubmitting}
                  />
                  <span className="dim small">
                    Your account signs in with a connected provider, so there is no password to check.
                  </span>
                </div>
              )}
            </form>

            <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s3)', marginTop: 'var(--s4)' }}>
              <button className="btn btn-ghost btn-lg" type="button" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </button>
              <button 
                form="delete-form"
                className="btn btn-danger-solid btn-lg" 
                disabled={
                  isSubmitting
                  || deleteText !== 'DELETE'
                  || (hasPassword && !password)
                  || (needsUsername && confirmUsername.trim().toLowerCase() !== String(username || '').toLowerCase())
                }
              >
                {isSubmitting ? 'Deleting...' : 'Delete My Account'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
