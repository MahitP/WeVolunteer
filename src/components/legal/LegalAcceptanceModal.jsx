import React, { useState } from 'react';
import { ExternalLink, ScrollText, ShieldCheck } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import { formatLegalDate } from '../../views/legal/legalDates';

/**
 * "Please accept the updated Terms of Service."
 *
 * ── What this is, and what the banner is ──
 *
 * The Terms of Service say, in the product's own published words: *"A change
 * that leaves you worse off — new collection, new sharing, a right taken away,
 * a longer retention period — gets a new major version and we ask you to accept
 * it again. A clarification gets a minor version and notice only."*
 *
 * This is the first half. `LegalUpdateNotice` is the second. Which one a change
 * gets is decided by the server, in `legalConsentGate.js`, and no change ever
 * gets both — the whole reason there are two components is that a clarification
 * used to open this dialog, and a reader who has dismissed two modals about
 * rewordings has learned to dismiss the third one unread.
 *
 * ── This dialog is not the enforcement ──
 *
 * Worth being precise about, because it is what stops this being theatre. The
 * account holding an unaccepted major version has the participation
 * capabilities WITHHELD server-side, per request, by the same mechanism the
 * Organizer Agreement uses — see `SIGNUP_CONSENT_GATED_CAPABILITIES`. Editing
 * this component out of the bundle removes the dialog and changes nothing about
 * what the account may do.
 *
 * So this is the only way OUT of the gated state, which is why it has to be
 * reachable and operable with almost nothing granted. It needs two endpoints:
 * the one that lists pending changes and the one that records the acceptance,
 * neither of which is capability-gated, for the reason `OrganizerAgreement.jsx`
 * gives at length — a consent screen that requires the permissions it grants is
 * a lockout, and a lockout is what teaches people to click through without
 * reading.
 *
 * ── One at a time ──
 *
 * If two documents both need accepting, they are presented in sequence with a
 * count, each accepted on its own. Two stacked dialogs is a wall, and a single
 * "accept both" button would record one act of agreement against two documents
 * a reader was shown together and may feel differently about.
 *
 * ── Why the document opens in a new tab ──
 *
 * `/legal/:slug` is a PUBLIC route, and `App.jsx` answers a public path before
 * it builds the signed-in shell — so navigating there in this tab replaces the
 * whole application, this dialog included. The reader would finish the document
 * on a page with no way back to the question they were in the middle of.
 *
 * A new tab keeps the dialog exactly where it was, which is what a consent gate
 * wants: read, come back, answer. The link says so in its own text rather than
 * relying on an icon, because an unannounced new tab is disorienting for
 * exactly the readers least able to recover from it.
 *
 * It is the canonical route and the same slug the acceptance record is keyed on.
 * No second copy of a document page exists anywhere and this does not add one.
 */
export default function LegalAcceptanceModal({ required, onAccepted, onSignOut }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Always the head of the list, and there is no cursor into it.
   *
   * ── Why an index was wrong ──
   *
   * The first version held `index` in state and advanced it after each
   * acceptance. That is one piece of state too many: `required` comes from the
   * server and is re-fetched the moment an acceptance is recorded, so the
   * accepted document has already left the list by the time the increment runs.
   * Whether the reader then saw the next document or an empty screen depended
   * on which of the two state updates React flushed first — `setRequired([B])`
   * with `index` still 0 shows B, and the same pair in the other order asks for
   * `[B][1]`, which is `undefined`, which renders nothing while the account is
   * still gated. A dialog that vanishes and leaves somebody unable to apply to
   * an event, with nothing on screen explaining why, is the worst outcome this
   * component has.
   *
   * The server's list is the queue. Its head is the next thing to answer, its
   * length is how many are left, and neither can disagree with the other.
   */
  const current = required?.[0];
  if (!current) return null;

  const remaining = required.length - 1;
  const effective = formatLegalDate(current.effectiveAt);

  /**
   * "Accept and continue" for the last one, "Accept and go on" for the rest.
   *
   * A button that says "continue" three times in a row, each time putting
   * another dialog in front of somebody, reads as a loop rather than as
   * progress. The version line says how many are left; the button says whether
   * pressing it finishes the job.
   */
  const nextLabel = remaining > 0 ? 'Accept and go on' : 'Accept and continue';

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      /* No local advance. `onAccepted` re-reads the pending list, and this
         dialog renders whatever is at the head of it — including nothing, when
         that was the last one. */
      await onAccepted(current);
    } catch (err) {
      /**
       * Shown, not swallowed.
       *
       * The ordinary notice can afford to fail silently — dismissing it is a
       * convenience. This one cannot: somebody who pressed Accept and got
       * nothing has no way to tell whether their agreement was recorded, and
       * the capabilities will still be withheld on the next request. So the
       * failure is named and the button stays available.
       */
      setError(
        err?.data?.error
        || 'Your acceptance could not be recorded just now. Please try again in a moment.'
      );
    } finally {
      setBusy(false);
    }
  };

  const titleId = 'legal-acceptance-title';
  const bodyId = 'legal-acceptance-description';

  return (
    <Modal
      mandatory
      labelledBy={titleId}
      describedBy={bodyId}
      className="modal-mandatory"
      overlayClassName="modal-overlay-mandatory"
      size="md"
      /* The heading, not the first button. The footer reads Sign out · Read the
         document · Accept and continue, so the default — first control — armed
         "Sign out" on a dialog that had just asked somebody to read something.
         See the note in `useModal`. */
      initialFocus={`#${titleId}`}
    >
      {/* Children rather than the `title` prop, because this head carries an
          icon beside the heading. No `onClose` is passed, so `ModalHead`
          renders no `X` — a mandatory dialog has nothing to close to. */}
      <ModalHead>
        <div className="modal-mandatory-head">
          <span className="modal-mandatory-icon" aria-hidden="true">
            <ShieldCheck size={20} />
          </span>
          <div>
            <h2 id={titleId} tabIndex={-1}>Please accept the updated {current.title}</h2>
            <p className="lead" id={bodyId}>
              We have made a significant change to this document, so we need your
              agreement before you carry on using WeVolunteer.
            </p>
          </div>
        </div>
      </ModalHead>

      <div className="modal-body stack-md">
        {current.excerpt ? (
          <>
            {/* A quotation, styled as one. The document's own sentence, not our
                summary of it — a summary would be us characterising our own
                legal change, which is exactly what nobody should trust. */}
            <blockquote className="legal-excerpt">
              <ScrollText size={15} aria-hidden="true" className="legal-excerpt-icon" />
              <p>{current.excerpt}</p>
            </blockquote>
            {current.isSample && (
              <p className="small dim">
                That is one of {current.changeCount} changes. Please read the full document.
              </p>
            )}
          </>
        ) : (
          /* No quotable addition — a deletion or a reformatting. Saying so is
             better than inventing a quote or showing an empty box. */
          <p className="small dim">
            The wording has been revised. Please read the full document for the details.
          </p>
        )}

        <p className="small dim">
          Version {current.version}
          {effective && ` · in effect from ${effective}`}
          {current.previousVersion && ` · you last accepted ${current.previousVersion}`}
          {/**
            * How many are left lives here rather than in the footer.
            *
            * It was `{remaining} more documents after this` beside the three
            * buttons, and measured in a browser at the dialog's 560px it wrapped
            * onto three lines and squeezed the actions into the right half — a
            * footer that looked broken on the one dialog that must not. Beside
            * the version it is the same information in the place a reader is
            * already looking for facts about which document this is.
            *
            * A count of what REMAINS, not "document 2 of 3": the list shrinks as
            * documents are accepted, so it has no memory of an original total
            * and inventing one would need a second piece of state to disagree
            * with the first. See the note on `current`.
            */}
          {remaining > 0 && ` · ${remaining} more after this`}
        </p>

        <p className="small">
          Accepting records that you agree to this version. If you would rather not,
          you can sign out — your account and your recorded hours are untouched, and
          we will ask again next time you sign in.
        </p>

        {error && (
          /* `role="alert"`, because this one IS a status message in WCAG 4.1.3's
             sense: it reports the result of an action the reader just took, and
             it is the difference between "recorded" and "not recorded". */
          <p className="alert alert-danger" role="alert">{error}</p>
        )}
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
        <a
          className="btn btn-secondary"
          href={`/legal/${current.slug}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Read the document
          <ExternalLink size={14} aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <button type="button" className="btn btn-primary" onClick={accept} disabled={busy}>
          {busy ? 'Recording…' : nextLabel}
        </button>
      </div>
    </Modal>
  );
}
