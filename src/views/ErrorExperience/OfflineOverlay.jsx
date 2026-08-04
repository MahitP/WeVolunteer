import React from 'react';
import ErrorExperience from './ErrorExperience';

/**
 * Covers the app while the connection is gone — and only covers it.
 *
 * ── Why this is not a ternary ──
 *
 * The obvious wiring is `!online ? <ErrorExperience/> : children`, and it is
 * wrong in a way that no screenshot shows: React unmounts the children, so
 * every piece of unsaved state inside them is destroyed. Measured in a browser
 * before this component existed — a name typed into `/signup`, a synthetic
 * `offline` then `online`, and the field came back empty.
 *
 * That matters more here than almost anywhere else in the app, because the
 * offline copy promises "anything you haven't sent is still on this device".
 * The app was the thing making that untrue, and a dropped bar on a school bus
 * lasts seconds.
 *
 * So the children stay mounted, always, and the experience is laid over them.
 * When the connection returns the overlay unmounts and the person is exactly
 * where they were, mid-sentence.
 *
 * ── The wrapper is unconditional on purpose ──
 *
 * `.err-offline-under` is rendered in both states. Adding it only when offline
 * would change the element type at that position and unmount the children —
 * the same defect, reintroduced by a different route. It is `display: contents`
 * so it costs no layout.
 *
 * ── inert, not just aria-hidden ──
 *
 * `aria-hidden` takes the covered app out of the accessibility tree but leaves
 * every control in it tabbable, so a keyboard would still reach a form that
 * cannot possibly submit — behind an opaque overlay, with no visible focus.
 * `inert` is the half that actually removes it.
 *
 * ── Why `useOnline` is read by the caller and not here ──
 *
 * `navigator.onLine` reports that an interface exists, not that anything is
 * reachable. This component makes no judgement about that; it renders what it
 * is told, which keeps the policy in one place in App.jsx.
 */
export default function OfflineOverlay({ online, signedIn = true, children }) {
  return (
    <>
      <div
        className="err-offline-under"
        inert={!online}
        aria-hidden={online ? undefined : 'true'}
      >
        {children}
      </div>

      {!online && (
        <div className="err-offline-over">
          <ErrorExperience kind="offline" signedIn={signedIn} />
        </div>
      )}
    </>
  );
}
