import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import Modal, { ModalHead } from './Modal';
import { api } from '../utils/api';

/**
 * "The Privacy Policy has been updated."
 *
 * ── Why this exists ──
 *
 * The Terms of Service say, in the product's own published words: *"If a change
 * matters, we will tell you in the app at least 30 days before it takes effect…
 * We will not change them quietly."* The Privacy Policy says the same. Until
 * this, nothing implemented it for anybody but organizers, who are re-gated on
 * the Organizer Agreement only as a side effect of how their capabilities work.
 *
 * ── What it shows, and what it refuses to claim ──
 *
 * One quoted sentence that is genuinely new, chosen by `server/legalExcerpt.js`,
 * in the document's own voice. Not a diff. A diff gives a reflowed line and a
 * renumbered heading the same weight as the sentence that matters, and the
 * honest reaction to reading one is to stop reading.
 *
 * The quote is labelled a sample whenever there is more than one change, because
 * nothing here can know which change matters most and presenting one as "what
 * changed" would overstate it. The link is what actually discharges the
 * obligation; the excerpt exists to make somebody want to follow it.
 *
 * ── One at a time ──
 *
 * If three documents changed at once, three stacked modals is a wall somebody
 * dismisses without reading — which is the failure this is supposed to prevent.
 * They are shown in sequence, each acknowledged on its own, with a quiet count
 * so nobody thinks they are finished when they are not.
 *
 * ── Dismissal is not consent ──
 *
 * "Got it" records that the notice was seen, in `legal_change_notices`, which is
 * deliberately not the consent table. Nobody's dismissal of a popup should ever
 * become evidence that they agreed to something.
 */
export default function LegalUpdateModal() {
  const [updates, setUpdates] = useState([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.fetchLegalUpdates()
      .then(res => { if (!cancelled) setUpdates(res?.updates ?? []); })
      /* Silent. A student who opened the app to find a shift should not be shown
         an error about a notice system they never asked about. */
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const current = updates[index];
  if (!current) return null;

  const dismiss = async () => {
    setBusy(true);
    try {
      await api.acknowledgeLegalUpdate(current.slug, current.version);
    } catch {
      /* Advance anyway. The server upsert is idempotent and the sweep will
         re-notify if it truly failed; trapping somebody behind a modal they
         cannot dismiss is far worse than showing it twice. */
    } finally {
      setBusy(false);
      setIndex(i => i + 1);
    }
  };

  const remaining = updates.length - index - 1;

  return (
    <Modal onClose={dismiss} label={`${current.title} has been updated`} size="md">
      <ModalHead
        title={`${current.title} has been updated`}
        description="We have made changes to a document you agreed to."
        onClose={dismiss}
      />

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
          {current.previousVersion && ` · you last saw ${current.previousVersion}`}
        </p>
      </div>

      <div className="modal-foot">
        {remaining > 0 && (
          <span className="small dim" style={{ marginRight: 'auto' }}>
            {remaining} more {remaining === 1 ? 'update' : 'updates'}
          </span>
        )}
        <Link className="btn btn-secondary" to={`/legal/${current.slug}`} onClick={dismiss}>
          Read the {current.title}
        </Link>
        <button className="btn btn-primary" onClick={dismiss} disabled={busy}>
          Got it
        </button>
      </div>
    </Modal>
  );
}
