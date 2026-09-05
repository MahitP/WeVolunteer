import React from 'react';
import { MapPin } from 'lucide-react';
import { useLocationContext } from '../../contexts/LocationContext';
import NoticeBanner from '../notifications/NoticeBanner';

/**
 * The opt-in that "near me" was always supposed to have.
 *
 * `LocationContext` has exposed `showPrompt` and `dismissPrompt` since it was
 * written and nothing has ever consumed them, so this banner did not exist —
 * even though the feature documentation describes it as shipped, and describes
 * it as the reason the context is safe. The consequence was that a volunteer
 * only discovered distance filtering by opening the advanced filters on
 * Discover and noticing a "Share location to enable" button. Almost nobody did.
 *
 * ── Why a banner and not a call on load ──
 *
 * Browsers only show the permission dialog in response to a gesture, and a site
 * that fires it unprompted trains people to refuse. The button here IS that
 * gesture. That is the whole reason `showPrompt` is separate from
 * `requestLocation`: this decides when to ask, and the volunteer decides
 * whether to answer.
 *
 * ── What it promises, and what the code actually does ──
 *
 * The copy says the position stays on the device and nothing is stored, so it
 * is worth being able to check that from here: the context keeps coordinates in
 * React state only, `sessionStorage` records that the question was asked and
 * not the answer to it, distance is computed in the browser, and the only thing
 * the server ever receives is a centre rounded to about a kilometre when a
 * radius filter is actually used. A promise this specific is one somebody can
 * hold the code to later.
 *
 * ── Why the markup now comes from `NoticeBanner` ──
 *
 * This banner's treatment became the shell's notice treatment: the legal change
 * notice sits in the same slot and had to look like the same product. The
 * markup and classes moved into the shared primitive unchanged — same
 * declarations, neutral names — so there is one copy of "what a notice looks
 * like" rather than two that agree today.
 *
 * It keeps its own `showPrompt` guard even though `AppNotices` already decides
 * whether to render it. The guard is cheap and it keeps this component honest
 * on its own terms: rendering it directly, as its test does, must not produce a
 * banner for somebody who has already answered the question.
 */
export default function LocationPrompt() {
  const ctx = useLocationContext();
  if (!ctx) return null;

  const { showPrompt, requestLocation, dismissPrompt } = ctx;
  if (!showPrompt) return null;

  return (
    <NoticeBanner
      label="Use your location"
      icon={<MapPin size={16} />}
      title="See how far away opportunities are"
      action={(
        <button type="button" className="btn btn-primary btn-sm" onClick={() => requestLocation()}>
          Use my location
        </button>
      )}
      onDismiss={dismissPrompt}
      dismissLabel="Not now — hide this for the rest of this session"
    >
      Share your location to sort by distance and filter to what is nearby.
      It stays on your device, and nothing is saved.
    </NoticeBanner>
  );
}
