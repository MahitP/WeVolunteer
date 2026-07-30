import React, { useState } from 'react';
import { api } from '../../utils/api';
import { AlertTriangle } from 'lucide-react';
import Modal from '../Modal';

/**
 * Confirm and perform account deletion.
 *
 * Uses the shared `Modal` shell, which it previously did not — it hand-rolled
 * its own `.modal-overlay` markup and so was the ONE dialog in the app with no
 * dialog semantics at all: no `role="dialog"`, no `aria-modal`, no focus moved
 * in on open or restored on close, no focus containment, no Escape, no scroll
 * lock, and a close control labelled only with the character "×".
 *
 * That it was this dialog is what makes it worth calling out. A keyboard or
 * screen-reader user could be dropped into an irreversible, unannounced form
 * with no way out but the mouse. Every other modal in the app already went
 * through `Modal`/`useModal`; this one just never got moved over.
 */
export default function DeleteAccountModal({ onClose, onSuccess, hasPassword, username }) {
  const [deleteText, setDeleteText] = useState('');
  const [password, setPassword] = useState('');
  const [confirmUsername, setConfirmUsername] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * A provider-only account has no password to re-prove with, and the server
   * previously asked such an account for nothing at all — one request against
   * a live session irreversibly anonymised it. Typing the account's own
   * username is not a credential, but it is a deliberate act the server can
   * actually check, unlike the "DELETE" box, which is client-side only.
   */
  const needsUsername = !hasPassword;

  const handleDelete = async (e) => {
    e.preventDefault();
    if (deleteText !== 'DELETE') {
      setError('Type DELETE to confirm.');
      return;
    }
    if (hasPassword && !password) {
      setError('Enter your password to confirm.');
      return;
    }
    if (needsUsername && confirmUsername.trim().toLowerCase() !== String(username || '').toLowerCase()) {
      setError(`Type your username (${username}) exactly to confirm.`);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await api.deleteAccount({
        password: hasPassword ? password : undefined,
        confirmUsername: needsUsername ? confirmUsername.trim() : undefined
      });
      if (result.success) onSuccess();
    } catch (err) {
      setError(err.message || 'Failed to delete account');
      setIsSubmitting(false);
    }
  };

  return (
    <Modal onClose={isSubmitting ? () => {} : onClose} label="Delete your account" className="modal-delete-account">
      <div className="modal-head modal-head-bare">
        <button
          className="modal-close"
          onClick={onClose}
          disabled={isSubmitting}
          aria-label="Close without deleting"
        >
          ×
        </button>
      </div>

      <div className="modal-body modal-body-flush">
          <div className="stack-lg">
            <div className="delete-hero">
              <div className="delete-hero-icon">
                <AlertTriangle size={40} aria-hidden="true" />
              </div>
              {/* h2, and the dialog's accessible name comes from Modal's
                  aria-label — so the heading is announced as content rather
                  than being the only thing identifying the dialog. */}
              <h2 className="delete-hero-title">Delete Account?</h2>
              <p className="lead delete-hero-lead">
                Deleting your account removes your profile, settings, and login access.
                Your verified volunteer records and certificates may be preserved for verification purposes.
              </p>
            </div>

            <div className="card delete-summary">
              <div className="card-pad stack-md">
                <p className="strong stack-heading">Before deleting:</p>

                <div className="row delete-summary-cols">
                  <div className="stack-sm delete-summary-col">
                    <p className="strong small delete-summary-removed">Removed</p>
                    <ul className="small dim delete-summary-list">
                      <li>Profile information</li>
                      <li>Preferences</li>
                      <li>Login access</li>
                      <li>Your place on any upcoming shift</li>
                    </ul>
                  </div>

                  <div className="stack-sm delete-summary-col">
                    <p className="strong small delete-summary-kept">Preserved</p>
                    <ul className="small dim delete-summary-list">
                      <li>Certificates</li>
                      <li>Verified volunteer hours</li>
                      <li>Historical records</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* role="alert" so the failure is announced. Previously a plain
                styled div: a screen-reader user pressed the button, nothing was
                read out, and the form appeared simply not to respond. */}
            {error && (
              <div className="alert alert-danger" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <form id="delete-form" onSubmit={handleDelete} className="stack-md delete-form">
              <div className="stack-sm">
                {/* The label was not associated with its input at all — no
                    htmlFor, no id — so clicking it did nothing and a screen
                    reader announced an unlabelled text box. */}
                <label className="strong small" htmlFor="delete-confirm-text">To continue, type: DELETE</label>
                <input
                  id="delete-confirm-text"
                  type="text"
                  className="input"
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck="false"
                  value={deleteText}
                  onChange={(e) => setDeleteText(e.target.value)}
                  placeholder="DELETE"
                  disabled={isSubmitting}
                />
              </div>

              {hasPassword && (
                <div className="stack-sm">
                  <label className="strong small" htmlFor="delete-password">Enter your password</label>
                  <input
                    id="delete-password"
                    type="password"
                    className="input"
                    autoComplete="current-password"
                    placeholder="Current password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              )}

              {needsUsername && (
                <div className="stack-sm">
                  <label className="strong small" htmlFor="delete-username">
                    Type your username <code>{username}</code> to confirm
                  </label>
                  <input
                    id="delete-username"
                    type="text"
                    className="input"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck="false"
                    placeholder={username}
                    value={confirmUsername}
                    onChange={(e) => setConfirmUsername(e.target.value)}
                    disabled={isSubmitting}
                  />
                  <span className="dim small">
                    Your account signs in with a connected provider, so there is no password to check.
                  </span>
                </div>
              )}
            </form>

            <div className="row delete-actions">
              <button className="btn btn-ghost btn-lg" type="button" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </button>
              <button 
                form="delete-form"
                className="btn btn-danger-solid btn-lg" 
                disabled={
                  isSubmitting
                  || deleteText !== 'DELETE'
                  || (hasPassword && !password)
                  || (needsUsername && confirmUsername.trim().toLowerCase() !== String(username || '').toLowerCase())
                }
              >
                {isSubmitting ? 'Deleting…' : 'Delete My Account'}
              </button>
            </div>
          </div>
      </div>
    </Modal>
  );
}
