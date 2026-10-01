import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import NoticeBanner from '../notifications/NoticeBanner';
import '../notifications/NoticeBanner.css';
import { isLocalAIEnabled, detectCapability } from '../../ai';
import { readPreferences } from '../../ai/preferences';
import { useLocationContext } from '../../contexts/LocationContext';
import { can } from '../../authz.js';

/** Where "Not now" is remembered. Per device, like the model itself. */
const DISMISSED_KEY = 'wev-welly-offer-dismissed';

const readDismissed = () => {
  try { return localStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
};

/**
 * "Enable AI mode?", where a student meets the suggestions (P2-32, ruling 7).
 *
 * Welly AI was offered only from Settings, which nobody opens looking for it.
 * The owner asked for the offer on Discover's "Suggested for you", in the same
 * notice as the location offer — so it is that notice, with the same layout,
 * dismissal and focus handling.
 *
 * ── One offer at a time ──
 *
 * The shell shows one notice at a time, by a priority ladder (`AppNotices`),
 * and the location offer lives there. This one sits on Discover rather than in
 * that slot, so it waits for the location offer to be answered or dismissed
 * instead of standing beside it.
 *
 * ── Who is offered it ──
 *
 * Only a build that ships the on-device runtime, a device that can run a
 * model, an account that may use Welly at all, and somebody who has not turned
 * it on. "Not now" is remembered on this device, for good: Settings still
 * offers setup, and an offer that comes back every visit is a nag.
 */
export default function WellyOfferBanner({ currentUser }) {
  const location = useLocationContext();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [capability] = useState(() => (isLocalAIEnabled() ? detectCapability() : null));

  if (!isLocalAIEnabled() || !capability?.supported) return null;
  if (!can(currentUser, 'assistant.use')) return null;
  if (readPreferences().enabled || dismissed) return null;
  if (location?.showPrompt) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* storage unavailable: hidden for this visit */ }
    setDismissed(true);
  };

  return (
    <NoticeBanner
      label="Welly AI"
      icon={<Sparkles size={16} />}
      title="Turn on Welly AI?"
      action={(
        <Link className="btn btn-primary btn-sm" to="/settings?section=privacy&setup=1#welly-ai">
          Set up Welly AI
        </Link>
      )}
      onDismiss={dismiss}
      dismissLabel="Not now — stop offering Welly AI on this device"
    >
      Ask Welly about opportunities, your hours and your certificates with a private AI that
      runs on this device. Setting it up downloads a model once, and you can remove it any time.
      {capability.experimental && ' It is experimental on this device.'}
    </NoticeBanner>
  );
}
