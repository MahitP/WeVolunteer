import React from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from '../Modal';

/**
 * An in-app confirmation dialog, for actions that need a deliberate yes.
 *
 * Replaces `window.confirm` on the two security actions that used it — "sign out
 * on all other devices" and disconnecting a sign-in provider. The native dialog
 * is the wrong tool for those specifically:
 *
 *   • It is unstyled and untypeset, so on a security screen it reads as a
 *     browser-level warning rather than as part of the product — and on iOS and
 *     Android it prefixes the message with the bare origin, which is exactly the
 *     shape of a phishing prompt users are told to distrust.
 *   • It ignores the app's theme entirely, so in dark mode it flashes a white
 *     box.
 *   • Its message is plain text, so "You will no longer be able to sign in with
 *     it" could not be emphasised, and the `\n\n` in the old strings rendered as
 *     literal spacing decisions the browser made for us.
 *   • It blocks the JavaScript thread, and browsers increasingly suppress it
 *     entirely in cross-origin frames and after certain interactions — a
 *     suppressed `confirm()` returns false, which silently means "the user said
 *     no" for an action they in fact asked for.
 *
 * Going through `Modal` also means it inherits Escape, focus containment, focus
 * restore and the scroll lock, none of which the surrounding page had to think
 * about.
 */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
  /**
   * Extra class for the OVERLAY, passed straight through to `Modal`.
   *
   * Exists because a confirmation can open on top of another dialog — a manager
   * pressing Regenerate inside the share dialog is the case — and the second
   * overlay then needs its own stacking level or it paints behind the first.
   * `.modal-overlay-stacked` already existed for exactly this and had no way to
   * be reached from here. Every other caller ignores it and is unchanged.
   */
  overlayClassName = ''
}) {
  return (
    <Modal
      onClose={busy ? () => {} : onCancel}
      label={title}
      className="modal-confirm"
      overlayClassName={overlayClassName}
    >
      <div className="confirm-body stack-md">
        <div className="confirm-head">
          {destructive && (
            <span className="confirm-icon" aria-hidden="true">
              <AlertTriangle size={22} />
            </span>
          )}
          <h2 className="confirm-title">{title}</h2>
        </div>

        <div className="confirm-text stack-sm">{children}</div>

        <div className="row confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'btn btn-danger-solid' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
