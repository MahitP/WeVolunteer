import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useModal } from '../utils/useModal';

/**
 * The single dialog shell used by every modal in the app.
 *
 * Centralising it means Escape, focus containment, focus restore, scroll lock,
 * and the ARIA wiring are guaranteed to behave the same everywhere, instead of
 * each modal re-implementing (and forgetting) them.
 *
 * ── Why it is portalled to `document.body` ──
 *
 * `.modal-overlay` is `position: fixed; inset: 0`, which everybody reads as
 * "covers the viewport". It does — unless an ancestor has a `transform`,
 * `filter`, `backdrop-filter`, `contain` or `perspective`, any of which makes
 * that ancestor the containing block for fixed descendants instead of the
 * viewport. The overlay then covers the ANCESTOR.
 *
 * That is not hypothetical here. `header.topbar` carries
 * `backdrop-filter: saturate(1.4) blur(8px)`, so a dialog opened from a topbar
 * control was laid out inside a 72-pixel-tall box: measured on the Welly panel,
 * the overlay computed to `height: 72px` with `align-items: flex-end`, putting
 * an 817-pixel dialog at `top: -745px` — off the top of the screen, with only
 * its last row visible and no backdrop anywhere.
 *
 * Rendering into `document.body` puts every dialog outside whatever the opening
 * control happens to sit in, so `fixed` means the viewport again. Nesting still
 * works: a dialog opened from inside another one is appended later and therefore
 * paints above it, which is the order `.modal-overlay-stacked` already assumes.
 *
 * The alternative — dropping the topbar's blur — would trade a visual detail for
 * a rule that has to be remembered forever by everyone who adds a modal or a
 * filter. This makes the whole class of bug impossible instead.
 */
export default function Modal({
  onClose,
  label,
  size = 'md',
  children,
  className = '',
  /**
   * Extra class for the overlay, not the dialog.
   *
   * Exists for a dialog that opens on top of another one and therefore needs its
   * own stacking level — see `.modal-overlay-stacked`. Everything else can ignore
   * it, and the default is unchanged.
   */
  overlayClassName = '',
  /**
   * A dialog whose answer is required, and which therefore has no "close".
   *
   * ── What changes, and why each piece has to ──
   *
   * `role="alertdialog"` instead of `role="dialog"`. The APG's alertdialog
   * pattern is specifically for a modal that "interrupts the user's workflow to
   * communicate an important message and acquire a response", and the role is
   * what lets a screen reader treat it differently from an ordinary dialog —
   * some announce it more assertively or play a system alert sound. That
   * difference is the whole point here: this is not a panel somebody opened.
   *
   * `aria-describedby`, which the same pattern requires, pointing at the
   * element carrying the message. Without it a reader gets the dialog's name
   * and then has to go looking for what it wants.
   *
   * No Escape (see `useModal`), no backdrop click, and `ModalHead` renders no
   * `X`. All three are the same decision: a control that dismisses a dialog
   * which immediately reopens is a control that appears broken, and the two
   * real answers are buttons in the dialog.
   *
   * ── The one thing that does NOT change ──
   *
   * `aria-modal="true"` was already here, and the APG is blunt about the
   * obligation it carries: a dialog marked modal that does not behave as one
   * has "severe negative ramifications", because assistive technology stops
   * exposing everything outside it. That is honest for this dialog and for
   * every other one in the app, because `useModal` contains the tab cycle and
   * the overlay covers the page — this mode makes it MORE true, not less.
   */
  mandatory = false,
  /**
   * `aria-labelledby` / `aria-describedby` targets, when the dialog has a
   * visible title and message to point at.
   *
   * Preferred over `label` where they exist: an `aria-label` is a second copy
   * of a heading that is already on screen, and the copy is the one that goes
   * stale. `label` stays for the dialogs whose name is not rendered anywhere.
   */
  labelledBy = null,
  describedBy = null,
  /**
   * CSS selector for where focus should land, queried inside the dialog.
   *
   * Omit it and focus goes to the first control that is not the close button,
   * which is right for every dialog whose first control is safe to arm. See
   * the note in `useModal`.
   */
  initialFocus = null,
}) {
  const dialogRef = useModal(
    mandatory ? undefined : onClose,
    { dismissible: !mandatory, initialFocus }
  );

  /* Guarded for the server/test renderers that have no document — the component
     is imported by suites that never mount it. */
  const host = typeof document !== 'undefined' ? document.body : null;

  const dialog = (
    <div
      className={`modal-overlay ${overlayClassName}`}
      onClick={mandatory ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        className={`modal ${size === 'lg' ? 'modal-lg' : ''} ${className}`}
        onClick={e => e.stopPropagation()}
        role={mandatory ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        /* `aria-labelledby` wins where it is supplied: naming the heading that
           is already on screen beats a second copy of it in an attribute. When
           neither is given the dialog would have no accessible name at all, so
           `label` remains the fallback and every existing caller passes it. */
        aria-labelledby={labelledBy || undefined}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy || undefined}
      >
        {children}
      </div>
    </div>
  );

  return host ? createPortal(dialog, host) : dialog;
}

/**
 * Standard dialog header: title, optional description, and a close control.
 *
 * `titleId` / `descriptionId` are for a dialog that names itself through
 * `aria-labelledby` rather than `aria-label` — pass the same values to `Modal`.
 * Omitting `onClose` renders no close control, which is what a mandatory dialog
 * wants: an `X` that puts the same dialog straight back is worse than no `X`.
 */
export function ModalHead({ title, description, onClose, children, titleId, descriptionId }) {
  return (
    <div className="modal-head">
      {children || (
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p className="lead" id={descriptionId}>{description}</p>}
        </div>
      )}
      {onClose && (
        <button className="modal-close" onClick={onClose} aria-label="Close dialog">
          <X size={18} />
        </button>
      )}
    </div>
  );
}
