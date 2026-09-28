import { useEffect, useState } from 'react';

/**
 * Whether a confirmation is being seen for the first time — the one moment the
 * brand's success beat (`BrandMark motion="success"`) is allowed to play.
 *
 * ── Why this is decided in the browser ──
 *
 * The three confirmations it covers are other people's acts that reach the
 * volunteer later: an organizer closing out hours, an organizer accepting an
 * application, a certificate being issued. None of the first two carries a
 * decided-at timestamp (`attendance` and `applications` store only the state),
 * so "newer than your last view" cannot be answered from the data. It can be
 * answered from what this browser has already shown: an item plays the first
 * time it is seen in its confirmed state, and is recorded as seen.
 *
 * ── Why the first visit plays nothing ──
 *
 * The first time a kind of confirmation is looked at here, every item already
 * in that state is history — it was confirmed before this code shipped, or on
 * another device. Playing them all would fire a beat on every row of a
 * volunteer's record at once, which is the "hours as a score" effect the
 * product rules out. So a kind's first page load records what is there and
 * plays nothing; from the next load on, only genuinely new items play.
 *
 * Where storage is unavailable (a private window, blocked site data) nothing
 * plays. Static is always a correct rendering; a beat on every visit is not.
 */

const KEY_PREFIX = 'wev-confirmations:';

/** Kinds whose baseline was created during this page load. */
const freshKinds = new Set();

function storageKey(userId) {
  return `${KEY_PREFIX}${userId}`;
}

function readStore(userId) {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && parsed.seen && parsed.kinds) return parsed;
    return { kinds: {}, seen: {} };
  } catch {
    return null;
  }
}

function writeStore(userId, store) {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure apart from creating a kind's baseline, which is idempotent: calling it
 * twice (StrictMode runs state initialisers twice) gives the same answer.
 */
export function shouldPlayConfirmation(userId, kind, itemKey) {
  if (!userId || !kind || !itemKey || typeof window === 'undefined') return false;
  const store = readStore(userId);
  if (!store) return false;
  if (!store.kinds[kind]) {
    store.kinds[kind] = new Date().toISOString();
    if (!writeStore(userId, store)) return false;
    freshKinds.add(`${userId}:${kind}`);
  }
  if (freshKinds.has(`${userId}:${kind}`)) return false;
  return !store.seen[`${kind}:${itemKey}`];
}

export function markConfirmationSeen(userId, kind, itemKey) {
  if (!userId || !kind || !itemKey || typeof window === 'undefined') return;
  const store = readStore(userId);
  if (!store) return;
  const key = `${kind}:${itemKey}`;
  if (store.seen[key]) return;
  store.seen[key] = 1;
  writeStore(userId, store);
}

/**
 * `true` for the whole life of the component that first shows a confirmation,
 * `false` everywhere after. Decided once per `itemKey`, so a re-render never
 * restarts the beat; recorded as seen after the commit that showed it.
 *
 * `itemKey` null means "not in the confirmed state" — nothing is recorded, so
 * the item can still play the moment it becomes confirmed, including while the
 * reader is looking at it.
 */
export function useConfirmationBeat(userId, kind, itemKey) {
  const [decision, setDecision] = useState(() => ({
    key: itemKey,
    play: shouldPlayConfirmation(userId, kind, itemKey),
  }));
  let { play } = decision;
  if (decision.key !== itemKey) {
    play = shouldPlayConfirmation(userId, kind, itemKey);
    setDecision({ key: itemKey, play });
  }
  useEffect(() => {
    markConfirmationSeen(userId, kind, itemKey);
  }, [userId, kind, itemKey]);
  return play;
}

/** Test seam: forget which kinds were first seen during this load. */
export function __resetConfirmationBaselines() {
  freshKinds.clear();
}
