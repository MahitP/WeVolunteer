import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';
import { AlertCircle, Mail, Check, Clock } from 'lucide-react';
import { useStepUp } from '../auth/useStepUp';
import { STEP_UP } from '../../utils/stepUp';

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
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(null);
  const [loadingPending, setLoadingPending] = useState(true);
  const { run, modal } = useStepUp();

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
        : null;

  const reset = () => {
    setNewEmail(''); setError(''); setOpen(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (blocker) { setError(blocker); return; }
    setSaving(true);
    setError('');
    try {
      /**
       * ONE value, used for both the binding and the request.
       *
       * `email.change` binds `newEmail`, and the server folds the RAW body value
       * into the challenge's `params_hash`, then re-derives it from the actual
       * request when the grant is spent. Trimming in one call and not the other
       * — or normalising here but sending the untrimmed field — produces
       * `params_mismatch` on a verification the user completed correctly. That
       * failure is indistinguishable, from the outside, from step-up being
       * broken: the dialog succeeds and the action still refuses.
       *
       * Hence the local. Do not inline `newEmail.trim()` into either call.
       */
      const target = newEmail.trim();

      const res = await run(
        STEP_UP.EMAIL_CHANGE,
        { newEmail: target },
        headers => api.changeEmail(target, headers)
      );
      if (!res) return;

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
      {modal}
    </section>
  );
}
