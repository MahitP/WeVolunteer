import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  isLocalAIEnabled,
  detectCapability,
  offerableModels,
  modelById,
  formatBytes,
  forgetVerifications,
  aiStorage,
  isAbort,
} from '../../ai';
import { readPreferences, writePreferences, clearPreferences } from '../../ai/preferences';
import AIEnableModal, { AIUnsupportedNotice } from './AIEnableModal';
import ConfirmDialog from '../common/ConfirmDialog';

/**
 * The on-device assistant's controls, in Settings under Privacy.
 *
 * ── Why it sits with the privacy controls and not on its own screen ──
 *
 * Everything a person needs to decide about this feature is a privacy question:
 * what is downloaded, from whom, what is kept on the device, and how to get rid
 * of it. Putting it beside the other switches that answer "who can see what"
 * keeps those questions in one place.
 *
 * It differs from its neighbours in one way that is deliberate and worth
 * knowing: these settings are stored on this device only and are never sent to
 * the server. See `src/ai/preferences.js` for why.
 *
 * ── The states ──
 *
 *   build flag off  render nothing at all
 *   unsupported     explain, offer nothing
 *   off             one button, which opens the dialog that explains the trade
 *   downloading     determinate progress and a cancel that genuinely cancels
 *   ready           what is installed, how large, and how to remove it
 *   error           what went wrong, in words, and a way to try again
 */
export default function AISettingsCard({ addToast }) {
  const [prefs, setPrefs] = useState(() => readPreferences());
  const [capability] = useState(() => detectCapability());
  const [picking, setPicking] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [usedBytes, setUsedBytes] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const cardRef = useRef(null);

  const abortRef = useRef(null);
  /* Downloads outlive a fast navigation away from Settings; without this the
     completion handler would set state on an unmounted component. */
  const aliveRef = useRef(true);
  useEffect(() => {
    /**
     * Set on the way IN as well as cleared on the way out.
     *
     * A cleanup-only effect leaves this stuck at `false` under StrictMode, which
     * double-invokes effects in development: mount, cleanup, mount again. The
     * ref survives that simulated remount because React keeps the same
     * component instance, so `useRef(true)` does not run a second time and
     * nothing ever sets it back.
     *
     * Every guard in this component then fails closed for the rest of the
     * session, and the symptom is a feature that looks broken rather than one
     * that errors: the model downloads correctly, `onProgress` is dropped so the
     * bar sits at "0 MB of 940 MB", the completion handler returns before
     * writing preferences so the 940 MB that just landed is never recognised,
     * and `finally` never clears the progress state so it says "Downloading"
     * forever. WellyView.jsx already does this correctly.
     */
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const installed = prefs.modelId ? modelById(prefs.modelId) : null;

  const refreshUsage = useCallback(async () => {
    if (!isLocalAIEnabled() || !capability.supported) return;
    try {
      const storage = await aiStorage();
      const bytes = await storage.bytesUsed();
      if (aliveRef.current) setUsedBytes(bytes);
    } catch {
      /* Reporting storage is a convenience. Failing to read it must not take
         the rest of the panel down with it. */
    }
  }, [capability.supported]);

  useEffect(() => { refreshUsage(); }, [refreshUsage]);

  /**
   * Arriving here from Welly's mode control, which links to `/settings#welly-ai`.
   *
   * A bare fragment does not work with client-side routing: the browser resolves
   * it when the document loads, and this card is mounted afterwards by the
   * router, by which time nothing is looking for it. Scrolling once on mount is
   * the whole fix, and it is scoped to the one hash so an ordinary visit to
   * Settings still opens at the top.
   */
  useEffect(() => {
    if (window.location.hash !== '#welly-ai') return;
    cardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    /* From the Welly AI offer on Discover (ruling 7): `setup=1` opens the
       setup dialog straight away, so "Set up Welly AI" does what it says. */
    if (new URLSearchParams(window.location.search).get('setup') === '1'
      && capability.supported && !readPreferences().enabled) {
      setPicking(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = useCallback(async (model) => {
    setPicking(false);
    setError(null);
    setProgress({ loaded: 0, total: model.bytes });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const storage = await aiStorage();
      await storage.downloadModel(model, {
        signal: controller.signal,
        onProgress: p => { if (aliveRef.current) setProgress(p); },
      });

      if (!aliveRef.current) return;
      setPrefs(writePreferences({ enabled: true, modelId: model.id }));
      addToast?.(`${model.label} is ready to use on this device.`, 'success');
      refreshUsage();
    } catch (err) {
      if (!aliveRef.current) return;
      /* Cancelling is not a failure and must not be reported as one. */
      if (!isAbort(err)) {
        setError(err.userMessage || 'The model could not be downloaded. Please try again.');
      }
    } finally {
      if (aliveRef.current) setProgress(null);
      abortRef.current = null;
    }
  }, [addToast, refreshUsage]);

  const removeEverything = useCallback(async () => {
    setConfirmRemove(false);
    try {
      const storage = await aiStorage();
      await storage.removeAllModels();
    } catch {
      /* Fall through: the preferences are cleared either way, so the feature
         is off even if the bytes could not be reclaimed. */
    }
    forgetVerifications();
    clearPreferences();
    setPrefs(readPreferences());
    setUsedBytes(0);
    addToast?.('Welly is off and the downloaded model has been removed.', 'success');
  }, [addToast]);

  /* A build without the feature renders nothing — not a disabled control, which
     would advertise something no amount of clicking can produce. */
  if (!isLocalAIEnabled()) return null;

  return (
    <div id="welly-ai" ref={cardRef} className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
      <h3 style={{ marginBottom: 'var(--s4)' }}>Welly Assistant</h3>

      <div className="stack-md">
        <div className="stack-xs" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 'var(--s3)' }}>
          <span className="strong">Welly Chat</span>
          <p className="dim small" style={{ margin: 0 }}>
            Your regular WeVolunteer assistant. Always available to help you navigate, discover events, and answer questions.
          </p>
        </div>

        <div className="stack-sm">
          <div className="stack-xs">
            <span className="strong">Welly AI</span>
            <p className="dim small" style={{ margin: 0 }}>
              AI that runs on your device. Setting it up downloads a model from Hugging Face, and it can be removed again at any time. Welly writes its replies on this machine; looking things up still goes to WeVolunteer.{' '}
              <Link to="/legal/ai-and-on-device-processing">How this works</Link>.
            </p>
          </div>

          {!capability.supported && <AIUnsupportedNotice reason={capability.reason} />}

          {capability.supported && (
            <div className="stack-sm">
              {!prefs.enabled && !progress && (
                <div>
                  <button className="btn btn-primary" onClick={() => setPicking(true)}>
                    Set up Welly AI
                  </button>
                </div>
              )}

              {progress && (
                <div className="stack-xs">
                  <label className="small strong" htmlFor="ai-download-progress">
                    Downloading Welly AI Model
                  </label>
                  <progress
                    id="ai-download-progress"
                    max={progress.total || 1}
                    value={progress.loaded || 0}
                  />
                  <span className="dim small">
                    {formatBytes(progress.loaded || 0)} of {formatBytes(progress.total || 0)}
                  </span>
                  <div>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => abortRef.current?.abort()}
                    >
                      Cancel download
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <p className="alert alert-danger" role="alert">{error}</p>
              )}

              {prefs.enabled && installed && !progress && (
                <div className="stack-sm">
                  <div className="stack-xs">
                    <div className="row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
                      <span className="strong">{installed.label}</span>
                      <span className="badge badge-subtle">Welly AI Active</span>
                    </div>
                    <span className="dim small">
                      {installed.parameters} parameters &middot; {installed.license}
                      {usedBytes != null && <> &middot; using {formatBytes(usedBytes)} on this device</>}
                    </span>
                  </div>


                  <label className="row" style={{ alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={prefs.saveConversations}
                      onChange={e => setPrefs(writePreferences({ saveConversations: e.target.checked }))}
                    />
                    <div className="stack-xs" style={{ flex: 1 }}>
                      <span className="strong">Pick up where I left off</span>
                      <span className="dim small">
                        On, your conversation is still here when you come back. Off, it
                        clears when you close the tab. Either way it never leaves this
                        browser. Off by default because school computers are often shared.
                      </span>
                    </div>
                  </label>

                  <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setPicking(true)}>
                      Change model
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => setConfirmRemove(true)}>
                      Turn off and remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {picking && (
        <AIEnableModal
          capability={capability}
          models={offerableModels(capability)}
          initialModelId={prefs.modelId}
          onConfirm={download}
          onClose={() => setPicking(false)}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Turn off Welly AI?"
          destructive
          confirmLabel="Turn off and remove"
          onConfirm={removeEverything}
          onCancel={() => setConfirmRemove(false)}
        >
          <p>
            This removes the downloaded model from this device and forgets your Welly AI
            settings. Welly Chat will remain available as your regular assistant.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
