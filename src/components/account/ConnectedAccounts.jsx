import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';
import { AlertCircle, Link as LinkIcon, Unlink, Check } from 'lucide-react';
import ProviderMark from '../auth/ProviderMark';
import ConfirmDialog from '../common/ConfirmDialog';
import { useStepUp } from '../auth/useStepUp';
import { STEP_UP } from '../../utils/stepUp';

export default function ConnectedAccounts({ addToast, currentUser }) {
  const [providers, setProviders] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(null); // { id, label } | null
  const { verifyFirst, modal: verifyModal } = useStepUp();

  const load = useCallback(async () => {
    try {
      /*
       * Both of these calls previously sent `Authorization: Bearer
       * ${api.token}` — and `api.token` has never existed on the api object,
       * so the literal string "Bearer undefined" went out on every request.
       * They worked at all only because the session cookie rode along by
       * accident. Going through `api` uses credentials: 'include' and the real
       * session, which also makes silent linking below possible.
       */
      const [providerList, accountList] = await Promise.all([
        api.fetchOAuthProviders(),
        api.fetchConnectedAccounts()
      ]);
      setProviders(providerList);
      setAccounts(accountList);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load your connected accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * ── Verify FIRST, then redirect (v1.2b Task 6b) ──
   *
   * This is the one gated action that cannot be attempted-then-retried, and the
   * reason is structural: the link is written by the OAuth callback's
   * `auto_linked` branch, which arrives mid-redirect back from the provider.
   * There is no request here to receive a `reauth_required` and repeat, and no
   * moment during a callback at which the user can be asked for anything.
   *
   * So the challenge is opened and satisfied before leaving the page, and its id
   * is handed to `/api/oauth/:provider/url`, which folds it into the signed
   * state. The callback spends it in the same transaction as the insert.
   *
   * Verifying before the redirect also happens to be the better order for the
   * user: being sent to Google and only then told to prove who you are would
   * mean two round trips through a provider for one action.
   *
   * The server reads the signed-in user from the session cookie when it builds
   * the state. That path existed before but could never fire: the server looked
   * for the user in an Authorization header the client had stopped sending, so
   * connecting your own Google account to your own signed-in account demanded
   * your password — or, if the Google address differed from your account
   * address, dropped you into the signup form while you were already signed in.
   */
  const handleConnect = async (provider) => {
    setBusy(provider);
    try {
      const challengeId = await verifyFirst(STEP_UP.OAUTH_LINK, { provider });

      // Dismissed the verification. Nothing has been started, so there is
      // nothing to undo and nothing to apologise for.
      if (!challengeId) {
        setBusy(null);
        return;
      }

      const { url } = await api.startOAuth(provider, undefined, challengeId);
      window.location.href = url;
    } catch (err) {
      addToast(err.message || `Could not start connecting ${provider}.`, 'error');
      setBusy(null);
    }
  };

  const handleDisconnect = async ({ id, label }) => {
    setBusy(id);
    try {
      await api.disconnectOAuth(id);
      addToast(`${label} disconnected.`, 'success');
      setConfirming(null);
      await load();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <section className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
        <h3>Connected accounts</h3>
        <p className="dim small" role="status" aria-live="polite">Loading…</p>
      </section>
    );
  }

  const hasPassword = currentUser?.hasPassword !== false;
  const onlyWayIn = !hasPassword && accounts.length === 1;

  return (
    <section className="card card-pad" style={{ marginTop: 'var(--s4)' }} aria-labelledby="connected-heading">
      <h3 id="connected-heading" style={{ marginBottom: 'var(--s2)' }}>Connected accounts</h3>
      <p className="dim small" style={{ marginBottom: 'var(--s4)' }}>
        Sign in with a provider instead of typing a password.
        {onlyWayIn && ' This is currently your only way to sign in, so it cannot be removed until you set a password above.'}
      </p>

      {error && (
        <div className="alert alert-danger" role="alert" style={{ marginBottom: 'var(--s4)' }}>
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <ul className="stack-md" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {providers.map(provider => {
          const connected = accounts.find(a => a.provider === provider.id);
          const unavailable = !provider.enabled;

          return (
            <li
              key={provider.id}
              className="row"
              style={{
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--s3)',
                padding: 'var(--s3)',
                border: '1px solid var(--rule)',
                borderRadius: 'var(--radius)'
              }}
            >
              <span className="row" style={{ alignItems: 'center', gap: 'var(--s3)', minWidth: 0 }}>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 36,
                    height: 36,
                    flex: 'none',
                    background: 'var(--bg-alt)',
                    borderRadius: 'var(--r-full)'
                  }}
                >
                  <ProviderMark provider={provider.id} />
                </span>
                <span className="stack-xs" style={{ minWidth: 0 }}>
                  <span className="strong">{provider.label}</span>
                  <span className="dim small truncate">
                    {!provider.implemented ? 'Not available yet'
                      : unavailable ? 'Not set up on this site'
                        : connected
                          ? <><Check size={12} aria-hidden="true" /> Connected as {connected.provider_email}</>
                          : 'Not connected'}
                  </span>
                </span>
              </span>

              {!unavailable && (
                connected ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConfirming({ id: provider.id, label: provider.label })}
                    disabled={busy === provider.id}
                  >
                    <Unlink size={14} aria-hidden="true" />
                    <span>{busy === provider.id ? 'Working…' : 'Disconnect'}</span>
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleConnect(provider.id)}
                    disabled={busy === provider.id}
                  >
                    <LinkIcon size={14} aria-hidden="true" />
                    <span>{busy === provider.id ? 'Redirecting…' : 'Connect'}</span>
                  </button>
                )
              )}
            </li>
          );
        })}
      </ul>

      {confirming && (
        <ConfirmDialog
          title={`Disconnect ${confirming.label}?`}
          confirmLabel={`Disconnect ${confirming.label}`}
          destructive
          busy={busy === confirming.id}
          onConfirm={() => handleDisconnect(confirming)}
          onCancel={() => setConfirming(null)}
        >
          <p>You will no longer be able to sign in with it.</p>
          <p className="dim small">
            {hasPassword
              ? 'You can still sign in with your email address and password, and you can reconnect at any time.'
              : 'You can reconnect at any time.'}
          </p>
        </ConfirmDialog>
      )}
      {verifyModal}
    </section>
  );
}
