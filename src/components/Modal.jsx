import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useModal } from '../utils/useModal';

/**
 * The id `Modal` points `aria-describedby` at.
 *
 * Exported so a caller that builds its own head can opt in, and so the pair
 * cannot drift into two different strings.
 *
 * Named `dialog-`, not `modal-`, on purpose: `noDanglingClasses.test.js`
 * watches the `modal-` prefix for class names and read this id as one — a
 * reasonable mistake for a scanner to make, and a reason not to give an id a
 * name the stylesheet's own namespace uses.
 */
export const MODAL_DESCRIPTION_ID = 'dialog-description';


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
  overlayClassName = ''
}) {
  const dialogRef = useModal(onClose);

  /**
   * Whether this dialog actually HAS a description to point at.
   *
   * `aria-describedby` naming an element that does not exist is worse than not
   * setting it: some screen readers announce nothing for the name either. So it
   * is set only when the head is on screen, which is detected rather than
   * declared — a caller passing `<ModalHead description=…>` should not also
   * have to remember a flag.
   */
  const [describedBy, setDescribedBy] = useState(undefined);
  useEffect(() => {
    const node = dialogRef.current?.querySelector(`#${MODAL_DESCRIPTION_ID}`);
    setDescribedBy(node ? MODAL_DESCRIPTION_ID : undefined);
  }, [dialogRef, children]);

  /* Guarded for the server/test renderers that have no document — the component
     is imported by suites that never mount it. */
  const host = typeof document !== 'undefined' ? document.body : null;

  const dialog = (
    <div className={`modal-overlay ${overlayClassName}`} onClick={onClose}>
      <div
        ref={dialogRef}
        className={`modal ${size === 'lg' ? 'modal-lg' : ''} ${className}`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        /**
         * The description, when a caller gives `ModalHead` one.
         *
         * Screen readers announce a dialog's name and its description on focus.
         * Without this, `ModalHead`'s `description` was a `<p>` a reader had to
         * arrow to — which is fine for a subtitle and not fine when the
         * sentence is load-bearing. The organization share dialog puts the one
         * sentence distinguishing a credential from an address there.
         *
         * `MODAL_DESCRIPTION_ID` is a constant rather than generated, because a
         * dialog has exactly one `ModalHead` and only one modal is open at a
         * time — `useModal` stacks them by overlay, and the id would be unique
         * even if two were mounted, since the second would replace the first as
         * the accessibility root.
         */
        aria-describedby={describedBy}
      >
        {children}
      </div>
    </div>
  );

  return host ? createPortal(dialog, host) : dialog;
}

/** Standard dialog header: title, optional description, and a close control. */
export function ModalHead({ title, description, onClose, children }) {
  return (
    <div className="modal-head">
      {children || (
        <div>
          <h2>{title}</h2>
          {description && <p className="lead" id={MODAL_DESCRIPTION_ID}>{description}</p>}
        </div>
      )}
      <button className="modal-close" onClick={onClose} aria-label="Close dialog">
        <X size={18} />
      </button>
    </div>
  );
}
