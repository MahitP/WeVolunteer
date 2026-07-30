import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';
import { AlertCircle, Mail, Check, Clock } from 'lucide-react';

/**
 * Change the account's email address.
 *
 * There was previously no way to do this anywhere in the product, and the
 * verification wall told anyone who mistyped their address to "sign out and
 * create your account again" — advice that does not work, because the abandoned
 * account keeps both the address and the username.
 *
 * The copy here is careful about one thing above all: nothing has changed until
 * the new address is confirmed. Saying "your email has been updated" when the
 * account still answers at the old address would be the same class of lie as
 * the toast-only buttons this settings screen used to be full of.
 */
export default function EmailCard({ currentUser, addToast, onProfileChange }) {
  const hasPassword = currentUser?.hasPassword !== false;

  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(null);
  const [loadingPending, setLoadingPending] = useState(true);

  const loadPending = useCallback(async () => {
    try {
      const res = await api.fetchPendingEmailChange();
      setPending(res.pending || null);
    } catch {
      // A failed probe must not block the form — the request itself is the
      // authority on whether a change is already outstanding.
      setPending(null);
    } finally {
      setLoadingPending(false);
    }
  }, []);

  useEffect(() => { loadPending(); }, [loadPending]);

  const emailFormatOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim());
  const blocker = !newEmail.trim()
    ? 'Enter the new email address.'
    : !emailFormatOk
      ? 'That does not look like an email address.'
      : newEmail.trim().toLowerCase() === String(currentUser?.email || '').toLowerCase()
        ? 'That is already your email address.'
        : hasPassword && !password
          ? 'Enter your password to confirm.'
          : null;

  const reset = () => {
    setNewEmail(''); setPassword(''); setError(''); setOpen(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (blocker) { setError(blocker); return; }
    setSaving(true);
    setError('');
    try {
      const res = await api.changeEmail(newEmail.trim(), password);
      setPending(res.pending);
      addToast(`Confirmation link sent to ${res.pending}. Your account keeps its current address until you open it.`, 'success');
      reset();
    } catch (err) {
      setError(err.message || 'Could not start that email change.');
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    try {
      await api.cancelEmailChange();
      setPending(null);
      addToast('Email change cancelled.', 'info');
      onProfileChange?.();
    } catch (err) {
      addToast(err.message || 'Could not cancel that request.', 'error');
    }
  };

  return (
    <section className="card card-pad" aria-labelledby="email-heading">
      <h3 id="email-heading" className="stack-heading">Email address</h3>
      <p className="dim small settings-card-intro">
        Sign-in confirmations, password resets and shift reminders all go here, so
        it needs to be an address you can read.
      </p>

      <p className="settings-value">
        <Mail size={15} aria-hidden="true" />
        <span className="truncate">{currentUser?.email}</span>
        {currentUser?.emailVerified
          ? <span className="tag tag-ok"><Check size={12} aria-hidden="true" /> Confirmed</span>
          : <span className="tag tag-warn">Not confirmed</span>}
      </p>

      {/* A pending change is the most important thing on this card when it
          exists — it explains why the address above has not moved yet. */}
      {!loadingPending && pending && (
        <div className="alert alert-info settings-pending" role="status">
          <Clock size={16} aria-hidden="true" />
          <span>
            Waiting for <strong>{pending}</strong> to be confirmed. Open the link
            in that inbox to finish the change — this address stays on the account
            until you do.
            {' '}
            <button type="button" className="auth-link" onClick={cancel}>Cancel the change</button>
          </span>
        </div>
      )}

      {!open ? (
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>
          {pending ? 'Use a different address' : 'Change email address'}
        </button>
      ) : (
        <form onSubmit={submit} className="stack-md" noValidate>
          {error && (
            <div className="alert alert-danger" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="new-email">New email address</label>
            <div className="input-affix">
              <Mail size={16} aria-hidden="true" />
              <input
                id="new-email"
                type="email"
                className="input input-lg"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                placeholder="you@example.com"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                aria-invalid={newEmail.length > 0 && !emailFormatOk}
                aria-describedby="new-email-hint"
                disabled={saving}
                autoFocus
                required
              />
            </div>
            <span id="new-email-hint" className="field-hint">
              We will send a confirmation link there. Nothing changes until you open it.
            </span>
          </div>

          {hasPassword && (
            <div className="field">
              <label htmlFor="email-password">Your password</label>
              <input
                id="email-password"
                type="password"
                className="input input-lg"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={saving}
                required
              />
            </div>
          )}

          <div className="row settings-actions">
            <button type="submit" className="btn btn-primary" disabled={saving || !!blocker}>
              {saving ? 'Sending…' : 'Send confirmation link'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={reset} disabled={saving}>
              Cancel
            </button>
          </div>
          <span className="auth-hint" role="status" aria-live="polite">{blocker || ''}</span>
        </form>
      )}
    </section>
  );
}
