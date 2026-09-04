import React from 'react';
import { X } from 'lucide-react';
import './NoticeBanner.css';

/**
 * The one banner the signed-in shell uses to tell somebody something.
 *
 * ── Why this is a primitive rather than two components that look alike ──
 *
 * The location opt-in banner shipped first and set the visual language: a quiet
 * `--surface-2` strip above the page content, a brand-coloured icon, a title and
 * one line of explanation, a primary action, and an `X`. The legal change notice
 * needs exactly that treatment — same placement, same weight, same close
 * control.
 *
 * Copying the markup would have worked on the day it was written and then
 * drifted, and the drift is visible: two notices in the same slot with slightly
 * different padding or a differently sized `X` read as two features built by two
 * people, which is the thing this component exists to prevent.
 *
 * So the markup and the classes live here once. Nothing about the location
 * banner's appearance changed when it moved onto this — the CSS is the same
 * declarations under neutral names.
 *
 * ── `role="region"`, not `role="status"`, and it is a decision ──
 *
 * WCAG 4.1.3 is about STATUS MESSAGES: information about the result of an
 * action, the progress of a process, or an error. Neither of these notices is
 * that. They are standing pieces of page content that happen to be conditional —
 * an offer, and a notice the Terms oblige the product to publish — and they are
 * present in reading order at the top of `<main>` before anybody has done
 * anything.
 *
 * A polite live region would announce them over the page-title announcement on
 * every navigation, for content that is not going anywhere. A labelled region is
 * a landmark instead: enumerable by every screen reader's landmark list,
 * reachable at will, announced once when the reader arrives at it.
 *
 * The label is therefore required rather than optional. An unlabelled `region`
 * is dropped from the landmark list by most engines, which would make the
 * banner invisible to the navigation method this choice depends on.
 */
export default function NoticeBanner({
  /** A `lucide-react` element, sized 16. Decorative — the copy carries the meaning. */
  icon,
  /** The accessible name of the landmark. Required; see the note above. */
  label,
  /** One short line, in `--ink`. What happened. */
  title,
  /** One or two lines, dimmed. What it means and what to do about it. */
  children,
  /** The primary action. A `<button>` or a router `<Link>` carrying `btn btn-primary btn-sm`. */
  action,
  /** Omit to render no close control — a notice with nothing to dismiss to. */
  onDismiss,
  /**
   * What the `X` means, spelled out.
   *
   * An `X` with no accessible name is a button called "button". These two
   * dismissals mean different things — one hides an offer for the session, the
   * other records that a legal notice was read — and the difference belongs in
   * the name, not in a tooltip.
   */
  dismissLabel,
}) {
  /**
   * Dismissing removes the control that was just used, so focus has to be put
   * somewhere first.
   *
   * A button that unmounts itself drops focus to `<body>`, which for a keyboard
   * or screen-reader user means losing their place entirely — the next Tab
   * starts again from the skip link. `Modal` has always handled this by
   * restoring focus to whatever opened the dialog; a banner has no opener, so
   * the equivalent is the page content itself.
   *
   * `#main-content` is `main.page`, which already carries `tabIndex={-1}`
   * because it is the skip link's target, and `.page:focus { outline: none }`
   * is already in the stylesheet — so this reuses the focus target the shell
   * was built with rather than inventing one.
   *
   * Moved BEFORE the handler runs, not after: React has not re-rendered while
   * this function is executing, so the button is still in the document and
   * still focusable. Doing it afterwards would need a frame, and a frame is a
   * thing to get wrong.
   *
   * Only when the control actually HAS focus. A mouse user who clicked without
   * focusing it (Safari does not focus buttons on click) should not have the
   * page scrolled or their caret moved by a dismissal.
   */
  const dismiss = (event) => {
    if (document.activeElement === event.currentTarget) {
      document.getElementById('main-content')?.focus?.();
    }
    onDismiss();
  };

  return (
    <div className="app-notice" role="region" aria-label={label}>
      {icon && (
        <span className="app-notice-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="app-notice-body">
        <span className="strong">{title}</span>
        <span className="small dim">{children}</span>
      </div>
      <div className="app-notice-actions">
        {action}
        {onDismiss && (
          <button
            type="button"
            /* `btn-icon` is what carries the 44px WIDTH floor on a phone.
               Without it this was 37×44 at 320px — a 44-tall sliver, which is
               the exact failure the rule's own comment in index.css describes.
               Measured in a browser at 320px; the static touch-target guard
               cannot see it, because the class that fixes it was simply
               absent. */
            className="btn btn-ghost btn-sm btn-icon"
            onClick={dismiss}
            aria-label={dismissLabel}
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
