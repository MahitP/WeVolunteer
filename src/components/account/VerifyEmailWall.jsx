import { useState } from 'react';
import { AlertTriangle, Mail } from 'lucide-react';
import { api } from '../../utils/api';

/**
 * The wall an account sees until it confirms its email address.
 *
 * Moved out of App.jsx unchanged.
 *
 * Replaces an inline block that mutated the DOM directly inside its own click
 * handler — `btn.disabled = true; btn.textContent = 'Sending...'` — which
 * React then overwrote on the next render, so the button could flip back to
 * its idle label mid-request. It also offered exactly two ways out (resend,
 * sign out) and no acknowledgement that the most likely reason for being
 * stuck here is a mistyped address, which neither of them fixes.
 */
export default function VerifyEmailWall({ user, addToast, onSignOut, onVerified }) {
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sentAt, setSentAt] = useState(null);

  /**
   * Correcting the address, from behind the wall.
   *
   * This is the case the wall exists for and the one it used to handle worst.
   * The old copy said: if the address is wrong, "sign out and create your
   * account again with the right address" — which cannot work, because the
   * abandoned account still holds that email AND that username, so the second
   * attempt can reuse neither and the first is unusable forever.
   *
   * /api/auth/change-email is on the email-gate allowlist precisely so this
   * screen can reach it.
   */
  const [fixing, setFixing] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fixError, setFixError] = useState('');
  const [pending, setPending] = useState(null);
  const needsPassword = user.hasPassword !== false;

  const submitFix = async (e) => {
    e.preventDefault();
    setFixError('');
    setSending(true);
    try {
      const res = await api.changeEmail(newEmail.trim(), password);
      setPending(res.pending);
      setFixing(false);
      setNewEmail('');
      setPassword('');
      addToast(`Confirmation link sent to ${res.pending}.`, 'success');
    } catch (err) {
      setFixError(err.message || 'Could not change that address.');
    } finally {
      setSending(false);
    }
  };

  const resend = async () => {
    setSending(true);
    try {
      await api.resendVerification();
      setSentAt(Date.now());
      addToast('Sent. Give it a minute to arrive.', 'success');
    } catch (err) {
      addToast(err.message || 'Could not resend that link.', 'error');
    } finally {
      setSending(false);
    }
  };

  /* Confirming happens in whichever tab the email opened, which may not be
     this one. Rather than making the user guess, let them re-check here. */
  const recheck = async () => {
    setChecking(true);
    try {
      const me = await api.getMe();
      if (me?.emailVerified) await onVerified();
      else addToast('Not confirmed yet. Open the link in the email first.', 'info');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="auth">
      <main className="auth-form auth-form-narrow auth-centered" aria-labelledby="verify-heading">
        <div className="auth-icon" aria-hidden="true"><Mail size={26} /></div>

        <h1 id="verify-heading" className="auth-title">Confirm your email</h1>
        <p className="auth-subtitle">
          We sent a link to <strong>{pending || user.email}</strong>. Open it to finish setting up
          your account. The link expires 24 hours after it is sent.
        </p>

        {pending && (
          <div className="alert alert-info" role="status">
            <Mail size={16} aria-hidden="true" />
            <span>
              Your account address is still <strong>{user.email}</strong> until you open the
              link we just sent to <strong>{pending}</strong>.
            </span>
          </div>
        )}

        {!fixing ? (
          <>
            <div className="auth-actions stack-sm">
              <button className="btn btn-primary btn-block btn-lg" onClick={recheck} disabled={checking}>
                {checking ? 'Checking…' : "I've confirmed — continue"}
              </button>
              <button className="btn btn-secondary btn-block" onClick={resend} disabled={sending}>
                {sending ? 'Sending…' : sentAt ? 'Send it again' : 'Resend the link'}
              </button>
              <button className="btn btn-ghost btn-block" onClick={() => setFixing(true)}>
                That address is wrong — change it
              </button>
              <button className="btn btn-ghost btn-block" onClick={onSignOut}>
                Sign out
              </button>
            </div>

            <p className="auth-footer">
              Nothing arriving? Check your spam folder first — confirmation mail often
              lands there. If <strong>{user.email}</strong> has a typo in it, change it
              above rather than starting again: this account is holding that address and
              your username.
            </p>
          </>
        ) : (
          <form onSubmit={submitFix} className="stack-md auth-form-inner" noValidate>
            <p className="auth-subtitle">
              Enter the right address and we will send the link there instead. Nothing
              changes until you open it.
            </p>

            {fixError && (
              <div className="alert alert-danger" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{fixError}</span>
              </div>
            )}

            <div className="field">
              <label htmlFor="fix-email">Your email address</label>
              <div className="input-affix">
                <Mail size={16} aria-hidden="true" />
                <input
                  id="fix-email"
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
                  disabled={sending}
                  autoFocus
                  required
                />
              </div>
            </div>

            {needsPassword && (
              <div className="field">
                <label htmlFor="fix-password">Your password</label>
                <input
                  id="fix-password"
                  type="password"
                  className="input input-lg"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={sending}
                  required
                />
              </div>
            )}

            <div className="auth-actions stack-sm">
              <button
                type="submit"
                className="btn btn-primary btn-block btn-lg"
                disabled={sending || !newEmail.trim() || (needsPassword && !password)}
              >
                {sending ? 'Sending…' : 'Send the link here instead'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => { setFixing(false); setFixError(''); }}
                disabled={sending}
              >
                Never mind
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
