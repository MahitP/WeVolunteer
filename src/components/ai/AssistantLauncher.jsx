import React, { lazy, Suspense, useState } from 'react';
import WellyMark from './WellyMark';
import { isLocalAIEnabled, detectCapability } from '../../ai';
import { readPreferences } from '../../ai/preferences';
import { useLocationContext } from '../../contexts/LocationContext';

/**
 * The way in.
 *
 * ── Shown to anybody whose device can run it ──
 *
 * Two conditions: the build has the feature, and the device can run it. Whether
 * this person has set a model up decides what OPENS, not whether the button is
 * there.
 *
 * It used to require setup as a third condition, on the argument that a launcher
 * everybody can see is an advertisement for a download — the repository's
 * position on not nudging people into consent decisions, recorded beside the
 * analytics switch. That argument was overtaken by what it produced: a feature
 * whose only entry point was a card most students would never scroll to, in a
 * Settings section about something else. "Welly is finished and I still cannot
 * find it" is the report this shape generates.
 *
 * The anti-nudge position is kept where it does the work. This button opens an
 * EXPLANATION, never a transfer: the same disclosure screen as before — what it
 * can do, that the weights come from Hugging Face, how large they are — and the
 * download still starts only when somebody chooses a model and presses the
 * button that names the size. Nothing is fetched by looking, and nothing is
 * fetched by opening. What changed is that the offer is findable; what it costs
 * to accept is stated exactly where it always was.
 *
 * ── Why it lives in the topbar ──
 *
 * It was a circle fixed to the bottom-right corner, which is the shape every
 * sales and support widget on the web has taught people to recognise. It also
 * floated over content, needed a z-index, and had a media query to stop it
 * colliding with the mobile bottom navigation.
 *
 * The topbar already holds the application's global actions — the theme toggle
 * and the notifications bell. Welly is exactly that kind of thing: available
 * everywhere, owned by no single page, and not a destination. Sitting there it
 * inherits the existing button treatment, falls into natural keyboard order,
 * covers nothing, and needs no stacking rules at all.
 *
 * A navigation entry was considered and rejected: navigation is for places, and
 * a permanent entry for an off-by-default feature is a dead item for most
 * students.
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

  if (!isLocalAIEnabled()) return null;
  if (!detectCapability().supported) return null;

  /* Read at render, not held in state: Settings can change this in another tab,
     and a launcher holding a stale answer would open the wrong panel. */
  const prefs = readPreferences();
  const configured = Boolean(prefs.enabled && prefs.modelId);

  return (
    <>
      {/* Same treatment as ThemeToggle and NotificationsBell beside it. The
          accessible name is the assistant's name, not a description of a
          shape — "Welly" is what a student is looking for. */}
      <button
        className="btn btn-ghost btn-icon welly-launcher"
        onClick={() => setOpen(true)}
        aria-label="Ask Welly"
        aria-haspopup="dialog"
        title="Ask Welly"
      >
        <WellyMark />
      </button>

      {open && (
        <Suspense fallback={null}>
          <AssistantPanel
            onClose={() => setOpen(false)}
            position={position}
            needsSetup={!configured}
          />
        </Suspense>
      )}
    </>
  );
}
