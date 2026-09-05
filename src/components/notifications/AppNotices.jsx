import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { useLocationContext } from '../../contexts/LocationContext';
import LocationPrompt from '../location/LocationPrompt';
import LegalUpdateNotice from '../legal/LegalUpdateNotice';
import LegalAcceptanceModal from '../legal/LegalAcceptanceModal';
import './NoticeBanner.css';

/**
 * Everything the shell has to tell somebody, and the order it says it in.
 *
 * ── Why one component owns all of it ──
 *
 * The shell used to mount `<LocationPrompt />` and `<LegalUpdateModal />` side
 * by side, each deciding independently whether to appear. That works for two
 * notices that cannot coincide and stops working the moment they can:
 *
 *   • NOTHING decided priority. A legal change and a location offer would both
 *     be on screen, stacked, each with its own bottom margin, and which one was
 *     on top depended on the order they happen to be written in `App.jsx`.
 *
 *   • NOTHING could tell whether the slot was empty. Each banner carried its
 *     own `margin-bottom`, so spacing existed only as a property of a
 *     conditional element — which is fine until any wrapper appears around it,
 *     and then the wrapper keeps the margin after the banner inside it has
 *     gone. An empty strip above the dashboard is the failure that arrangement
 *     makes possible; this one makes it unreachable, because when there is
 *     nothing to say this component renders `null` and there is no node at all.
 *
 *   • BOTH would have fetched. The acceptance dialog and the ordinary banner
 *     read the same endpoint, and two fetches of one endpoint is two answers
 *     that can disagree — one showing a banner for a change the other is
 *     blocking on.
 *
 * So: one fetch, one ordered decision, one slot.
 *
 * ── The priority ladder ──
 *
 *   1. A material change that has taken effect. The mandatory dialog, and while
 *      it is up NOTHING else renders: it covers the page, so a banner behind
 *      the backdrop is a notice nobody can read competing with a question they
 *      have to answer.
 *   2. Legal document changes. One banner, however many documents — see
 *      `LegalUpdateNotice`.
 *   3. The location opt-in. Lowest, because it is an offer rather than news,
 *      and because it comes back: `dismissPrompt` remembers for the tab, not
 *      for ever.
 *
 * ── One banner at a time, and that is the restraint the feature is for ──
 *
 * Levels 2 and 3 are not stacked. A legal notice suppresses the location offer
 * until it is dealt with, and since dealing with it is one click on an `X`, the
 * offer is delayed rather than lost. The alternative — two strips above every
 * page — is the "five ugly notification boxes" outcome, just earlier: it is the
 * shape that makes the notice slot feel like a place things pile up instead of
 * a place the app tells you one thing.
 */
export default function AppNotices({ onAccepted, onSignOut }) {
  const locationCtx = useLocationContext();

  const [notices, setNotices] = useState([]);
  const [required, setRequired] = useState([]);

  const load = useCallback(async () => {
    const res = await api.fetchLegalUpdates();
    const updates = Array.isArray(res?.updates) ? res.updates : [];
    /**
     * The split is the SERVER's, read off a field it computed.
     *
     * `requiresAcceptance` comes from `legalConsentGate.js`, which is also what
     * the capability gate reads. This is a router, not a decision: nothing here
     * inspects a version number or a scope, so there is no second, weaker copy
     * of the materiality rule in the bundle to disagree with the first.
     */
    setRequired(updates.filter(u => u.requiresAcceptance));
    setNotices(updates.filter(u => !u.requiresAcceptance));
  }, []);

  useEffect(() => {
    let cancelled = false;
    /* Silent on failure. A student who opened the app to find a shift should
       not be shown an error about a notice system they never asked about — and
       the capability gate does not depend on this call, so a failure here
       withholds nothing and hides nothing that matters. */
    load().catch(() => { if (!cancelled) { setNotices([]); setRequired([]); } });
    return () => { cancelled = true; };
  }, [load]);

  /**
   * Dismissing the banner acknowledges every change it was speaking for.
   *
   * The banner is an aggregate, so its `X` has to be too: dismissing "we have
   * updated 3 of our documents" and having two of them come back tomorrow would
   * make the count meaningless.
   *
   * `allSettled`, and the local state is cleared regardless. The upsert is
   * idempotent and a genuinely failed acknowledgement produces the notice again
   * on the next load, which is the right failure — showing it twice is a great
   * deal better than trapping somebody behind a banner whose `X` does nothing.
   */
  const dismissNotices = useCallback(async () => {
    const pending = notices;
    setNotices([]);
    await Promise.allSettled(
      pending.map(n => api.acknowledgeLegalUpdate(n.slug, n.version))
    );
  }, [notices]);

  /**
   * Accepting one document: record it, then re-read the pending list.
   *
   * The reload is not a nicety. The acceptance releases the withheld
   * capabilities, and `onAccepted` is `refreshAll` in the shell — every gated
   * control on the page is stale until the session is refetched. Patching state
   * locally would leave the nav rail and the apply buttons rendering the gated
   * role until something else happened to refresh.
   */
  const acceptDocument = useCallback(async (doc) => {
    await api.acceptLegalUpdate(doc.slug, doc.version);
    await load();
    await onAccepted?.();
  }, [load, onAccepted]);

  if (required.length > 0) {
    return (
      <LegalAcceptanceModal
        required={required}
        onAccepted={acceptDocument}
        onSignOut={onSignOut}
      />
    );
  }

  const showLocation = Boolean(locationCtx?.showPrompt);
  const showLegal = notices.length > 0;

  /* The whole point: no notice, no node, no margin. */
  if (!showLegal && !showLocation) return null;

  return (
    <div className="app-notices">
      {showLegal
        ? <LegalUpdateNotice notices={notices} onDismiss={dismissNotices} />
        : <LocationPrompt />}
    </div>
  );
}
