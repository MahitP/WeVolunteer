import React from 'react';
import { useNavigate } from 'react-router-dom';
import WellyMark from './WellyMark';
import { isLocalAIEnabled, detectCapability } from '../../ai';

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
export default function AssistantLauncher() {
  const navigate = useNavigate();

  if (!isLocalAIEnabled()) return null;
  if (!detectCapability().supported) return null;

  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon welly-launcher"
      onClick={() => navigate('/welly')}
      aria-label="Ask Welly"
      title="Ask Welly"
    >
      <WellyMark />
    </button>
  );
}
