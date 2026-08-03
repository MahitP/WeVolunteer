import React, { useState } from 'react';
import { api } from '../../utils/api';
import { AlertTriangle } from 'lucide-react';
import Modal from '../Modal';
import { useStepUp } from '../auth/useStepUp';
import { STEP_UP } from '../../utils/stepUp';

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
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { run, modal: verifyModal } = useStepUp();

  /**
   * ── What the "DELETE" box is, and what it is not (v1.2b) ──
   *
   * It is a deliberateness check and nothing else. It is not sent to the server
   * and the server does not look for it, which is exactly why it belongs here
   * and only here: a value the server ignores must not be presented as though it
   * were the thing standing between the user and an irreversible action.
   *
   * It replaces two things that WERE sent. A password, which a provider-only
   * account does not have — so such an account was asked for nothing at all, and
   * one request against a live session irreversibly anonymised it. And then, as
   * a stopgap, the account's own username, which the code conceded was not a
   * credential: it is public within the app and appears on every comment the
   * person has posted.
   *
   * The real proof is now `requireAAL2('account.delete')`, answered by the
   * password OR by re-consenting at a linked provider — the credential a
   * provider-only account always had and the old check could not read.
   */
  const handleDelete = async (e) => {
    e.preventDefault();
    if (deleteText !== 'DELETE') {
      setError('Type DELETE to confirm.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await run(
        STEP_UP.ACCOUNT_DELETE,
        {},
        headers => api.deleteAccount(headers)
      );

      // Dismissed the verification. The dialog stays open on the confirmation
      // they already typed, so they can decide again rather than starting over.
      if (!result) {
        setIsSubmitting(false);
        return;
      }

      if (result.success) onSuccess();
      else setIsSubmitting(false);
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

              <span className="dim small">
                {hasPassword
                  ? 'You will be asked to verify your identity before anything is deleted.'
                  : 'You will be asked to re-confirm with your sign-in provider before anything is deleted.'}
              </span>
            </form>

            <div className="row delete-actions">
              <button className="btn btn-ghost btn-lg" type="button" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </button>
              <button 
                form="delete-form"
                className="btn btn-danger-solid btn-lg" 
                disabled={isSubmitting || deleteText !== 'DELETE'}
              >
                {isSubmitting ? 'Deleting…' : 'Delete My Account'}
              </button>
            </div>
          </div>
      </div>
      {verifyModal}
    </Modal>
  );
}
