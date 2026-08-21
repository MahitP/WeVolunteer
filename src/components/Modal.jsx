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
  overlayClassName = ''
}) {
  const dialogRef = useModal(onClose);

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
          {description && <p className="lead">{description}</p>}
        </div>
      )}
      <button className="modal-close" onClick={onClose} aria-label="Close dialog">
        <X size={18} />
      </button>
    </div>
  );
}
