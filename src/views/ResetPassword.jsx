import React, { useState } from 'react';
import { Lock, AlertCircle } from 'lucide-react';
import { api } from '../utils/api';

export default function ResetPassword({ token, onSuccess, onCancel }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleReset = async (e) => {
    e.preventDefault();
    if (password.length < 8) return setError('Password must be at least 8 characters long');
    
    setError('');
    setLoading(true);
    try {
      await api.resetPassword(token, password);
      onSuccess();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth" style={{ justifyContent: 'center' }}>
      <main className="auth-form" style={{ maxWidth: 400, width: '100%' }}>
        <h1>Choose a new password</h1>
        <p className="lead" style={{ marginTop: 4, marginBottom: 'var(--s5)' }}>
          Please enter your new password below.
        </p>

        {error && (
          <div className="alert alert-danger" style={{ marginBottom: 'var(--s4)' }} role="alert">
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleReset}>
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <div className="input-affix">
              <Lock size={15} />
              <input
                id="new-password" type="password" className="input" autoComplete="new-password"
                placeholder="••••••••" value={password}
                onChange={e => setPassword(e.target.value)} required disabled={loading}
              />
            </div>
          </div>

          <button type="submit" className="btn btn-primary btn-block" style={{ marginTop: 'var(--s5)' }} disabled={loading}>
            {loading ? 'Saving...' : 'Reset password'}
          </button>
        </form>

        <p className="small muted" style={{ textAlign: 'center', marginTop: 'var(--s4)' }}>
          <button className="strong" style={{ color: 'var(--brand)', textDecoration: 'underline' }} onClick={onCancel} type="button">
            Cancel and return to sign in
          </button>
        </p>
      </main>
    </div>
  );
}
