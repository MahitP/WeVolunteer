/**
 * Keeping a conversation, only when asked to.
 *
 * ── Off by default, and stored nowhere else ──
 *
 * A transcript records what somebody asked about their own volunteering: which
 * causes interest them, what they have not signed up for, what they were
 * worried enough about to check. That is worth more care than a UI convenience
 * usually gets.
 *
 * So it is off unless switched on in Settings, it lives in `localStorage` on
 * this device, and it is never sent anywhere — not to WeVolunteer, not to
 * analytics, not into an error report. When the preference is off, nothing is
 * written at all, rather than being written and hidden.
 *
 * ── Bounded ──
 *
 * Kept to a small number of recent turns. A transcript that grows without limit
 * eventually fills the origin's storage quota, and the failure lands on the
 * model download rather than here, where it would be impossible to diagnose.
 */

import { readPreferences } from './preferences.js';

const KEY = 'wev-ai-conversation';

/** Turns retained. Enough to scroll back through, far short of a diary. */
export const MAX_TURNS = 20;

/**
 * Cards are dropped before storing.
 *
 * A card holds a snapshot of live data — hours, certificate codes, event
 * details. Persisting it would keep a copy of somebody's record in
 * `localStorage` long after the page that fetched it, and it would go stale:
 * a card restored next week would show last week's figures as though they were
 * current. The text is kept; the data is re-fetched if asked again.
 */
function forStorage(messages) {
  return messages.slice(-MAX_TURNS).map(({ role, text }) => ({ role, text }));
}

export function loadConversation() {
  if (!readPreferences().saveConversations) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .slice(-MAX_TURNS);
  } catch {
    return [];
  }
}

export function saveConversation(messages) {
  /* Checked on every write, not only at startup, so turning the preference off
     mid-conversation stops recording immediately. */
  if (!readPreferences().saveConversations) return;

  /**
   * An empty conversation removes the key rather than storing `[]`.
   *
   * Clearing writes the emptied list straight back through this function, so
   * storing an empty array would leave a key behind immediately after somebody
   * asked for the conversation to be deleted. "Cleared" should mean nothing is
   * there, not that something empty is.
   */
  try {
    if (!messages.length) {
      window.localStorage.removeItem(KEY);
      return;
    }
    window.localStorage.setItem(KEY, JSON.stringify(forStorage(messages)));
  } catch {
    /* A full quota must not break the conversation in progress. */
  }
}

export function clearConversation() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* Nothing to clear. */
  }
}
