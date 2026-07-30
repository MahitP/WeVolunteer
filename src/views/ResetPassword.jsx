import React, { useState, useRef, useEffect } from 'react';
import { Lock, AlertCircle, Check, X, Eye, EyeOff, KeyRound } from 'lucide-react';
import { api } from '../utils/api';

/**
 * Same rules as signup and as server/accountValidation.js.
 *
 * This screen previously enforced only `length >= 8` on both sides, so the
 * reset flow was a way to give an account a password the signup form would
 * have refused — the front door and the side door disagreed.
 */
const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: p => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter', test: p => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter', test: p => /[a-z]/.test(p) },
  { id: 'number', label: 'A number', test: p => /[0-9]/.test(p) }
];

export default function ResetPassword({ token, onSuccess, onCancel }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const errorRef = useRef(null);
  useEffect(() => { if (error && errorRef.current) errorRef.current.focus(); }, [error]);

  /**
   * A reset link with no token is a broken link, not a form to fill in.
   * Previously the screen rendered normally and only failed on submit, after
   * the user had chosen and typed a password twice.
   */
  if (!token) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered" aria-labelledby="badlink-heading">
          <div className="auth-icon auth-icon-danger" aria-hidden="true"><AlertCircle size={26} /></div>
          <h1 id="badlink-heading" className="auth-title">That reset link is incomplete</h1>
          <p className="auth-subtitle">
            It may have been cut short by your email app. Request a new one and open it in a single tap.
          </p>
          <div className="auth-actions">
            <button className="btn btn-primary btn-block btn-lg" onClick={onCancel}>
              Back to sign in
            </button>
          </div>
        </main>
      </div>
    );
  }

  const failedRule = PASSWORD_RULES.find(r => !r.test(password));
  const blocker = !password
    ? 'Choose a new password.'
    : failedRule
      ? `Password needs: ${failedRule.label.toLowerCase()}.`
      : password !== confirm
        ? 'The two passwords do not match.'
        : null;

  const handleReset = async (e) => {
    e.preventDefault();
    if (blocker) { setError(blocker); return; }
    setError('');
    setLoading(true);
    try {
      await api.resetPassword(token, password);
      onSuccess();
    } catch (err) {
      setError(err.message || 'We could not reset your password. Request a new link and try again.');
      setLoading(false);
    }
  };

  return (
    <div className="auth">
      <main className="auth-form auth-form-narrow" aria-labelledby="reset-heading">
        <div className="auth-icon" aria-hidden="true"><KeyRound size={26} /></div>

        <div className="auth-head">
          <h1 id="reset-heading" className="auth-title">Choose a new password</h1>
          <p className="auth-subtitle">
            Setting a new password signs you out everywhere else, so anyone still holding your
            old one loses access.
          </p>
        </div>

        {error && (
          <div className="alert alert-danger" role="alert" tabIndex={-1} ref={errorRef} style={{ marginBottom: 'var(--s4)' }}>
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleReset} className="stack-md" noValidate>
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <div className="input-affix">
              <Lock size={16} aria-hidden="true" />
              <input
                id="new-password"
                name="new-password"
                type={showPassword ? 'text' : 'password'}
                className="input input-lg"
                autoComplete="new-password"
                autoFocus
                placeholder="At least 8 characters"
                value={password}
                onChange={e => setPassword(e.target.value)}
                aria-describedby="reset-rules"
                required
                disabled={loading}
              />
              <button
                type="button"
                className="btn-icon-right"
                onClick={() => setShowPassword(v => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>

            <ul className="auth-rules" id="reset-rules">
              {PASSWORD_RULES.map(rule => {
                const met = rule.test(password);
                const state = !password ? 'idle' : met ? 'met' : 'failed';
                return (
                  <li key={rule.id} className="auth-rule" data-state={state}>
                    <span className="auth-rule-icon" aria-hidden="true">
                      {state === 'met' ? <Check size={13} /> : state === 'failed' ? <X size={13} /> : '•'}
                    </span>
                    <span>{rule.label}</span>
                    <span className="sr-only">{state === 'met' ? ' — met' : state === 'failed' ? ' — not yet met' : ''}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="field">
            <label htmlFor="confirm-password">Confirm new password</label>
            <div className="input-affix">
              <Lock size={16} aria-hidden="true" />
              <input
                id="confirm-password"
                name="confirm-password"
                type={showPassword ? 'text' : 'password'}
                className="input input-lg"
                autoComplete="new-password"
                placeholder="Type it again"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                aria-invalid={confirm.length > 0 && password !== confirm}
                aria-describedby="confirm-status"
                required
                disabled={loading}
              />
            </div>
            <span
              id="confirm-status"
              className="auth-status"
              aria-live="polite"
              data-state={!confirm ? 'pending' : password === confirm ? 'ok' : 'error'}
            >
              {!confirm ? ''
                : password === confirm
                  ? <><Check size={13} aria-hidden="true" /> Passwords match</>
                  : <><X size={13} aria-hidden="true" /> Passwords do not match yet</>}
            </span>
          </div>

          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={loading || !!blocker}>
            {loading ? 'Saving…' : 'Set new password'}
          </button>
          <span className="auth-hint" role="status" aria-live="polite">{blocker || ''}</span>
        </form>

        <p className="auth-footer">
          <button className="auth-link" onClick={onCancel} type="button">
            Cancel and return to sign in
          </button>
        </p>
      </main>
    </div>
  );
}
