import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { Mail, Lock, AlertCircle, ArrowLeft, Eye, EyeOff, User, Shield, Key } from 'lucide-react';
import ProviderButtons from '../components/auth/ProviderButtons';
import { useStepUp } from '../components/auth/useStepUp';
import { STEP_UP } from '../utils/stepUp';
import { DEMO_MODE } from '../config';

/** "google" → "Google". Provider names are lowercase keys on the wire. */
const providerLabel = (provider) =>
  provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'that provider';

export default function Login({ onLoginSuccess, addToast }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [tfaToken, setTfaToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  /** Which input the server blamed, so the message can sit beside it. */
  const [errorField, setErrorField] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const [availableMethods, setAvailableMethods] = useState([]);
  /**
   * Null until the server has said what this account can actually satisfy.
   *
   * ── The bug this shape prevents ──
   *
   * This was `useState('totp')`, and nothing ever reconciled it with
   * `availableMethods`. So an account enrolled in EMAIL codes and nothing else
   * landed on this screen with the authenticator field rendered, no radio
   * selected, and no "Send code to email" button — the one control that would
   * have got them a code. Whatever they typed was submitted as `method: 'totp'`,
   * which is not a method their account holds. Both pilot super-administrator
   * accounts are email-only, so this was the entire second-factor experience for
   * the people who own the platform.
   *
   * Derived from the server's list instead, in `useEffect` below, so the default
   * cannot drift from what the account has. `null` is a real state — "we have not
   * been told yet" — and rendering nothing is the correct answer to it.
   */
  const [selected2FAMethod, setSelected2FAMethod] = useState(null);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [maskedEmail, setMaskedEmail] = useState('');
  /**
   * A provider link waiting for the second factor to finish.
   *
   * `{ provider, linkToken }` when the user arrived from an OAuth callback, gave
   * the right password, and the account then asked for a second factor. Held here
   * rather than in `location.state` so that switching to the 2FA screen does not
   * leave `linkData` pinning `mode` at `'link'`. See `handleLinkSignIn`.
   */
  const [pendingLink, setPendingLink] = useState(null);
  /**
   * The demo sign-in shortcuts, read from the server rather than written here.
   *
   * The array that used to live at the top of this file listed
   * "System Admin · admin@example.gov", an account that had been DELETED on the
   * pilot deployment — so the sign-in screen offered a one-tap credential that
   * answered "No account found with that email address". See the endpoint's
   * header in server/routes/authRoutes.js for why the fix is a query rather than
   * a shorter literal.
   */
  const [demoAccounts, setDemoAccounts] = useState([]);
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { run, modal: verifyModal } = useStepUp();
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
  // '2fa' is not in URL so it doesn't persist across refresh
  const [internalMode, setInternalMode] = useState(null);
  
  /**
   * `email` belongs in this list, and its absence made password sign-in
   * unreachable.
   *
   * `setMode('email')` writes `?mode=email` and clears `internalMode`. With
   * `email` missing from the allowed URL modes, the expression fell through to
   * `'login'` — so the whole `mode === 'email'` block below was dead code and
   * the "Sign in with email" button on the method picker did nothing at all.
   * There was no error and no console warning; the page simply did not move.
   */
  const URL_MODES = ['forgot', 'forgot-success', 'email'];

  const mode = internalMode || (linkData ? 'link' : (URL_MODES.includes(urlMode) ? urlMode : 'login'));

  const setMode = (next) => {
    if (next === '2fa') {
      setInternalMode('2fa');
      return;
    }
    setInternalMode(null);
    const params = new URLSearchParams(searchParams);
    if (next === 'login') params.delete('mode');
    else params.set('mode', next);
    setSearchParams(params, { replace: false });
  };

  const [sentTo, setSentTo] = useState('');

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
  /* Held in a ref so the cooldown timer can be cleared on unmount — see
     `startCooldown`. */
  const cooldownTimer = useRef(null);
  useEffect(() => () => { if (cooldownTimer.current) clearInterval(cooldownTimer.current); }, []);
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

  /* Demo shortcuts, once, on arrival. `api.demoAccounts()` swallows its own
     failures and returns `[]`, so a non-demo server simply renders none. */
  useEffect(() => {
    if (!DEMO_MODE) return;
    let live = true;
    api.demoAccounts().then(list => { if (live) setDemoAccounts(list); });
    return () => { live = false; };
  }, []);

  /**
   * The selected method follows the account, and cannot be one it does not have.
   *
   * Preference order is strongest-first: an authenticator app beats an emailed
   * code, and a recovery code is a last resort rather than a default — landing on
   * it would invite somebody to burn a single-use credential when an ordinary one
   * was available. `availableMethods` is already narrowed server-side, so this
   * only chooses among what is genuinely on offer.
   */
  useEffect(() => {
    if (!availableMethods.length) {
      setSelected2FAMethod(null);
      return;
    }
    setSelected2FAMethod(prev => (
      prev && availableMethods.includes(prev)
        ? prev
        : ['totp', 'email', 'recovery'].find(m => availableMethods.includes(m)) ?? null
    ));
  }, [availableMethods]);

  /**
   * The other way into the second-factor screen: signing in with a provider.
   *
   * `OAuthCallback` sends the user here with `state.twoFactorRequired` and the
   * methods the server offered, exactly as the password path does with
   * `result.require2FA`. This screen read only `state.linkData`, so that state
   * was dropped on the floor — and the user landed on the method picker holding a
   * valid preauth cookie, with no form to spend it on and no way back except
   * starting the whole provider round trip again.
   *
   * Runs once on arrival. `setMode('2fa')` writes `internalMode` rather than the
   * URL deliberately (see `setMode`): a half-authenticated state must not survive
   * a refresh, because the preauth cookie behind it expires in fifteen minutes
   * and a restored form for a dead grant is a worse dead end than none.
   */
  useEffect(() => {
    if (!location.state?.twoFactorRequired) return;
    /* No `|| ['totp','recovery']` fallback. A hardcoded default is how the
       authenticator field came to be shown to accounts that have no
       authenticator; if the server did not say, we show the "nothing to offer"
       branch rather than guessing. */
    setAvailableMethods(location.state.availableMethods || []);
    setMode('2fa');
    /* Clear it so a later in-app navigation back to /login does not re-enter the
       2FA screen for a grant that has since been spent or expired. */
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.twoFactorRequired]);

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
   * Sign in, then finish the link — in that order, in one screen.
   *
   * ── Why the old form could not work (v1.2b) ──
   *
   * `POST /api/oauth/link` used to be unauthenticated, tied to an account only
   * by a 15-minute token naming a user id and proved by that account's password
   * — which made it a password oracle on an endpoint nobody thought of as one.
   * Task 6 made it authenticated and gated it on `requireAAL2('oauth.link')`, so
   * a signed-out caller now gets 401 before the handler runs. The form was still
   * passing that password into the argument that had become the headers object,
   * so it asked for a credential nothing checked and reported "Incorrect
   * password." whatever the user typed.
   *
   * ── Why this does the link here rather than sending them to Settings ──
   *
   * We still hold the link token, and it is valid for fifteen minutes. Using it
   * costs the user one verification. Sending them to Settings to press
   * "Continue with <provider>" again costs them the same verification PLUS a
   * second round trip through the provider, to reach the `auto_linked` branch
   * and end in exactly the same state. Same proof, less work.
   *
   * ── Why the order matters ──
   *
   * Both steps happen before `onLoginSuccess()`. That call makes App re-render
   * into the authenticated shell, which unmounts this component — and with it
   * the verification dialog and the token held in `location.state`. So: sign in
   * to get a session, spend a grant to link, and only then hand over.
   *
   * A failure after sign-in is not a failure overall: the session is real and
   * the user is signed in. Saying so, and naming Settings as the other way to
   * finish, beats reporting an error for something that half worked.
   *
   * ── Why the second factor is handled here (the "Google sign-in is broken" bug) ──
   *
   * `api.login()` does not always produce a session. For an account with a second
   * factor it returns `{ require2FA: true }` and issues only the fifteen-minute
   * `wev_preauth` cookie; the session exists only after `POST /api/auth/login-2fa`.
   * This handler ignored that and went straight on to `POST /api/oauth/link`,
   * which is behind `authenticateToken` — so the request was answered
   * `401 Access token required` and the user was shown
   *
   *     "Signed in, but we could not connect Google: Access token required."
   *
   * Every clause of which was wrong: they were not signed in, nothing was
   * connected, and the missing token was this application's session rather than
   * anything of Google's. Reproduced against a scratch database: the 401 body is
   * exactly `{"error":"Access token required"}`.
   *
   * It is the ONLY way a linked provider can be adopted by an account that has
   * 2FA on, so it locked every administrator out of provider sign-in — and both
   * pilot super-administrators have a second factor.
   *
   * So a `require2FA` answer now routes into the second-factor screen with the
   * link token still in hand, and the link is completed after that screen mints
   * the session. `pendingLink` is what carries it across.
   */
  const handleLinkSignIn = async (e) => {
    e.preventDefault();
    setError('');
    setErrorField(null);
    setLoading(true);

    const label = providerLabel(linkData.provider);
    let signIn;
    try {
      signIn = await api.login(linkData.email, password);
    } catch (err) {
      setError(err.message || 'That password is not correct.');
      const code = err.data?.code;
      setErrorField(code === 'wrong_password' ? 'password' : null);
      setLoading(false);
      return;
    }

    /**
     * A second factor stands between the password and a session.
     *
     * The link token is held in component state rather than in `location.state`,
     * because `setMode('2fa')` re-renders this same component and `linkData` would
     * otherwise keep `mode` pinned at `'link'`. `finishPendingLink` picks it up
     * once `handle2FASubmit` has a real session.
     */
    if (signIn?.require2FA) {
      setPendingLink({ provider: linkData.provider, linkToken: linkData.linkToken });
      setAvailableMethods(signIn.availableMethods || []);
      setPassword('');
      setMode('2fa');
      setLoading(false);
      return;
    }

    await completeLink({ provider: linkData.provider, linkToken: linkData.linkToken }, label);
    onLoginSuccess();
  };

  /**
   * Spend a grant to attach the provider identity, once a session exists.
   *
   * Extracted so the two ways of reaching this point — password only, and
   * password plus a second factor — cannot drift apart. The caller is
   * responsible for `onLoginSuccess()`: it unmounts this component, so it has to
   * be last.
   *
   * Never throws. Every outcome here is reported as a toast because the sign-in
   * itself has already succeeded, and turning "your provider is not connected
   * yet" into a failed sign-in would be a worse answer than the truth.
   */
  const completeLink = async (pending, label) => {
    try {
      const linked = await run(
        STEP_UP.OAUTH_LINK,
        { provider: pending.provider },
        headers => api.linkOAuthAccount(pending.linkToken, headers)
      );

      if (linked) addToast(`Signed in, and ${label} is now connected.`, 'success');
      // Dismissed the verification. They are still signed in, which is the
      // outcome that matters most here; the link is one tap away in Settings.
      else addToast(`Signed in. You can connect ${label} from Settings.`, 'info');
    } catch (err) {
      addToast(
        `Signed in, but we could not connect ${label}: ${err.message || 'please try from Settings.'}`,
        'error'
      );
    }
  };

  /**
   * The ordinary sign-in path.
   *
   * The link screen does NOT go through this, and an intermediate draft that
   * did — via an `afterToast` callback — is worth naming so it is not
   * reintroduced. That screen has to sign in, spend a step-up grant and redeem
   * the link token before `onLoginSuccess()` unmounts it, and threading three
   * ordered steps through a callback on the last of them made the ordering
   * invisible at exactly the place it matters. It has its own handler instead.
   */
  const performLogin = async (loginId, loginPassword) => {
    setError('');
    setErrorField(null);
    setLoading(true);
    try {
      const result = await api.login(loginId, loginPassword);
      
      if (result.require2FA) {
        setAvailableMethods(result.availableMethods || []);
        setMode('2fa');
        setLoading(false);
        return;
      }
      
      if (result.suspension) {
        /**
         * No toast at all, and no greeting.
         *
         * The sign-in genuinely succeeded, so the error channel would be wrong;
         * "Welcome back" would be worse. The screen they are about to land on
         * says what happened in full, and a cheerful banner floating over it is
         * the product failing to read the room at the worst moment it has with
         * this person. Checked before `emailVerified`, because App shows the
         * suspension wall above the verification wall for the same reason.
         */
      } else if (result.emailVerified === false) {
        // App routes an unconfirmed session to the confirmation screen; saying
        // "welcome back" first would be misleading about what happens next.
        addToast('Confirm your email address to finish signing in.', 'info');
      } else {
        addToast(`Welcome back, ${result.user.name.split(' ')[0]}.`, 'success');
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

  /**
   * Starts the visible cooldown, and clears its timer on unmount.
   *
   * The interval used to be created inline and never cleared, so it kept
   * ticking — and calling `setEmailCooldown` — after a successful sign-in
   * unmounted this screen.
   */
  const startCooldown = (seconds) => {
    setEmailCooldown(seconds);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      setEmailCooldown(prev => {
        if (prev <= 1) { clearInterval(cooldownTimer.current); cooldownTimer.current = null; return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  /**
   * Clears everything the second-factor screen learned about one person.
   *
   * Named rather than inlined because there is more than one way off this screen
   * and every one of them owes the next person a blank slate.
   */
  const resetSecondFactorScreen = () => {
    setMode('login');
    setInternalMode(null);
    setTfaToken('');
    setSelected2FAMethod(null);
    setAvailableMethods([]);
    setEmailCodeSent(false);
    setMaskedEmail('');
    setEmailCooldown(0);
    setError('');
    if (cooldownTimer.current) { clearInterval(cooldownTimer.current); cooldownTimer.current = null; }
  };

  const sendEmailCode = async () => {
    try {
      setLoading(true);
      const result = await api.send2FAEmailCode();
      setMaskedEmail(result.maskedEmail || '');
      setEmailCodeSent(true);
      startCooldown(60);
      setLoading(false);
    } catch (err) {
      setError(err.message || 'Could not send email code.');
      /**
       * A refused SEND does not mean there is no code to type.
       *
       * The cooldown 429 fires precisely because a code was just sent and is
       * still live — and a delivery failure can happen after the code was
       * stored. Leaving `emailCodeSent` false hid the input and the Verify
       * button, so somebody holding a perfectly good code in their inbox was
       * left on a screen offering only the button that had just refused them.
       * The field is revealed for both, because in both cases a code may exist.
       */
      if (err.status === 429 || err.data?.code === 'delivery_failed') {
        setEmailCodeSent(true);
        if (err.data?.retryAfter) startCooldown(err.data.retryAfter);
        /* Revealing the field is half the fix; the other half is saying why it
           appeared. Without this the banner reads "wait 43 seconds" beside a box
           the user has no reason to think is already usable. */
        setError(
          `${err.message || 'Could not send another code.'} `
          + 'If the earlier code has arrived, you can enter it below.'
        );
      }
      setLoading(false);
    }
  };

  const handle2FASubmit = async (e) => {
    e.preventDefault();
    const value = tfaToken.trim();
    if (!value) return setError('Enter your verification code.');
    setError('');
    setLoading(true);
    
    try {
      const payload = {};
      if (selected2FAMethod === 'totp') {
        payload.method = 'totp';
        payload.token = value;
      } else if (selected2FAMethod === 'email') {
        payload.method = 'email';
        payload.code = value;
      } else {
        payload.method = 'recovery';
        payload.code = value;
      }
      
      const result = await api.login2FA(payload.token || null, payload.code || null, payload.method);

      /**
       * The link the user came here to make, now that a session exists.
       *
       * Before the toast, because `completeLink` opens the verification dialog
       * and a "Welcome back" floating over it reads as though the sign-in had
       * already finished. Its own toast reports the link either way.
       */
      if (pendingLink) {
        const label = providerLabel(pendingLink.provider);
        setPendingLink(null);
        await completeLink(pendingLink, label);
        onLoginSuccess();
        return;
      }

      if (result.emailVerified === false) {
        addToast('Confirm your email address to finish signing in.', 'info');
      } else {
        addToast(`Welcome back, ${result.user.name.split(' ')[0]}.`, 'success');
      }

      /**
       * Say on SCREEN that a recovery code was spent, not only in the bell.
       *
       * The server returns `recoveryCodesRemaining` precisely so this moment can
       * mention it, and discarding it meant somebody could burn their LAST code
       * and read "Welcome back, Ana" — learning what they had done only if they
       * happened to open a notification. The count matters most at zero, which
       * is exactly when the next sign-in will fail.
       */
      if (typeof result.recoveryCodesRemaining === 'number') {
        addToast(
          result.recoveryCodesRemaining === 0
            ? 'That was your last recovery code. Create a new set in Settings — without one you '
              + 'cannot get back in if you lose your authenticator.'
            : `Recovery code used. You have ${result.recoveryCodesRemaining} left.`,
          result.recoveryCodesRemaining === 0 ? 'error' : 'info'
        );
      }

      onLoginSuccess();
    } catch (err) {
      setError(err.message || 'Invalid code.');
      /**
       * The server corrects the method list on refusal; honour it.
       *
       * `method_unavailable` and `verification_unavailable` both carry
       * `availableMethods`, precisely so the picker can re-narrow. Discarding it
       * left the radio for a method that had just been refused still selected,
       * so every resubmit repeated the same refusal until a reload — the exact
       * loop the server's named refusal exists to break.
       */
      if (Array.isArray(err.data?.availableMethods)) {
        setAvailableMethods(err.data.availableMethods);
      }
      setLoading(false);
    }
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

  if (mode === '2fa') {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow" aria-labelledby="tfa-heading">
          {verifyModal}
          {/**
            * Leaving the second-factor step forgets the person who started it.
            *
            * This used to reset `mode` and `internalMode` only, so
            * `maskedEmail`, `emailCodeSent`, `emailCooldown` and
            * `availableMethods` all survived. On a shared school device that
            * meant: student A authenticates with their password, sends an email
            * code, presses Back and walks off; student B signs in with their own
            * password and lands on a screen reading "6-digit code sent to
            * jo***@sbschools.org" — A's address — with the Send button hidden
            * behind A's countdown.
            *
            * The pre-auth grant is a cookie the server clears on its own terms,
            * so this is about what the SCREEN remembers. It should remember
            * nothing about somebody who walked away.
            */}
          <button className="auth-back" onClick={resetSecondFactorScreen}>
            <ArrowLeft size={16} aria-hidden="true" /> Back to sign in
          </button>
          
          <div className="auth-head">
            <h1 id="tfa-heading" className="auth-title">Verify your identity</h1>
            <p className="auth-subtitle">
              {/*
                The subtitle describes what is actually on screen. "Choose a
                verification method" was printed even when the account had one
                method and there was nothing to choose.
              */}
              {availableMethods.length > 1
                ? 'Choose a verification method to continue.'
                : availableMethods.includes('email')
                  ? 'We will email you a code to finish signing in.'
                  : availableMethods.includes('totp')
                    ? 'Enter the code from your authenticator app to continue.'
                    : availableMethods.includes('recovery')
                      ? 'Enter one of your recovery codes to continue.'
                      : 'We could not find a second factor for this account.'}
            </p>
          </div>

          {errorBanner}

          {/*
            Only the methods this account holds, and only a picker when there is
            something to pick.

            `recovery` used to render unconditionally, so an account with no
            recovery codes was offered the one method guaranteed to fail — on the
            screen where it is already the user's last resort. The server now
            reports recovery only when codes exist (`enabledSecondFactors` in
            server/utils.js) and refuses any method not on that list, so this row
            and the server agree by construction rather than by coincidence.
          */}
          {availableMethods.length === 0 ? (
            <div className="alert alert-danger" role="alert">
              This account has no second factor set up, so there is nothing to
              verify here. Sign in again, or ask an administrator to help you
              back in.
            </div>
          ) : availableMethods.length > 1 ? (
            <div className="tfa-methods" role="radiogroup" aria-label="Verification method">
              {availableMethods.includes('totp') && (
                <label className={`tfa-method${selected2FAMethod === 'totp' ? ' active' : ''}`}>
                  <input type="radio" name="tfa-method" value="totp" checked={selected2FAMethod === 'totp'} onChange={() => { setSelected2FAMethod('totp'); setTfaToken(''); setError(''); }} />
                  <Shield size={18} />
                  <div>
                    <span className="strong">Authenticator app (recommended)</span>
                    <span className="dim small">Use your authenticator app to generate a code</span>
                  </div>
                </label>
              )}
              {availableMethods.includes('email') && (
                <label className={`tfa-method${selected2FAMethod === 'email' ? ' active' : ''}`}>
                  <input type="radio" name="tfa-method" value="email" checked={selected2FAMethod === 'email'} onChange={() => { setSelected2FAMethod('email'); setTfaToken(''); setError(''); }} />
                  <Mail size={18} />
                  <div>
                    <span className="strong">Email code</span>
                    <span className="dim small">Send a verification code to your email</span>
                  </div>
                </label>
              )}
              {availableMethods.includes('recovery') && (
                <label className={`tfa-method${selected2FAMethod === 'recovery' ? ' active' : ''}`}>
                  <input type="radio" name="tfa-method" value="recovery" checked={selected2FAMethod === 'recovery'} onChange={() => { setSelected2FAMethod('recovery'); setTfaToken(''); setError(''); }} />
                  <Key size={18} />
                  <div>
                    <span className="strong">Recovery code</span>
                    <span className="dim small">Use one of your single-use backup codes</span>
                  </div>
                </label>
              )}
            </div>
          ) : null}

          {/* No method means no form. Rendering the fields against
              `selected2FAMethod === null` would show nothing but a Verify button
              that cannot succeed. */}
          {selected2FAMethod && (
          <form onSubmit={handle2FASubmit} className="stack-md" noValidate>
            {selected2FAMethod === 'totp' && (
              <div className="field">
                <label htmlFor="tfa-code">6-digit code</label>
                <input
                  id="tfa-code"
                  type="text"
                  className="input input-lg"
                  value={tfaToken}
                  onChange={e => setTfaToken(e.target.value)}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
              </div>
            )}
            {selected2FAMethod === 'email' && (
              <>
                {!emailCodeSent ? (
                  <button type="button" className="btn btn-secondary btn-block btn-lg" onClick={sendEmailCode} disabled={loading}>
                    Send code to email
                  </button>
                ) : (
                  <div className="field">
                    <label htmlFor="tfa-code">6-digit code sent to {maskedEmail || 'your email'}</label>
                    <input
                      id="tfa-code"
                      type="text"
                      className="input input-lg"
                      value={tfaToken}
                      onChange={e => setTfaToken(e.target.value)}
                      placeholder="000000"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                    />
                    <div style={{ marginTop: 'var(--s2)', textAlign: 'right' }}>
                      <button type="button" className="auth-link small" onClick={sendEmailCode} disabled={loading || emailCooldown > 0}>
                        {emailCooldown > 0 ? `Resend in ${emailCooldown}s` : 'Resend code'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            {selected2FAMethod === 'recovery' && (
              <div className="field">
                <label htmlFor="tfa-code">10-character recovery code</label>
                <input
                  id="tfa-code"
                  type="text"
                  className="input input-lg"
                  value={tfaToken}
                  onChange={e => setTfaToken(e.target.value)}
                  placeholder="XXXXXXXXXX"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
                <span className="field-hint" style={{ color: 'var(--warn-ink)', display: 'flex', alignItems: 'center', marginTop: '4px' }}>
                  <AlertCircle size={12} style={{ display: 'inline', marginRight: '4px' }} />
                  Warning: recovery codes are single-use.
                </span>
              </div>
            )}
            
            {!(selected2FAMethod === 'email' && !emailCodeSent) && (
              <button
                type="submit"
                className="btn btn-primary btn-block btn-lg"
                disabled={loading}
              >
                {loading ? 'Verifying…' : 'Verify'}
              </button>
            )}
          </form>
          )}
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
              The copy says sign in FIRST, because that is the order: the link is
              made after the session exists, and the verification that authorises
              it comes between the two. Promising "enter its password and you can
              use <provider> from then on" — which this screen used to say — is
              only true if the whole sequence completes, and it hid the
              verification step entirely.
            */}
            <p className="auth-subtitle">
              <strong>{linkData?.email}</strong> already has a WeVolunteer
              account. Sign in to it and we will connect {label} straight after —
              we will ask you to confirm it is you once more before we do.
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
              <button
                type="button"
                className="auth-link auth-inline-link small field-aside"
                onClick={() => { setMode('forgot'); setError(''); setErrorField(null); }}
              >
                Forgot?
              </button>
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
        {verifyModal}
      </div>
    );
  }

  /* ── Email Credentials ────────────────────────────────────────────── */
  if (mode === 'email') {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow" aria-labelledby="email-heading">
          <button className="auth-back" onClick={() => setMode('login')}>
            <ArrowLeft size={16} aria-hidden="true" /> Back
          </button>

          <div className="auth-head">
            <h1 id="email-heading" className="auth-title">Sign in with email</h1>
            <p className="auth-subtitle">Enter your email or username and password.</p>
          </div>

          {errorBanner}

          <form onSubmit={signIn} className="stack-md" noValidate>
            <div className="field">
              <label htmlFor="login-identifier">Email or username</label>
              <div className="input-affix">
                <User size={16} aria-hidden="true" />
                <input
                  id="login-identifier"
                  name="username"
                  type="text"
                  className="input input-lg"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  placeholder="you@example.com"
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

            {/**
              * `field-with-aside`: the label and "Forgot?" share a row VISUALLY,
              * but "Forgot?" comes after the input in DOM order.
              *
              * It used to sit inside the label row, which put it between the two
              * inputs in the tab sequence. Typing an email, pressing Tab, typing a
              * password and pressing Enter — the sequence every keyboard user
              * performs — focused "Forgot?", swallowed the password keystrokes,
              * and then activated it: you arrive on "Reset your password" having
              * lost what you typed, with nothing explaining why.
              *
              * A grid places it back in the label row, so nothing moves on screen
              * and Tab goes identifier -> password -> Forgot? -> show/hide. Doing
              * it with CSS rather than `tabindex` keeps one source of truth for
              * the order: a positive tabindex here would have to be matched by
              * every other control on the screen.
              */}
            <div className="field field-with-aside">
              <label htmlFor="login-password">Password</label>
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

          {/*
            `demoAccounts.length`, not `DEMO_MODE`, decides whether this renders.

            The flag says the BUNDLE was built for a demo; the list says the
            SERVER has accounts to offer. When they disagree — a demo build
            pointed at a database whose demo accounts have been deleted — the
            heading "Demo accounts — password password123" over an empty grid is
            worse than nothing.
          */}
          {DEMO_MODE && demoAccounts.length > 0 && (
            <div className="auth-demo" style={{ marginTop: 'var(--s6)' }}>
              <div className="eyebrow" style={{ textAlign: 'center', marginBottom: 'var(--s3)' }}>
                Demo accounts — password “password123”
              </div>
              <div className="auth-demo-grid">
                {demoAccounts.map(acc => (
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
          <span className="sr-only" role="status" aria-live="polite">
            {loading ? 'Signing in' : ''}
          </span>
        </main>
      </div>
    );
  }

  /* ── Method Selection (default login) ─────────────────────────────── */
  return (
    <div className="auth">
      <main className="auth-form auth-form-narrow" aria-labelledby="login-heading">
        <button className="auth-back" onClick={() => navigate('/welcome')}>
          <ArrowLeft size={16} aria-hidden="true" /> Back
        </button>

        <div className="auth-head">
          <h1 id="login-heading" className="auth-title">Welcome back</h1>
          <p className="auth-subtitle">Choose how you want to sign in.</p>
        </div>

        {errorBanner}

        <ProviderButtons onSelect={startOAuth} disabled={loading} />

        <div className="auth-divider" role="separator">or</div>
        
        <button className="btn btn-secondary btn-block btn-lg" onClick={() => { setMode('email'); setError(''); setErrorField(null); }} disabled={loading}>
          <Mail size={18} aria-hidden="true" style={{ marginRight: '8px' }} />
          <span>Sign in with email</span>
        </button>

        <div className="auth-footer" style={{ marginTop: 'var(--s6)' }}>
          Don't have an account?{' '}
          <button className="auth-link" onClick={() => navigate('/signup')}>Create one</button>
        </div>

        {/* "Legal Center", matching the Settings entry and the page's own title.
            This said "Terms, privacy and safety policies" — the old wording, which
            named three of ten documents and did not match the destination. A link
            whose label differs from the heading it lands on makes a reader wonder
            whether they arrived somewhere else. */}
        <p className="auth-footer">
          <a className="auth-link" href="/legal">Legal Center</a>
        </p>

        <span className="sr-only" role="status" aria-live="polite">
          {loading ? 'Loading…' : ''}
        </span>
      </main>
    </div>
  );
}
