import React, { lazy, Suspense, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { isLocalAIEnabled, detectCapability } from '../../ai';
import { readPreferences } from '../../ai/preferences';
import { useLocationContext } from '../../contexts/LocationContext';

/**
 * The way in.
 *
 * ── Shown only to somebody who already opted in ──
 *
 * Three conditions, all required: the build has the feature, the device can run
 * it, and this person has set it up in Settings. A launcher that appeared for
 * everyone would be an advertisement for a download, on a screen where students
 * are trying to do something else — and the repository has an explicit position
 * on nudging people into consent decisions, recorded beside the analytics
 * switch.
 *
 * ── Lazily imported ──
 *
 * The panel pulls in the assistant, the tools and the runtime boundary. Loading
 * that when the button is pressed rather than when the shell mounts keeps it
 * off the critical path for every page in the application.
 */
const AssistantPanel = lazy(() => import('./AssistantPanel'));

export default function AssistantLauncher() {
  /**
   * Every hook runs before any early return. `hookOrder.test.jsx` enforces
   * this repository-wide, and it is why the conditions below are evaluated
   * after `useState` and `useLocationContext` rather than short-circuiting
   * above them.
   */
  const [open, setOpen] = useState(false);

  /**
   * Whatever position the app already has. The assistant never asks for
   * location and never triggers the browser permission prompt — a conversation
   * is the wrong place to be interrupted by one. If it has been shared
   * elsewhere, distance works; if not, searches simply run without it.
   */
  /* Optional-chained because `useLocationContext` returns null outside a
     provider rather than throwing, and this component is mounted in the app
     shell — which several route tests render on its own. Destructuring
     directly turned an absent provider into a TypeError that took the whole
     shell down. */
  const location = useLocationContext()?.location;
  const position = location
    ? { lat: location.latitude, lng: location.longitude }
    : null;

  /* Read at render, not held in state: Settings can turn this off in another
     tab, and a launcher that outlived the preference would open a panel with
     no model to load. */
  if (!isLocalAIEnabled()) return null;
  const prefs = readPreferences();
  if (!prefs.enabled || !prefs.modelId) return null;
  if (!detectCapability().supported) return null;

  return (
    <>
      <button
        className="btn btn-primary ai-launcher"
        onClick={() => setOpen(true)}
        aria-label="Open the assistant"
        aria-haspopup="dialog"
      >
        <Sparkles size={18} aria-hidden="true" />
      </button>

      {open && (
        <Suspense fallback={null}>
          <AssistantPanel onClose={() => setOpen(false)} position={position} />
        </Suspense>
      )}
    </>
  );
}
