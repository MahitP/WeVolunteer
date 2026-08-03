import React, { useState } from 'react';
import { api } from '../../utils/api';
import { AlertCircle, Check, X, Eye, EyeOff } from 'lucide-react';
import { useStepUp } from '../auth/useStepUp';
import { STEP_UP } from '../../utils/stepUp';

/**
 * Change, or first set, the account password.
 *
 * Replaces a "Change Password" button whose entire implementation was
 * `onClick={() => addToast('Password change email sent.', 'info')}`. No
 * request was made, no email was sent, and nothing changed — the user was
 * simply told otherwise. There was no endpoint behind it either.
 *
 * ── Why there is no "current password" field any more (v1.2b) ──
 *
 * The endpoint used to prove identity with `currentPassword` and its own
 * `bcrypt.compare`. It is now behind `requireAAL2('password.change')`, so the
 * proof is the verification dialog — which a provider-only account can also
 * answer, by re-consenting at its provider. That is the whole reason such an
 * account can now set a first password: the old check needed a credential it
 * did not have, so it was simply exempted from proving anything at all.
 *
 * The "choose a different password from the one you have" rule survives
 * server-side as policy, in `accountValidation.js`. It is not an identity check
 * and never was.
 */
const RULES = [
  { id: 'length', label: 'At least 8 characters', test: p => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter', test: p => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter', test: p => /[a-z]/.test(p) },
  { id: 'number', label: 'A number', test: p => /[0-9]/.test(p) }
];

export default function PasswordCard({ currentUser, addToast }) {
  // A provider-only account is adding a first password, not replacing one, so
  // there is no current password to ask for.
  const hasPassword = currentUser?.hasPassword !== false;

  const [open, setOpen] = useState(false);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { run, modal } = useStepUp();

  const failed = RULES.find(r => !r.test(next));
  const blocker = !next ? 'Choose a new password.'
    : failed ? `New password needs: ${failed.label.toLowerCase()}.`
      : next !== confirm ? 'The two new passwords do not match.'
        : null;

  const reset = () => {
    setNext(''); setConfirm(''); setError(''); setOpen(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (blocker) { setError(blocker); return; }
    setSaving(true);
    setError('');
    try {
      // `password.change` binds no params — the new password is deliberately not
      // one of them, because the registry's bound keys travel to the client when
      // a challenge is opened and a password has no business being there.
      const res = await run(
        STEP_UP.PASSWORD_CHANGE,
        {},
        headers => api.changePassword(next, headers)
      );

      // Dismissed the dialog. Leave the form as it was, with what they typed
      // still in it, and say nothing — they chose this.
      if (!res) return;

      addToast(
        res.addedPassword
          ? 'Password set. You can now sign in with your email address as well.'
          : 'Password changed. Your other devices have been signed out.',
        'success'
      );
      reset();
    } catch (err) {
      setError(err.message || 'Could not change your password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card card-pad" aria-labelledby="password-heading">
      <h3 id="password-heading" style={{ marginBottom: 'var(--s2)' }}>
        {hasPassword ? 'Password' : 'Set a password'}
      </h3>
      <p className="dim small" style={{ marginBottom: 'var(--s4)' }}>
        {hasPassword
          ? 'Changing your password signs you out on every other device.'
          : 'You currently sign in with a connected account only. Adding a password gives you a second way in if you ever lose access to it.'}
      </p>

      {!open ? (
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>
          {hasPassword ? 'Change password' : 'Set a password'}
        </button>
      ) : (
        <form onSubmit={submit} className="stack-md" noValidate>
          {error && (
            <div className="alert alert-danger" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {/* Identity for the password manager, so it offers and saves the
              right credential rather than every entry in the vault. */}
          <input type="text" name="username" autoComplete="username" value={currentUser?.email || ''} readOnly hidden />

          <div className="field">
            <label htmlFor="pw-new">New password</label>
            <div className="input-affix">
              <input
                id="pw-new"
                type={show ? 'text' : 'password'}
                className="input input-lg"
                autoComplete="new-password"
                value={next}
                onChange={e => setNext(e.target.value)}
                aria-describedby="pw-rules"
                disabled={saving}
                autoFocus={!hasPassword}
                required
              />
              <button
                type="button"
                className="btn-icon-right"
                onClick={() => setShow(v => !v)}
                aria-label={show ? 'Hide password' : 'Show password'}
                aria-pressed={show}
              >
                {show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>
            <ul className="auth-rules" id="pw-rules">
              {RULES.map(rule => {
                const met = rule.test(next);
                const state = !next ? 'idle' : met ? 'met' : 'failed';
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
            <label htmlFor="pw-confirm">Confirm new password</label>
            <input
              id="pw-confirm"
              type={show ? 'text' : 'password'}
              className="input input-lg"
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              aria-invalid={confirm.length > 0 && next !== confirm}
              disabled={saving}
              required
            />
          </div>

          <div className="row" style={{ gap: 'var(--s3)' }}>
            <button type="submit" className="btn btn-primary" disabled={saving || !!blocker}>
              {saving ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={reset} disabled={saving}>
              Cancel
            </button>
          </div>
          <span className="auth-hint" role="status" aria-live="polite">{blocker || ''}</span>
        </form>
      )}
      {modal}
    </section>
  );
}
