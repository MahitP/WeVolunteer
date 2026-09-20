import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { takePendingReauth, saveReadyGrant, clearReadyGrant } from '../utils/stepUp';
import BrandMark from '../components/common/BrandMark';

/**
 * Reads the provider out of the signed `state` the server issued.
 *
 * The previous implementation was `atob(state.split('.')[1])`. JWT payloads
 * are base64URL, which uses `-` and `_` where base64 uses `+` and `/`, and
 * omits `=` padding — so `atob` throws outright on many perfectly valid
 * tokens. The catch then fell back to the literal string 'google', which meant
 * a Microsoft sign-in was posted to the Google callback, failed the server's
 * provider check, and told the user "Sign-in provider mismatch". Intermittent,
 * because whether it broke depended on the random nonce inside the payload.
 *
 * Returns null rather than guessing: posting to the wrong provider cannot
 * succeed, so a clear error beats a coin flip.
 */
function providerFromState(state) {
  try {
    const payload = state.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = JSON.parse(
      decodeURIComponent(
        atob(padded)
          .split('')
          .map(c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
          .join('')
      )
    );
    return typeof json.provider === 'string' ? json.provider : null;
  } catch {
    return null;
  }
}

/** "google" → "Google". The provider name is a lowercase key on the wire. */
function providerLabel(provider) {
  return typeof provider === 'string' && provider
    ? provider.charAt(0).toUpperCase() + provider.slice(1)
    : 'That account';
}

export default function OAuthCallback({ onLoginSuccess, onLinked, addToast }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  /**
   * An authorization code is single use, and the server burns the state nonce
   * on first presentation. Two things would otherwise submit it twice:
   * StrictMode double-invokes effects in development, and this effect's
   * dependencies included `addToast` and `onLoginSuccess`, which App
   * re-creates on every render. The second attempt always fails, so a
   * successful sign-in was immediately painted over with an error.
   */
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;

    const code = searchParams.get('code');
    const state = searchParams.get('state');

    // Providers report user-facing failures (a declined consent screen) here
    // rather than by omitting the code. Saying "invalid parameters" to someone
    // who simply pressed Cancel is both wrong and alarming.
    const providerError = searchParams.get('error');
    if (providerError) {
      submitted.current = true;
      setError(
        providerError === 'access_denied'
          ? 'You cancelled the sign-in. Nothing was shared with WeVolunteer.'
          : searchParams.get('error_description') || 'The sign-in provider reported a problem. Please try again.'
      );
      return;
    }

    if (!code || !state) {
      submitted.current = true;
      setError('That sign-in link is incomplete. Please start again from the sign-in page.');
      return;
    }

    const provider = providerFromState(state);
    if (!provider) {
      submitted.current = true;
      setError('We could not tell which provider this sign-in came from. Please start again.');
      return;
    }

    submitted.current = true;

    /**
     * ── Step-up re-consent lands here too (v1.2b) ──
     *
     * A provider's redirect URI is fixed per deployment, so "prove who you are
     * again" comes back to the same address as an ordinary sign-in. The two must
     * not be confused: posting a re-verification's code to `/api/oauth/callback`
     * would be answered as a sign-in attempt, and the grant the user just earned
     * would never be created.
     *
     * `sessionStorage` is what tells them apart, and it is authoritative rather
     * than a hint: only this tab, having just started a re-verification, can have
     * written that record. The state itself also carries `purpose: 'reauth'`, and
     * the server checks it — so a record that has somehow gone stale cannot make
     * a sign-in state be redeemed as a verification, or the reverse.
     *
     * On success the user goes back where they started with the grant recorded,
     * and presses the button again. Resuming the original action automatically
     * would mean reconstructing intent — which form, which field values — from
     * across a full page navigation, and getting that wrong on `account.delete`
     * is unrecoverable. One deliberate press is the right price.
     */
    const pending = takePendingReauth();
    if (pending?.challengeId) {
      (async () => {
        const back = pending.returnTo || '/settings';
        try {
          await api.completeReauthOAuth(pending.provider || provider, code, state);
          saveReadyGrant({
            action: pending.action,
            challengeId: pending.challengeId,
            expiresAt: pending.expiresAt
          });
          addToast('Identity verified. Confirm the action to continue.', 'success');
          navigate(back, { replace: true });
        } catch (err) {
          // Deliberately does not strand the user on this screen: the thing they
          // were doing is elsewhere, and the message belongs next to it.
          clearReadyGrant();
          addToast(err?.data?.error || err?.message || 'That verification could not be completed.', 'error');
          navigate(back, { replace: true });
        }
      })();
      return;
    }

    (async () => {
      try {
        const data = await api.completeOAuth(provider, code, state);

        /**
         * Drop `code` and `state` from the address bar on success.
         *
         * They stay in browser history otherwise, so a refresh or a back
         * button re-submits a code that has already been spent — which reads
         * to the user as a random sign-in failure moments after signing in.
         */
        window.history.replaceState({}, '', '/oauth/callback');

        if (data.action === 'require_2fa') {
          navigate('/login', { 
            state: { 
              twoFactorRequired: true,
              /* Passed through as-is. A default of ['totp','recovery'] here
                 offered an authenticator to accounts that have none — see the
                 note on `selected2FAMethod` in Login.jsx. */
              availableMethods: data.availableMethods || []
            },
            replace: true 
          });
          return;
        }

        if (data.action === 'login') {
          if (data.emailVerified === false) {
            addToast('Signed in. Confirm your email address to finish setting up.', 'info');
          } else {
            addToast(`Welcome back, ${data.user.name.split(' ')[0]}.`, 'success');
          }
          onLoginSuccess();
        } else if (data.action === 'auto_linked') {
          /**
           * Only reachable from Settings → Connected accounts, because it is
           * the branch the server takes when the OAuth state carried an
           * existing session. Return the user to the screen they left rather
           * than to the dashboard — `onLoginSuccess` navigates to `/`, which
           * made a successful link look like an unexplained redirect.
           */
          addToast(`${providerLabel(data.provider)} connected.`, 'success');
          (onLinked || onLoginSuccess)();
        } else if (data.action === 'link_required') {
          navigate('/login', { replace: true, state: { linkData: data } });
        } else if (data.action === 'signup_required') {
          navigate('/signup', { replace: true, state: { signupData: data } });
        } else {
          setError('We got an unexpected response completing your sign-in. Please try again.');
        }
      } catch (err) {
        setError(err.message || 'We could not complete your sign-in. Please try again.');
      }
    })();
    // searchParams is the only real input; the callbacks are stable in effect
    // but not in identity, and re-running would replay a spent code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  if (error) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow" aria-labelledby="oauth-error-heading">
          <div className="auth-icon auth-icon-danger" aria-hidden="true">
            <AlertCircle size={28} />
          </div>
          <h1 id="oauth-error-heading" className="auth-title">We couldn't finish signing you in</h1>
          <div className="alert alert-danger" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
          <div className="stack-sm auth-actions">
            <button className="btn btn-primary btn-block btn-lg" onClick={() => navigate('/login', { replace: true })}>
              Back to sign in
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => navigate('/welcome', { replace: true })}>
              Start over
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="auth">
      <main className="auth-form auth-form-narrow auth-centered">
        {/* Announced politely so a screen reader reports the wait rather than
            leaving the user on a page that appears to be doing nothing. */}
        <div role="status" aria-live="polite" className="stack-md auth-centered">
          <div className="auth-icon" aria-hidden="true">
            <ShieldCheck size={28} />
          </div>
          {/* The one genuine full-page wait in the product, and the only
              spinner replaced by the brand loader: a segment of the stroke
              walks the mark over a ghost copy of it. The heading below is the
              announced status, so the mark stays decorative. `size="lg"` is
              required, not chosen — the mark must render at 32px or more to
              animate the frozen 12.5 stroke rather than the small-size 15.5.
              The app's skeletons and the inline location/weather spinners are
              deliberately left alone. */}
          <BrandMark size="lg" motion="loader" />
          <h1 className="auth-title">Completing sign-in…</h1>
          <p className="dim">Verifying your account with your provider. This only takes a moment.</p>
        </div>
      </main>
    </div>
  );
}
