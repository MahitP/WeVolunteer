import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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

/** "google" → "Google". Provider names are lowercase keys on the wire. */
const providerLabel = (provider) =>
  provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'that provider';

export default function Login({ onLoginSuccess, addToast }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  /** Which input the server blamed, so the message can sit beside it. */
  const [errorField, setErrorField] = useState(null);
  const [loading, setLoading] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkData = location.state?.linkData;

  /**
   * The sub-mode lives in the URL.
   *
   * It was React state, which broke the one navigation control a phone always
   * has: pressing the system back button from "Reset your password" left the app
   * entirely instead of returning to sign-in, and a refresh mid-flow silently
   * dropped the user back to a form they had already left. `?mode=forgot` costs
   * nothing and makes back, forward and reload all behave.
   *
   * `link` stays state-driven — it depends on `location.state.linkData` from the
   * OAuth callback, which a URL cannot carry.
   */
  const urlMode = searchParams.get('mode');
  const mode = linkData ? 'link' : (['forgot', 'forgot-success'].includes(urlMode) ? urlMode : 'login');

  const setMode = (next) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'login') params.delete('mode');
    else params.set('mode', next);
    setSearchParams(params, { replace: false });
  };

  const [sentTo, setSentTo] = useState('');

  /**
   * Focus moves to the error when one appears.
   *
   * Without this a screen-reader user submits the form and gets no indication
   * anything happened — the alert renders above the fields they are still
   * sitting in, out of reading order and never announced.
   */
  /**
   * Focus moves to whatever the user has to act on.
   *
   * Without this a screen-reader user submits the form and gets no indication
   * anything happened — the alert renders above the fields they are still
   * sitting in, out of reading order and never announced.
   *
   * When the server named a field, focus goes to that input rather than to the
   * banner: it is both the announcement and the thing they need to edit, so one
   * move does the work of two.
   */
  const errorRef = useRef(null);
  useEffect(() => {
    if (!error) return;
    // `?.focus()` rather than an assertion: the link screen's input is
    // `link-password`, so this lookup finds nothing there and the banner —
    // which that screen always renders — takes the focus instead.
    const field = errorField && document.getElementById(
      errorField === 'password' ? 'login-password' : 'login-identifier'
    );
    if (field) field.focus();
    else errorRef.current?.focus();
  }, [error, errorField]);

  useEffect(() => {
    if (linkData) setIdentifier(linkData.email);
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

  /**
   * Signing in on the link screen, which is now all this screen does.
   *
   * ── Why there is no "connect with your password" form any more (v1.2b) ──
   *
   * There was one, and after Task 6 it could not succeed. `POST /api/oauth/link`
   * used to be unauthenticated, tied to an account only by a 15-minute token
   * naming a user id and proved by that account's password — which made it a
   * password oracle on an endpoint nobody thought of as one. It is now
   * authenticated and gated on `requireAAL2('oauth.link')`, so a signed-out
   * caller gets 401 before the handler ever runs. The old form therefore asked
   * for a password nothing checked and reported "Incorrect password." whatever
   * the user typed: a dead end that blamed them for it.
   *
   * The honest flow is the one the endpoint's new shape implies. Sign in
   * normally — which this screen can already do, and the identifier is
   * pre-filled from `linkData.email` — and then connect the provider from
   * Settings, where the connect button carries a step-up verification. Because
   * `link_required` is only ever returned when an account already holds the
   * provider's own address, pressing "Continue with <provider>" again while
   * signed in takes the `auto_linked` path instead and links in one step.
   */
  const handleLinkSignIn = async (e) => {
    e.preventDefault();
    await performLogin(linkData.email, password, {
      afterToast: () => addToast(
        `You can now connect ${providerLabel(linkData.provider)} from Settings.`,
        'info'
      )
    });
  };

  /**
   * `afterToast` lets the link screen add "…and here is what to do next" without
   * duplicating the sign-in error handling below, which knows how to put the
   * message on the field the server named.
   */
  const performLogin = async (loginId, loginPassword, { afterToast } = {}) => {
    setError('');
    setErrorField(null);
    setLoading(true);
    try {
      const result = await api.login(loginId, loginPassword);
      if (result.emailVerified === false) {
        // App routes an unconfirmed session to the confirmation screen; saying
        // "welcome back" first would be misleading about what happens next.
        addToast('Confirm your email address to finish signing in.', 'info');
      } else {
        addToast(`Welcome back, ${result.user.name.split(' ')[0]}.`, 'success');
        afterToast?.();
      }
      onLoginSuccess();
    } catch (err) {
      setError(err.message || 'That email or password is not correct.');
      /**
       * The API says which credential was wrong; show it on that input.
       *
       * `code` was being thrown away entirely, so an unrecognised username and
       * a mistyped password produced the same undifferentiated banner above two
       * fields that both looked fine — the exact ambiguity the specific error
       * messages exist to remove.
       */
      const code = err.data?.code;
      setErrorField(
        code === 'wrong_password' ? 'password'
          : code === 'no_such_account' ? 'identifier'
            : null
      );
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

  /**
   * The banner carries anything NOT attributable to one field.
   *
   * When the server did name a field, the message is rendered beside that input
   * instead — showing it in both places says the same thing twice and makes the
   * screen read as two separate problems.
   */
  const errorBanner = error && !errorField && (
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
          <button className="auth-back" onClick={() => { setMode('login'); setError(''); setErrorField(null); }}>
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
    const label = providerLabel(linkData?.provider);

    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow" aria-labelledby="link-heading">
          <div className="auth-icon" aria-hidden="true"><Lock size={26} /></div>

          <div className="auth-head">
            <h1 id="link-heading" className="auth-title">Sign in to connect {label}</h1>
            {/*
              The copy is deliberately about signing in, not about connecting.
              This form used to claim it would connect the account for a
              password, and since v1.2b it cannot: /api/oauth/link requires a
              session, so a signed-out attempt is refused before the handler
              runs. Promising the link here and delivering "Incorrect password."
              was the worst of both. Connecting happens in Settings, one step
              later, behind a verification.
            */}
            <p className="auth-subtitle">
              <strong>{linkData?.email}</strong> already has a WeVolunteer
              account. Sign in to it, then connect {label} from Settings — it
              takes one more tap and you can use {label} from then on.
            </p>
          </div>

          {/*
            This screen shows its error unconditionally, unlike the sign-in form
            below, which suppresses the banner when the server names a field and
            renders the message beside that input instead.

            Two reasons it has to differ. There is only one field here, so "in a
            banner" and "beside the field" are the same place. And the shared
            mechanism does not reach this screen anyway: the field-level messages
            key on `login-password` / `login-identifier`, and this input is
            `link-password` — so a wrong password produced no banner, no field
            message, and no focus move. Silent failure on the one screen where
            the user has already been bounced once.
          */}
          {error && (
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
          )}

          <form onSubmit={handleLinkSignIn} className="stack-md" noValidate>
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
              {loading ? 'Signing in…' : 'Sign in'}
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
                onChange={e => { setIdentifier(e.target.value); if (errorField === 'identifier') setErrorField(null); }}
                aria-invalid={errorField === 'identifier'}
                aria-describedby={errorField === 'identifier' ? 'login-identifier-error' : undefined}
                required
                disabled={loading}
              />
            </div>
            {errorField === 'identifier' && (
              <span className="field-error" id="login-identifier-error">
                <AlertCircle size={12} aria-hidden="true" />{error}
              </span>
            )}
          </div>

          <div className="field">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label htmlFor="login-password">Password</label>
              <button
                type="button"
                className="auth-link auth-inline-link small"
                onClick={() => { setMode('forgot'); setError(''); setErrorField(null); }}
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
                onChange={e => { setPassword(e.target.value); if (errorField === 'password') setErrorField(null); }}
                aria-invalid={errorField === 'password'}
                aria-describedby={errorField === 'password' ? 'login-password-error' : undefined}
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
            {errorField === 'password' && (
              <span className="field-error" id="login-password-error">
                <AlertCircle size={12} aria-hidden="true" />{error}
              </span>
            )}
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
