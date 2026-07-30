import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { Mail, Lock, AlertCircle, ArrowLeft, Eye, EyeOff, User, CheckCircle2 } from 'lucide-react';
import ProviderButtons from '../components/auth/ProviderButtons';
import { DEMO_MODE } from '../config';

const DEMO_ACCOUNTS = [
  { name: 'Leo Chen', email: 'leo.chen28@gmail.com', avatar: '🧑‍💻', role: 'Student' },
  { name: 'Priya Patel', email: 'priya.patel.nhs@outlook.com', avatar: '👩‍⚕️', role: 'Student' },
  { name: 'Jacquelyn K.', email: 'jkatzenback@vikings.org', avatar: '👩‍💼', role: 'Organizer' },
  { name: 'Robert M.', email: 'rmiller@sbpl.info', avatar: '👨‍🏫', role: 'Pending organizer' },
  { name: 'System Admin', email: 'admin@example.gov', avatar: '🛠️', role: 'Administrator' }
];

export default function Login({ onLoginSuccess, addToast }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const linkData = location.state?.linkData;

  const [mode, setMode] = useState(linkData ? 'link' : 'login');
  const [sentTo, setSentTo] = useState('');

  /**
   * Focus moves to the error when one appears.
   *
   * Without this a screen-reader user submits the form and gets no indication
   * anything happened — the alert renders above the fields they are still
   * sitting in, out of reading order and never announced.
   */
  const errorRef = useRef(null);
  useEffect(() => {
    if (error && errorRef.current) errorRef.current.focus();
  }, [error]);

  useEffect(() => {
    if (linkData) {
      setMode('link');
      setIdentifier(linkData.email);
    }
  }, [linkData]);

  const startOAuth = async (provider) => {
    setLoading(true);
    setError('');
    try {
      const { url } = await api.startOAuth(provider);
      window.location.href = url;
    } catch (err) {
      setError(err.message || `We could not start sign-in with that provider. Please try again.`);
      setLoading(false);
    }
  };

  const handleLinkAccount = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.linkOAuthAccount(linkData.linkToken, password);
      addToast('Account connected.', 'success');
      onLoginSuccess();
    } catch (err) {
      setError(err.message || 'Incorrect password.');
      setLoading(false);
    }
  };

  const performLogin = async (loginId, loginPassword) => {
    setError('');
    setLoading(true);
    try {
      const result = await api.login(loginId, loginPassword);
      if (result.emailVerified === false) {
        // App routes an unconfirmed session to the confirmation screen; saying
        // "welcome back" first would be misleading about what happens next.
        addToast('Confirm your email address to finish signing in.', 'info');
      } else {
        addToast(`Welcome back, ${result.user.name.split(' ')[0]}.`, 'success');
      }
      onLoginSuccess();
    } catch (err) {
      setError(err.message || 'That email or password is not correct.');
      setLoading(false);
    }
  };

  const signIn = (e) => {
    e.preventDefault();
    performLogin(identifier.trim(), password);
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    const address = identifier.trim();
    if (!address) return setError('Enter your email address.');
    setError('');
    setLoading(true);
    try {
      await api.forgotPassword(address);
      setSentTo(address);
      setMode('forgot-success');
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const errorBanner = error && (
    <div
      className="alert alert-danger"
      role="alert"
      tabIndex={-1}
      ref={errorRef}
      style={{ marginBottom: 'var(--s4)' }}
    >
      <AlertCircle size={16} aria-hidden="true" />
      <span>{error}</span>
    </div>
  );

  /* ── Reset link sent ──────────────────────────────────────────────── */
  if (mode === 'forgot-success') {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered" aria-labelledby="sent-heading">
          <div className="auth-icon" aria-hidden="true"><Mail size={26} /></div>
          <h1 id="sent-heading" className="auth-title">Check your email</h1>
          <p className="auth-subtitle">
            If an account exists for <strong>{sentTo}</strong>, a reset link is on its way.
            It expires in an hour.
          </p>
          <div className="auth-actions stack-sm">
            <button className="btn btn-primary btn-block btn-lg" onClick={() => { setMode('login'); setPassword(''); }}>
              Back to sign in
            </button>
            <p className="small dim" style={{ marginTop: 'var(--s2)' }}>
              Nothing arrived? Check your spam folder, then{' '}
              <button className="auth-link" onClick={() => setMode('forgot')}>try another address</button>.
            </p>
          </div>
        </main>
      </div>
    );
  }

  /* ── Forgot password ──────────────────────────────────────────────── */
  if (mode === 'forgot') {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow" aria-labelledby="forgot-heading">
          <button className="auth-back" onClick={() => { setMode('login'); setError(''); }}>
            <ArrowLeft size={16} aria-hidden="true" /> Back to sign in
          </button>

          <div className="auth-head">
            <h1 id="forgot-heading" className="auth-title">Reset your password</h1>
            <p className="auth-subtitle">
              Enter the email address on your account and we'll send you a link to choose a new password.
            </p>
          </div>

          {errorBanner}

          <form onSubmit={handleForgotPassword} className="stack-md" noValidate>
            <div className="field">
              <label htmlFor="reset-email">Email address</label>
              <div className="input-affix">
                <Mail size={16} aria-hidden="true" />
                <input
                  id="reset-email"
                  type="email"
                  className="input input-lg"
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  placeholder="you@example.com"
                  value={identifier}
                  onChange={e => setIdentifier(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>
            </div>

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={loading}>
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        </main>
      </div>
    );
  }

  /* ── Connect a provider to an existing account ────────────────────── */
  if (mode === 'link') {
    const providerLabel = linkData?.provider
      ? linkData.provider.charAt(0).toUpperCase() + linkData.provider.slice(1)
      : 'that provider';

    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow" aria-labelledby="link-heading">
          <div className="auth-icon" aria-hidden="true"><Lock size={26} /></div>

          <div className="auth-head">
            <h1 id="link-heading" className="auth-title">Connect your {providerLabel} account</h1>
            <p className="auth-subtitle">
              <strong>{linkData?.email}</strong> already has a {' '}
              WeVolunteer account. Enter its password once and you can use {providerLabel} from then on.
            </p>
          </div>

          {errorBanner}

          <form onSubmit={handleLinkAccount} className="stack-md" noValidate>
            {/*
              A hidden username field. Password managers need an identity
              alongside the password to offer the right credential and to save
              an updated one; without it they either prompt for nothing or
              offer every entry in the vault.
            */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={linkData?.email || ''}
              readOnly
              hidden
            />

            <div className="field">
              <label htmlFor="link-password">Password</label>
              <div className="input-affix">
                <Lock size={16} aria-hidden="true" />
                <input
                  id="link-password"
                  type={showPassword ? 'text' : 'password'}
                  className="input input-lg"
                  autoComplete="current-password"
                  autoFocus
                  placeholder="Your WeVolunteer password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
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
            </div>

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={loading || !password}>
              {loading ? 'Connecting…' : `Connect ${providerLabel}`}
            </button>
          </form>

          <p className="auth-footer">
            Not your account?{' '}
            <button className="auth-link" onClick={() => navigate('/welcome')}>Start over</button>
          </p>
        </main>
      </div>
    );
  }

  /* ── Sign in ──────────────────────────────────────────────────────── */
  return (
    <div className="auth">
      <main className="auth-form auth-form-narrow" aria-labelledby="login-heading">
        <button className="auth-back" onClick={() => navigate('/welcome')}>
          <ArrowLeft size={16} aria-hidden="true" /> Back
        </button>

        <div className="auth-head">
          <h1 id="login-heading" className="auth-title">Welcome back</h1>
          <p className="auth-subtitle">Sign in to see your shifts and service hours.</p>
        </div>

        {errorBanner}

        <ProviderButtons onSelect={startOAuth} disabled={loading} />

        <div className="auth-divider" role="separator">or</div>

        <form onSubmit={signIn} className="stack-md" noValidate>
          <div className="field">
            <label htmlFor="login-identifier">Email or username</label>
            <div className="input-affix">
              <User size={16} aria-hidden="true" />
              <input
                id="login-identifier"
                name="username"
                /*
                  type="text", not "email". This field accepts a username too,
                  and type="email" makes the browser's own validation reject
                  every username before the request is even sent.
                */
                type="text"
                className="input input-lg"
                autoComplete="username"
                /* Mobile keyboards otherwise capitalise the first letter and
                   autocorrect the address into something else entirely. */
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                placeholder="you@example.com or your username"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                required
                disabled={loading}
              />
            </div>
          </div>

          <div className="field">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label htmlFor="login-password">Password</label>
              <button
                type="button"
                className="auth-link auth-inline-link small"
                onClick={() => { setMode('forgot'); setError(''); }}
              >
                Forgot?
              </button>
            </div>
            <div className="input-affix">
              <Lock size={16} aria-hidden="true" />
              <input
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                className="input input-lg"
                autoComplete="current-password"
                placeholder="Your password"
                value={password}
                onChange={e => setPassword(e.target.value)}
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
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-block btn-lg"
            disabled={loading}
            style={{ marginTop: 'var(--s2)' }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="auth-footer">
          New here?{' '}
          <button className="auth-link" onClick={() => navigate('/signup')}>Create an account</button>
        </p>

        {DEMO_MODE && (
          <div className="auth-demo">
            <div className="eyebrow" style={{ textAlign: 'center', marginBottom: 'var(--s3)' }}>
              Demo accounts — password “password123”
            </div>
            <div className="auth-demo-grid">
              {DEMO_ACCOUNTS.map(acc => (
                <button
                  key={acc.email}
                  type="button"
                  className="auth-demo-btn"
                  disabled={loading}
                  onClick={() => {
                    setIdentifier(acc.email);
                    setPassword('password123');
                    performLogin(acc.email, 'password123');
                  }}
                >
                  <span className="avatar sm" aria-hidden="true">{acc.avatar}</span>
                  <span className="truncate">
                    <span className="auth-demo-name truncate">{acc.name}</span>
                    <span className="auth-demo-role">{acc.role}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Live region so a screen reader hears the outcome of a sign-in
            attempt, which otherwise only ever changes a visual button label. */}
        <span className="sr-only" role="status" aria-live="polite">
          {loading ? 'Signing in' : ''}
        </span>
      </main>
    </div>
  );
}
