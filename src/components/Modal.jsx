import React from 'react';
import { X } from 'lucide-react';
import { useModal } from '../utils/useModal';

/**
 * The single dialog shell used by every modal in the app.
 *
 * Centralising it means Escape, focus containment, focus restore, scroll lock,
 * and the ARIA wiring are guaranteed to behave the same everywhere, instead of
 * each modal re-implementing (and forgetting) them.
 */
export default function Modal({
  onClose,
  label,
  size = 'md',
  children,
  className = ''
}) {
  const dialogRef = useModal(onClose);

  return (
    <div className="modal-overlay" onClick={onClose}>
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
