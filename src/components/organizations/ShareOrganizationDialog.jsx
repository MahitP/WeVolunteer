import { useEffect, useRef, useState } from 'react';
import { Link2, Copy, Share2, RefreshCw, Ban, Loader2 } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import ConfirmDialog from '../common/ConfirmDialog';
import { api } from '../../utils/api';
import { publicUrl } from '../../config';
import { formatDay } from '../../utils/helpers';

/**
 * Sharing a club's invitation link.
 *
 * ── Built to look like the certificate ──
 *
 * The certificate dialog puts the thing being shared in the middle, in the mono
 * face, with the action that does something useful with it underneath. This does
 * the same, because they are the same kind of moment: a value the platform issued,
 * shown to somebody who is about to hand it to another person. The URL is the
 * artifact here, so it gets the plate treatment the certificate code gets.
 *
 * ── Every browser API has a fallback, and none of them is silent ──
 *
 * `navigator.share` exists on phones and on almost no desktop, so the Share
 * control is rendered only where it exists rather than being drawn and doing
 * nothing. `navigator.clipboard` is absent over plain HTTP and in some embedded
 * webviews, so a failed copy shows the URL in a toast — the reader can still
 * select it out of the field, which is why the field is a real, focusable,
 * selectable input and not a styled `<div>`.
 *
 * ── Why a manager sees more than a member ──
 *
 * `canCreate` comes from the server. Passing the link on is governed by the
 * club's `invite_policy`; deciding what the link IS — and, on a regeneration,
 * deciding that every copy in circulation stops working — is a manager's call.
 * Both destructive controls sit behind a confirmation that says the one thing a
 * manager is most likely to be afraid of: current members stay members.
 */
/**
 * What the link actually does, which depends on how the club admits people.
 *
 * "Only people you send it to can use it to join" is true of an
 * `invite` club and false of the other two — and telling a manager of a
 * request-to-join club that the link controls admission would be exactly the
 * misunderstanding this dialog exists to prevent. One sentence per policy,
 * because there is no wording that is honest about all three.
 */
const WHAT_THE_LINK_DOES = {
  open: 'Anybody with this link can open this organization’s page and join it. '
    + 'It is the address to hand out — not a password.',
  invite: 'Anybody with this link can open this organization’s page, and only people who '
    + 'have it can join. Send it to the people you want in.',
  request: 'Anybody with this link can open this organization’s page and send a request. '
    + 'A manager still accepts or declines every one.',
};

export default function ShareOrganizationDialog({ orgKey, organization, policy, onClose, addToast, onChanged }) {
  const [state, setState] = useState({ loading: true, link: null, error: '' });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const fieldRef = useRef(null);

  const load = () => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: '' }));
    api.fetchOrganizationShareLink(orgKey)
      .then(link => { if (!cancelled) setState({ loading: false, link, error: '' }); })
      .catch(err => { if (!cancelled) setState({ loading: false, link: null, error: err.message }); });
    return () => { cancelled = true; };
  };

  useEffect(load, [orgKey]);

  const link = state.link;
  const url = link?.path ? publicUrl(link.path) : '';

  /**
   * Selects the URL once it is on screen.
   *
   * The dialog's job is to get this value out of the product, and a reader whose
   * clipboard is unavailable does that by hand. `useModal` has already moved
   * focus into the dialog; this puts it on the one thing worth copying.
   */
  useEffect(() => {
    if (url && fieldRef.current) fieldRef.current.select();
  }, [url]);

  const copy = async () => {
    if (!url) return;
    try {
      /* Optional-call: `navigator.clipboard` is undefined over plain HTTP and in
         some embedded webviews, and reading `.writeText` off undefined would
         throw before the catch below could turn it into a fallback. */
      await navigator.clipboard?.writeText(url);
      if (!navigator.clipboard) throw new Error('no clipboard');
      addToast?.('Invitation link copied.', 'success');
    } catch {
      /* Not an error toast: nothing has gone wrong for the reader, and the value
         they wanted is right here. `info` shows it long enough to select. */
      addToast?.(url, 'info');
    }
  };

  const share = async () => {
    try {
      await navigator.share({
        title: organization?.name,
        text: `Join ${organization?.name ?? 'this organization'} on WeVolunteer.`,
        url,
      });
    } catch {
      /* A cancelled share sheet rejects, and that is not a failure worth saying
         anything about. */
    }
  };

  const act = async (what) => {
    setBusy(true);
    try {
      if (what === 'revoke') {
        await api.revokeOrganizationShareLink(orgKey);
        addToast?.('The invitation link is switched off.', 'info');
      } else {
        const created = await api.createOrganizationShareLink(orgKey);
        addToast?.(
          created.rotated
            ? 'A new invitation link is ready. The old one no longer works.'
            : 'Invitation link created.',
          'success',
        );
      }
      setConfirming(null);
      load();
      onChanged?.();
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal onClose={onClose} label={`Share ${organization?.name ?? 'this organization'}`}>
        <ModalHead
          title="Share this organization"
          description={WHAT_THE_LINK_DOES[policy] ?? WHAT_THE_LINK_DOES.invite}
          onClose={onClose}
        />

        <div className="modal-body stack-md">
          {state.loading && <p className="muted">Loading the invitation link…</p>}

          {!state.loading && state.error && (
            <p className="alert alert-danger" role="alert">{state.error}</p>
          )}

          {!state.loading && !state.error && !link?.exists && (
            <div className="org-share-empty">
              <Link2 size={22} aria-hidden="true" />
              <div className="stack-xs">
                <p className="org-share-empty-title">No invitation link yet</p>
                <p className="muted small">
                  {link?.canCreate
                    ? 'Create one and you can put it on a flyer, in a group chat, or in an email.'
                    : 'Ask a manager of this organization to create one.'}
                </p>
              </div>
            </div>
          )}

          {!state.loading && link?.exists && (
            <>
              <div className="org-share-plate">
                <label className="label" htmlFor="org-share-url">Invitation link</label>
                {/* A real input, focusable and selectable, so somebody whose
                    clipboard is unavailable can still get the value out. */}
                <input
                  id="org-share-url"
                  ref={fieldRef}
                  className="org-share-url"
                  type="text"
                  readOnly
                  value={url}
                  onFocus={e => e.target.select()}
                />
                <p className="muted small org-share-age">
                  Created {formatDay(link.createdAt)}
                  {link.rotations > 0 && (
                    <> · regenerated {link.rotations} {link.rotations === 1 ? 'time' : 'times'}</>
                  )}
                </p>
              </div>

              <div className="row row-wrap org-share-actions">
                <button type="button" className="btn btn-primary" onClick={copy}>
                  <Copy size={15} aria-hidden="true" /> Copy link
                </button>
                {/* Rendered only where it exists. A Share button that silently
                    does nothing is worse than no Share button. */}
                {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                  <button type="button" className="btn btn-secondary" onClick={share}>
                    <Share2 size={15} aria-hidden="true" /> Share…
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {link?.canCreate && (
          <div className="modal-foot org-share-foot">
            {link.exists ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => setConfirming('revoke')}
                >
                  <Ban size={15} aria-hidden="true" /> Turn off link
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => setConfirming('rotate')}
                >
                  {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                  Regenerate
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('rotate')}>
                <Link2 size={15} aria-hidden="true" /> Create invitation link
              </button>
            )}
          </div>
        )}
      </Modal>

      {/**
        * The two confirmations, and the sentence they both carry.
        *
        * A manager pressing Regenerate is usually worried that they are about to
        * empty their own club. They are not: the link was the door, not the
        * membership, and `organization_members` is untouched by both operations.
        * Saying so is the whole reason these dialogs have prose rather than just
        * a verb.
        *
        * `overlayClassName` puts them above this dialog rather than behind it —
        * see `.modal-overlay-stacked`.
        */}
      {confirming === 'rotate' && (
        <ConfirmDialog
          title="Regenerate the invitation link?"
          /* Not "Regenerate" — that is the label on the control that OPENED
             this, and two identically-named buttons in one flow is how somebody
             reads the confirmation as the thing they already pressed. */
          confirmLabel="Regenerate link"
          busy={busy}
          overlayClassName="modal-overlay-stacked"
          onConfirm={() => act('rotate')}
          onCancel={() => setConfirming(null)}
        >
          <p>
            Every copy of the current link stops working, so anybody you already sent it to
            will need the new one.
          </p>
          <p>
            <strong>Nobody loses their membership.</strong> Everyone in this organization
            stays in it.
          </p>
        </ConfirmDialog>
      )}

      {confirming === 'revoke' && (
        <ConfirmDialog
          title="Turn off the invitation link?"
          confirmLabel="Turn it off"
          destructive
          busy={busy}
          overlayClassName="modal-overlay-stacked"
          onConfirm={() => act('revoke')}
          onCancel={() => setConfirming(null)}
        >
          <p>
            The link stops working, and this organization has no invitation link until a
            manager makes a new one. If joining is set to <strong>Invitation only</strong>,
            nobody new can join until then.
          </p>
          <p>
            <strong>Nobody loses their membership.</strong> Everyone in this organization
            stays in it.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
