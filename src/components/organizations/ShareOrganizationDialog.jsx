import { useEffect, useRef, useState } from 'react';
import {
  Link2, Copy, Share2, RefreshCw, Ban, Loader2, Plus, Pencil, CalendarClock, Check,
} from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import ConfirmDialog from '../common/ConfirmDialog';
import { api } from '../../utils/api';
import { publicUrl, APP_NAME } from '../../config';
import { formatDay } from '../../utils/helpers';
import { organizationPath } from '../../utils/organizationUrl';

/**
 * Sharing a club: its public address, and its invitation links.
 *
 * ── The two things this dialog has to keep apart ──
 *
 * **The public address** — `/organizations/@robotics` — is readable, printable,
 * permanent, and grants nothing. It is what a club puts on a poster so people
 * can look it up.
 *
 * **An invitation link** is a credential. It works whether or not the club has
 * a public page, and it is what makes a Join press succeed at an
 * invitation-only club. It can be revoked; the address cannot.
 *
 * Presenting them together, labelled, is the only way a manager can be expected
 * to understand the difference — and the difference is the whole security model.
 * The address section is shown only when the club actually has a public page,
 * because offering an address that answers 404 to everybody outside the club
 * would be worse than not offering one.
 *
 * ── Built to look like the certificate ──
 *
 * The certificate dialog puts the thing being shared in the middle, in the mono
 * face, with the useful action underneath. This does the same, because they are
 * the same kind of moment: a value the platform issued, shown to somebody about
 * to hand it to another person.
 *
 * ── Every browser API has a fallback, and none of them is silent ──
 *
 * `navigator.share` exists on phones and on almost no desktop, so the Share
 * control is rendered only where it exists rather than drawn and doing nothing.
 * `navigator.clipboard` is absent over plain HTTP and in some embedded webviews,
 * so a failed copy shows the URL in a toast — the reader can still select it out
 * of the field, which is why the field is a real, focusable, selectable input
 * and not a styled `div`.
 *
 * ── Why a manager sees more than a member ──
 *
 * `canManage` comes from the server. Passing a link on is governed by the club's
 * `invite_policy`; deciding what the links ARE — and, on a regeneration,
 * deciding that every copy in circulation stops working — is a manager's call.
 * Both destructive controls sit behind a confirmation that says the one thing a
 * manager is most likely to fear: current members stay members.
 */
/**
 * What an invitation link does, per policy — and the half that is true of all
 * three.
 *
 * ── The sentence that used to be here, and why it was dangerous ──
 *
 * For an `open` club this read "They are addresses to hand out — not
 * passwords." That is a reasonable description of what the link does TODAY and
 * a false description of what it is, and the gap is exploitable by nobody more
 * exotic than a manager following the product's own advice:
 *
 *   1. The club is open, so the dialog says the link is not a password.
 *   2. A manager posts it publicly — on a feed, in a bio — because they were
 *      told it is just an address.
 *   3. The club later switches to Invitation only.
 *
 * Nothing rotates a link when `join_policy` tightens, deliberately: a link
 * already printed on a flyer must keep working, and silently invalidating it
 * would be the worse failure. So step 3 turns the link from step 2 into a live
 * credential sitting on a public feed, and no screen ever mentioned it.
 *
 * Every policy's sentence therefore now says the thing that does not change —
 * these keep working, and there is a different value for the poster.
 */
/**
 * The same three facts in the singular, for a member who may share.
 *
 * They get the club's primary link and nothing else — `canManage: false` hides
 * the rest — so the plural sentence described a list they cannot see.
 */
const WHAT_ONE_LINK_DOES = {
  open: 'Anybody with this link can open this organization’s page and join it. '
    + 'It keeps working if a manager changes who can join, so treat it as private — for '
    + 'something public, ask a manager for the organization’s public address.',
  invite: 'Anybody with this link can open this organization’s page, and only people who have '
    + 'it can join. Send it to the people you want in, and treat it as private.',
  request: 'Anybody with this link can open this organization’s page and send a request. '
    + 'A manager still accepts or declines every one — and the link keeps working if a manager '
    + 'changes who can join, so treat it as private.',
};

const WHAT_THE_LINK_DOES = {
  open: 'Anybody with one of these links can open this organization’s page and join it. '
    + 'They keep working if you change who can join, so treat them as private even while '
    + 'anybody may join — for a poster, use the public address instead.',
  invite: 'Anybody with one of these links can open this organization’s page, and only people '
    + 'who have one can join. Send them to the people you want in, and treat them as private.',
  request: 'Anybody with one of these links can open this organization’s page and send a request. '
    + 'A manager still accepts or declines every one — but the links keep working if you change '
    + 'who can join, so treat them as private.',
};

/**
 * The window the server will accept for an expiry.
 *
 * `validateExpiry` on the route refuses anything at or before now, and anything
 * more than five years out — because "never" is expressed by leaving the field
 * blank rather than by a date in the year 9999. These put the same bounds on
 * the picker, so a manager cannot choose a date that will be refused after a
 * round trip.
 *
 * Functions rather than constants: a dialog left open across midnight would
 * otherwise offer a `min` of yesterday.
 */
const day = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
const EXPIRY_MIN = () => day(24 * 60 * 60 * 1000);
const EXPIRY_MAX = () => day(5 * 365 * 24 * 60 * 60 * 1000);

export default function ShareOrganizationDialog({ orgKey, organization, policy, onClose, addToast, onChanged }) {
  const [state, setState] = useState({ loading: true, links: [], canManage: false, canCreate: false, error: '' });
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(null);

  const load = () => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: '' }));
    api.fetchOrganizationShareLinks(orgKey)
      .then(res => {
        if (cancelled) return;
        setState({
          loading: false,
          links: res.links ?? [],
          canManage: Boolean(res.canManage),
          canCreate: Boolean(res.canCreate),
          error: '',
        });
      })
      .catch(err => {
        if (cancelled) return;
        /* `canManage` and `canCreate` are PRESERVED across a failure. Resetting
           them to false turned a manager whose fetch timed out into a member
           looking at a broken dialog: the footer vanished, so the one control
           that could have helped was gone along with the reason. */
        setState(previous => ({ ...previous, loading: false, links: [], error: err.message }));
      });
    return () => { cancelled = true; };
  };

  useEffect(load, [orgKey]);

  const live = state.links.filter(link => link.state === 'live');
  const retired = state.links.filter(link => link.state !== 'live');

  const copy = async (url, what) => {
    if (!url) return;
    try {
      /* Optional-call: `navigator.clipboard` is undefined over plain HTTP and
         in some embedded webviews, and reading `.writeText` off undefined would
         throw before the catch below could turn it into a fallback. */
      await navigator.clipboard?.writeText(url);
      if (!navigator.clipboard) throw new Error('no clipboard');
      addToast?.(`${what} copied.`, 'success');
    } catch {
      /**
       * Point at the field, do not dump the URL into a toast.
       *
       * This used to pass `url`, on the reasoning that `info` "shows it long
       * enough to select". It does not: `addToast` dismisses after five
       * seconds, and selecting a hundred-character URL out of a disappearing
       * strip is not an affordance. The 64-character token also has no break
       * opportunity, so the toast rendered wider than a phone viewport allows.
       *
       * The real fallback is two lines up — a focusable input that selects its
       * whole value on focus. This says so.
       */
      addToast?.(
        'Copying is not available in this browser. Select the link in the box and copy it '
        + 'by hand.',
        'info',
      );
    }
  };

  const share = async (url) => {
    try {
      await navigator.share({
        title: organization?.name,
        text: `Join ${organization?.name ?? 'this organization'} on ${APP_NAME}.`,
        url,
      });
    } catch {
      /* A cancelled share sheet rejects, and that is not a failure worth saying
         anything about. */
    }
  };

  const act = async (what, link, payload) => {
    setBusy(link?.id ?? 'new');
    try {
      if (what === 'create') {
        await api.createOrganizationShareLink(orgKey, payload);
        addToast?.('Invitation link created.', 'success');
        setCreating(false);
      } else if (what === 'rotate') {
        await api.rotateOrganizationShareLink(orgKey, link.id);
        addToast?.('A new link is ready. The old one no longer works.', 'success');
      } else if (what === 'revoke') {
        await api.revokeOrganizationShareLink(orgKey, link.id);
        addToast?.(`“${link.label}” is switched off.`, 'info');
      } else if (what === 'rename') {
        await api.updateOrganizationShareLink(orgKey, link.id, { label: payload.label });
        setRenaming(null);
      } else if (what === 'expiry') {
        await api.updateOrganizationShareLink(orgKey, link.id, { expiresAt: payload.expiresAt });
        addToast?.(
          payload.expiresAt
            ? `“${link.label}” will stop working on ${formatDay(payload.expiresAt)}.`
            : `“${link.label}” no longer expires.`,
          'info',
        );
      }
      setConfirming(null);
      load();
      onChanged?.();
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  /* Through `organizationPath`, not `/organizations/${handle}` by hand. It is
     the one builder that adds the sigil AND encodes the segment — and this
     value is copied to a clipboard and pasted into a browser, which is the
     worst place for a URL that is nearly right. */
  const publicAddress = organization?.slug ? publicUrl(organizationPath(organization)) : '';

  return (
    <>
      <Modal onClose={onClose} label={`Share ${organization?.name ?? 'this organization'}`}>
        <ModalHead
          title="Share this organization"
          /**
            * Singular for somebody who can only ever see one.
            *
            * A member with share rights is given the club's primary link and
            * nothing else, so a sentence about "these links" describes a list
            * they are not looking at. `canManage` is the server's answer about
            * which reader this is.
            */
          description={(state.canManage ? WHAT_THE_LINK_DOES : WHAT_ONE_LINK_DOES)[policy]
            ?? (state.canManage ? WHAT_THE_LINK_DOES : WHAT_ONE_LINK_DOES).invite}
          onClose={onClose}
        />

        <div className="modal-body stack-md">
          {/**
            * The public address, when there is one.
            *
            * Shown first because it is the one a manager should reach for by
            * default: it never expires, it cannot be leaked into a credential,
            * and it is the thing that reads well on a poster. Absent entirely
            * for an unlisted club, rather than shown with a warning — an
            * address that answers "not found" to everybody outside the club is
            * not an address.
            */}
          {/**
            * An unlisted club: say the address EXISTS as an option.
            *
            * Absent-rather-than-broken is right for the address itself — one
            * that answers 404 to everybody outside the club is not an address —
            * but the original version said nothing at all. Migration 063
            * backfills every club that predates the setting to `unlisted`, so
            * on the day this shipped every existing manager opened Share, saw
            * only invitation links, and had no signal that a public page was a
            * thing they could have.
            *
            * Managers only: a member who may share cannot change the setting,
            * so telling them where it lives is an instruction they cannot
            * follow.
            */}
          {state.canManage && organization?.visibility !== 'public' && (
            <p className="muted small org-share-unlisted">
              This organization has no public address. You can turn on a page anybody can open in
              Settings, under “Who can see this organization’s page?”.
            </p>
          )}

          {organization?.visibility === 'public' && publicAddress && (
            <div className="org-share-plate org-share-address">
              <label className="label" htmlFor="org-public-url">Public address</label>
              <input
                id="org-public-url"
                className="org-share-url"
                type="text"
                readOnly
                value={publicAddress}
                onFocus={e => e.target.select()}
              />
              <p className="muted small">
                Anybody can open this, with or without an account. It does not let anybody join —
                use an invitation link for that.
              </p>
              <div className="row row-wrap">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(publicAddress, 'Public address')}>
                  <Copy size={14} aria-hidden="true" /> Copy address
                </button>
              </div>
            </div>
          )}

          {state.loading && <p className="muted">Loading the invitation links…</p>}

          {!state.loading && state.error && (
            <div className="alert alert-danger stack-sm" role="alert">
              <p>{state.error}</p>
              {/* A way out. Both public pages got a retry for exactly this
                  case; the dialog's only escape was to close and reopen it,
                  with nothing saying that would help. */}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => load()}>
                Try again
              </button>
            </div>
          )}

          {!state.loading && !state.error && state.links.length === 0 && (
            <div className="org-share-empty">
              <Link2 size={22} aria-hidden="true" />
              <div className="stack-xs">
                <p className="org-share-empty-title">No invitation link yet</p>
                <p className="muted small">
                  {state.canCreate
                    ? 'Create one and you can put it on a flyer, in a group chat, or in an email.'
                    : 'Ask a manager of this organization to create one.'}
                </p>
              </div>
            </div>
          )}

          {live.map(link => (
            <LinkPlate
              key={link.id}
              link={link}
              canManage={state.canManage}
              busy={busy === link.id}
              renaming={renaming === link.id}
              onCopy={() => copy(publicUrl(link.path), 'Invitation link')}
              onShare={() => share(publicUrl(link.path))}
              onRename={() => setRenaming(link.id)}
              onRenamed={label => act('rename', link, { label })}
              onCancelRename={() => setRenaming(null)}
              onExpiry={expiresAt => act('expiry', link, { expiresAt })}
              onRotate={() => setConfirming({ what: 'rotate', link })}
              onRevoke={() => setConfirming({ what: 'revoke', link })}
            />
          ))}

          {/**
            * The links that no longer work.
            *
            * Kept visible rather than hidden, because a manager needs to see
            * that the autumn flyer link is the one that stopped working — and
            * the join count beside it is the only record that the flyer worked
            * at all. Managers only: a member who may share has no reason to
            * read the club's operational history.
            */}
          {state.canManage && retired.length > 0 && (
            <details className="org-share-retired">
              <summary>
                {retired.length} link{retired.length === 1 ? '' : 's'} no longer working
              </summary>
              <ul className="list">
                {retired.map(link => (
                  <li key={link.id} className="list-row org-share-retired-row">
                    <span className="stack-xs">
                      <span className="org-share-label">{link.label}</span>
                      <span className="muted small">
                        {link.state === 'revoked' ? 'Switched off' : 'Expired'}
                        {' · '}{link.uses} {link.uses === 1 ? 'person joined' : 'people joined'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {creating && (
            <NewLinkForm
              busy={busy === 'new'}
              onCreate={payload => act('create', null, payload)}
              onCancel={() => setCreating(false)}
            />
          )}
        </div>

        {state.canManage && !creating && (
          <div className="modal-foot org-share-foot">
            {/**
              * `aria-disabled`, not `disabled`.
              *
              * `disabled` takes the button out of the tab order, so a keyboard
              * or screen-reader user never landed on it — and the paragraph
              * explaining why was associated with nothing. They met a control
              * they could not reach and no reason for it. `aria-disabled` keeps
              * it focusable and lets `aria-describedby` carry the reason; the
              * handler refuses, so the state is still enforced.
              */}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              aria-disabled={!state.canCreate}
              aria-describedby={state.canCreate ? undefined : 'org-share-cap'}
              onClick={() => { if (state.canCreate) setCreating(true); }}
            >
              <Plus size={15} aria-hidden="true" /> New link
            </button>
            {!state.canCreate && (
              <p className="muted small" id="org-share-cap">
                This organization has as many working links as it can have. Switch one off to make
                another.
              </p>
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
      {confirming?.what === 'rotate' && (
        <ConfirmDialog
          title={`Regenerate “${confirming.link.label}”?`}
          /* Not "Regenerate" — that is the label on the control that OPENED
             this, and two identically-named buttons in one flow is how somebody
             reads the confirmation as the thing they already pressed. */
          confirmLabel="Regenerate link"
          /* Marked destructive, and Switch off is not the only one that should
             be. Regenerating is the operation that breaks the printed flyer
             this dialog keeps invoking — "every copy of this link stops
             working" — while switching one of several links off is the milder
             act. Styling them the other way round was backwards. */
          destructive
          busy={busy === confirming.link.id}
          overlayClassName="modal-overlay-stacked"
          onConfirm={() => act('rotate', confirming.link)}
          onCancel={() => setConfirming(null)}
        >
          <p>
            Every copy of this link stops working, so anybody you already sent it to will
            need the new one. Your other links are not affected.
          </p>
          <p>
            <strong>Nobody loses their membership.</strong> Everyone in this organization
            stays in it.
          </p>
        </ConfirmDialog>
      )}

      {confirming?.what === 'revoke' && (
        <ConfirmDialog
          title={`Switch off “${confirming.link.label}”?`}
          confirmLabel="Switch it off"
          destructive
          busy={busy === confirming.link.id}
          overlayClassName="modal-overlay-stacked"
          onConfirm={() => act('revoke', confirming.link)}
          onCancel={() => setConfirming(null)}
        >
          <p>
            This link stops working. Your other links carry on.
            {live.length === 1 && (
              <> This is the only one that works, so if joining is set
                to <strong>Invitation only</strong>, nobody new can join until you make another.</>
            )}
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

/**
 * One working link.
 *
 * The URL is a real, focusable, selectable input so somebody whose clipboard is
 * unavailable can still get the value out by hand — and it selects on focus,
 * because that is what somebody is about to do with it.
 */
function LinkPlate({
  link, canManage, busy, renaming,
  onCopy, onShare, onRename, onRenamed, onCancelRename, onExpiry, onRotate, onRevoke,
}) {
  const url = publicUrl(link.path);
  const inputId = `org-share-url-${link.id}`;

  return (
    <div className="org-share-plate">
      {renaming ? (
        <RenameForm label={link.label} busy={busy} onSave={onRenamed} onCancel={onCancelRename} />
      ) : (
        <div className="row org-share-labelrow">
          <label className="label" htmlFor={inputId}>{link.label}</label>
          {canManage && (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label={`Rename “${link.label}”`}
              onClick={onRename}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <input
        id={inputId}
        className="org-share-url"
        type="text"
        readOnly
        value={url}
        /**
         * Named "Invitation link: <label>", not just "<label>".
         *
         * With the visible `<label>` alone, a screen-reader user tabbing this
         * dialog heard "Public address, edit text" and then "Autumn flyer, edit
         * text" — and the one distinction this dialog exists to draw was
         * carried entirely by a dashed border and visual grouping. The visible
         * label stays as it is for the sighted reader.
         */
        aria-label={`Invitation link: ${link.label}`}
        onFocus={e => e.target.select()}
      />

      <p className="muted small org-share-age">
        Created {formatDay(link.createdAt)}
        {canManage && (
          <> · {link.uses} {link.uses === 1 ? 'person joined' : 'people joined'}</>
        )}
        {link.expiresAt && <> · stops working {formatDay(link.expiresAt)}</>}
      </p>

      <div className="row row-wrap org-share-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={onCopy}>
          <Copy size={14} aria-hidden="true" /> Copy link
        </button>
        {/* Rendered only where it exists. A Share button that silently does
            nothing is worse than no Share button. */}
        {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onShare}>
            <Share2 size={14} aria-hidden="true" /> Share…
          </button>
        )}
        {canManage && (
          /**
           * Regenerate, then expiry, then Switch off — in the DOM, on both
           * breakpoints.
           *
           * The destructive control is last. The order used to put it beside
           * Copy, which read correctly on a wide screen and badly on a narrow
           * one: the footer stacks below 640px, so the DESTRUCTIVE control
           * ended up directly beneath the button this dialog exists for — the
           * nearest thing to a thumb reaching for Copy. Measured at 375px.
           *
           * One order rather than a `column-reverse` on mobile, because
           * reversing visually while leaving the DOM alone puts tab order and
           * reading order in disagreement, which is a worse problem than the
           * one it solves.
           */
          <>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onRotate}>
              {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
              Regenerate
            </button>
            <ExpiryControl link={link} busy={busy} onExpiry={onExpiry} />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              aria-label={`Switch off “${link.label}”`}
              onClick={onRevoke}
            >
              <Ban size={14} aria-hidden="true" /> Switch off
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function RenameForm({ label, busy, onSave, onCancel }) {
  const [value, setValue] = useState(label);
  return (
    <form
      className="row org-share-rename"
      onSubmit={e => { e.preventDefault(); onSave(value.trim() || label); }}
    >
      <label className="sr-only" htmlFor="org-share-rename-input">Rename this link</label>
      <input
        id="org-share-rename-input"
        className="input"
        value={value}
        maxLength={40}
        onChange={e => setValue(e.target.value)}
        autoFocus
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        <Check size={14} aria-hidden="true" /> Save
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
    </form>
  );
}

/**
 * Setting or clearing when a link stops working.
 *
 * ── The warning is the point ──
 *
 * A link with an expiry is the one thing in this dialog that breaks LATER, when
 * nobody is looking at it — the flyer on the wall works in September and quietly
 * stops in October. So choosing a date says so in the sentence beside the field,
 * and "does not expire" is the default the field opens on.
 */
function ExpiryControl({ link, busy, onExpiry }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(link.expiresAt ? link.expiresAt.slice(0, 10) : '');
  /**
   * The button this form replaces, so focus comes back to it.
   *
   * Closing the form unmounted the focused element and dropped focus to the
   * document — inside an open modal, which means a keyboard user had to tab
   * from the top of the dialog to get back to where they were.
   */
  const openerRef = useRef(null);
  const [returnFocus, setReturnFocus] = useState(false);
  const close = () => { setReturnFocus(true); setOpen(false); };

  useEffect(() => {
    if (!open && returnFocus) {
      openerRef.current?.focus();
      setReturnFocus(false);
    }
  }, [open, returnFocus]);

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" ref={openerRef} onClick={() => setOpen(true)}>
        <CalendarClock size={14} aria-hidden="true" />
        {link.expiresAt ? 'Change expiry' : 'Add an expiry'}
      </button>
    );
  }

  const inputId = `org-share-expiry-${link.id}`;
  return (
    <form
      className="stack-xs org-share-expiry"
      onSubmit={e => {
        e.preventDefault();
        /* An end-of-day boundary, so a date a manager typed means "through that
           day" rather than "at midnight as it begins" — which would make a link
           chosen for Saturday's event booth dead all of Saturday. */
        onExpiry(value ? new Date(`${value}T23:59:59`).toISOString() : null);
        close();
      }}
    >
      <label className="label" htmlFor={inputId}>Stop working after</label>
      {/**
        * `min` and `max`, because the server refuses outside them.
        *
        * `validateExpiry` rejects any date at or before now and anything more
        * than five years out. Without these the picker happily offered
        * yesterday — which, for "Add an expiry", is a link that dies the moment
        * it is created — and the refusal arrived as a toast after a round trip.
        *
        * `autoFocus` because this field replaces the button that was focused;
        * without it focus fell to the document inside an open modal and a
        * keyboard user had to Tab from the top of the dialog to find it.
        */}
      <input
        id={inputId}
        className="input"
        type="date"
        value={value}
        min={EXPIRY_MIN()}
        max={EXPIRY_MAX()}
        onChange={e => setValue(e.target.value)}
        aria-describedby={`${inputId}-hint`}
        autoFocus
      />
      <p id={`${inputId}-hint`} className="muted small">
        {value
          ? 'After this date the link stops letting anybody in, and anybody who has it will '
            + 'need a new one. Members are not affected.'
          : 'Leave this blank and the link keeps working until you switch it off — which is '
            + 'what you want for a flyer or a poster.'}
      </p>
      <div className="row row-wrap">
        {/* `disabled={busy}` like every other submit in this file — this was
            the one without it. */}
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>Save</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

/** The new-link form: a label and an optional expiry, in that order. */
function NewLinkForm({ busy, onCreate, onCancel }) {
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState('');

  return (
    <form
      className="org-share-new stack-sm"
      onSubmit={e => {
        e.preventDefault();
        onCreate({
          label: label.trim() || undefined,
          expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        });
      }}
    >
      <label className="label" htmlFor="org-new-link-label">
        What is this link for?
      </label>
      <input
        id="org-new-link-label"
        className="input"
        value={label}
        maxLength={40}
        onChange={e => setLabel(e.target.value)}
        placeholder="Autumn flyer, Instagram, event booth…"
        aria-describedby="org-new-link-hint"
        autoFocus
      />
      <p id="org-new-link-hint" className="muted small">
        A name only you and the other managers see. It is how you tell which link to switch off
        later.
      </p>

      <label className="label" htmlFor="org-new-link-expiry">
        Stop working after <span className="muted">(optional)</span>
      </label>
      <input
        id="org-new-link-expiry"
        className="input"
        type="date"
        value={expires}
        min={EXPIRY_MIN()}
        max={EXPIRY_MAX()}
        onChange={e => setExpires(e.target.value)}
        aria-describedby="org-new-link-expiry-hint"
      />
      <p id="org-new-link-expiry-hint" className="muted small">
        {expires
          ? 'This link will stop letting anybody in after that date. Leave it blank for a link '
            + 'that keeps working — which is what a flyer needs.'
          : 'Leave this blank and the link keeps working until you switch it off.'}
      </p>

      <div className="row row-wrap">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Link2 size={15} aria-hidden="true" />}
          Create link
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
