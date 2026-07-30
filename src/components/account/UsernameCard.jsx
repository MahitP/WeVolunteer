import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { AlertCircle, AtSign, Check, X, Loader2 } from 'lucide-react';

/**
 * Change the account's username.
 *
 * The rules are duplicated from server/accountValidation.js on purpose, for the
 * same reason the signup form duplicates them: the field needs a verdict on
 * every keystroke, and the server can never trust the client's opinion. Signup
 * and reset already carry the same pair.
 */
const RULES = [
  { id: 'length', label: '3–20 characters', test: u => u.length >= 3 && u.length <= 20 },
  { id: 'charset', label: 'Letters, numbers and underscores only', test: u => /^[a-zA-Z0-9_]+$/.test(u) },
  { id: 'start', label: 'Starts with a letter', test: u => /^[a-zA-Z]/.test(u) }
];

export default function UsernameCard({ currentUser, addToast, onProfileChange }) {
  const current = currentUser?.username || '';

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('idle'); // idle|checking|available|taken|unknown
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const formatOk = RULES.every(r => r.test(value));
  const unchanged = value === current;
  /** A pure capitalisation change is free and cannot collide with anyone. */
  const caseOnly = !unchanged && value.toLowerCase() === current.toLowerCase();

  /* Live availability, aborting the in-flight probe on each keystroke so a slow
     early response cannot land after a later one and show a stale verdict. */
  useEffect(() => {
    if (!open || !formatOk || unchanged || caseOnly) { setStatus('idle'); return; }
    setStatus('checking');
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const data = await api.checkUsername(value, controller.signal);
        setStatus(data.available ? 'available' : 'taken');
      } catch (err) {
        if (err?.name === 'AbortError') return;
        // The check is a convenience, not a gate — the POST is the authority.
        setStatus('unknown');
      }
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [value, formatOk, unchanged, caseOnly, open]);

  const failed = RULES.find(r => !r.test(value));
  const blocker = !value
    ? 'Choose a username.'
    : failed
      ? `Username: ${failed.label.toLowerCase()}.`
      : unchanged
        ? 'That is already your username.'
        : status === 'checking'
          ? 'Checking whether that username is free…'
          : status === 'taken'
            ? 'That username is already taken.'
            : null;

  const reset = () => { setValue(''); setError(''); setStatus('idle'); setOpen(false); };

  const submit = async (e) => {
    e.preventDefault();
    if (blocker) { setError(blocker); return; }
    setSaving(true);
    setError('');
    try {
      await api.changeUsername(value);
      addToast(`You are now @${value}.`, 'success');
      onProfileChange?.();
      reset();
    } catch (err) {
      setError(err.message || 'Could not change your username.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card card-pad settings-card-spaced" aria-labelledby="username-heading">
      <h3 id="username-heading" className="stack-heading">Username</h3>
      <p className="dim small settings-card-intro">
        You can sign in with this instead of your email address. Changing it does
        not sign you out, and you can change it again after 30 days.
      </p>

      <p className="settings-value">
        <AtSign size={15} aria-hidden="true" />
        <span className="truncate">{current || 'Not set'}</span>
      </p>

      {!open ? (
        <button className="btn btn-secondary" onClick={() => { setValue(current); setOpen(true); }}>
          {current ? 'Change username' : 'Choose a username'}
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
            <label htmlFor="new-username">New username</label>
            <div className="input-affix">
              <AtSign size={16} aria-hidden="true" />
              <input
                id="new-username"
                className="input input-lg"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                maxLength={20}
                value={value}
                onChange={e => setValue(e.target.value)}
                aria-invalid={status === 'taken'}
                aria-describedby="new-username-rules new-username-status"
                disabled={saving}
                autoFocus
                required
              />
            </div>

            <ul className="auth-rules" id="new-username-rules">
              {RULES.map(rule => {
                const met = rule.test(value);
                const state = !value ? 'idle' : met ? 'met' : 'failed';
                return (
                  <li key={rule.id} className="auth-rule" data-state={state}>
                    <span className="auth-rule-icon" aria-hidden="true">
                      {state === 'met' ? <Check size={13} /> : state === 'failed' ? <X size={13} /> : '•'}
                    </span>
                    <span>{rule.label}</span>
                    {/* The glyph is decorative; this is what a screen reader
                        reads, so state is never carried by colour alone. */}
                    <span className="sr-only">{state === 'met' ? ' — met' : state === 'failed' ? ' — not yet met' : ''}</span>
                  </li>
                );
              })}
            </ul>

            <span
              id="new-username-status"
              className="auth-status"
              role="status"
              aria-live="polite"
              data-state={status === 'available' ? 'ok' : status === 'taken' ? 'error' : 'pending'}
            >
              {caseOnly ? 'Just a change of capitalisation — that is always allowed.'
                : status === 'checking' ? <><Loader2 size={13} aria-hidden="true" /> Checking availability…</>
                  : status === 'available' ? <><Check size={13} aria-hidden="true" /> That username is available</>
                    : status === 'taken' ? <><X size={13} aria-hidden="true" /> That username is already taken</>
                      : status === 'unknown' ? 'We could not check that right now — you can still continue.'
                        : ''}
            </span>
          </div>

          <div className="row settings-actions">
            <button type="submit" className="btn btn-primary" disabled={saving || !!blocker}>
              {saving ? 'Saving…' : 'Change username'}
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
