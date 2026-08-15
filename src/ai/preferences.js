/**
 * What this person has chosen about on-device AI, stored on this device only.
 *
 * ── Why these are not stored with the other privacy settings ──
 *
 * Every other privacy control in WeVolunteer lives on the user's row and is
 * saved through `PATCH /api/auth/profile`, because each one governs what OTHER
 * people can see: profile visibility, hours visibility, certificate visibility,
 * leaderboard participation, analytics consent. They have to be on the server,
 * because the server is what enforces them.
 *
 * These settings govern nothing on the server. Whether a model is loaded in this
 * browser, which one, and whether a conversation is kept in this tab are facts
 * about one device. Sending them would create a server-side record of when a
 * student uses the assistant and how — telemetry about a feature whose entire
 * premise is that it does not report on them — in exchange for a preference
 * syncing between devices, which is not worth having when the model it names is
 * cached per-device anyway.
 *
 * So: `localStorage`, and the server never learns any of it.
 *
 * ── Absent is off ──
 *
 * A missing value is "not chosen", and everything defaults to off. Nothing here
 * is opt-out. A student who has never opened these settings has no model, no
 * download, and no assistant.
 */

const KEY = 'wev-ai-prefs';

export const DEFAULT_PREFERENCES = Object.freeze({
  /** Has this person switched the assistant on, on this device. */
  enabled: false,
  /** Which registry model they chose. Null until they pick one. */
  modelId: null,
  /**
   * Keep the conversation in this browser between visits.
   *
   * Default off. Conversations mention the things a student volunteers for and
   * asks about, and keeping them is a choice with a cost — one made
   * deliberately rather than inherited.
   */
  saveConversations: false,
  /**
   * Voice input. Default off, and separately controlled, because — unlike
   * everything else here — the browser's speech recognition may send audio to
   * the browser vendor. It is the one part of this feature that is not
   * on-device, so it does not ride along on the same switch.
   */
  voiceInput: false,
});

/**
 * Reading must never throw.
 *
 * Safari in private mode throws on `localStorage` access rather than returning
 * null, and this repository has been caught by that before — the error-scene
 * selector is wrapped for the same reason. Settings failing to render because
 * storage is unavailable would be a far worse outcome than the defaults.
 */
export function readPreferences() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFERENCES };

    /* Field by field against the defaults, rather than spreading whatever was
       stored. A stale build's key, or a hand-edited value, cannot introduce a
       property the rest of the code does not expect. */
    return {
      enabled: parsed.enabled === true,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : null,
      saveConversations: parsed.saveConversations === true,
      voiceInput: parsed.voiceInput === true,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Merge a change in and persist it. Returns the resulting preferences, so a
 * caller can set state from the value that was actually stored rather than the
 * one it hoped for.
 */
export function writePreferences(patch) {
  const next = { ...readPreferences(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* Full or unavailable storage. The setting holds for this session and is
       forgotten on reload, which is survivable and honest — far better than
       refusing the change. */
  }
  return next;
}

/**
 * Forget every AI preference on this device.
 *
 * Deliberately narrow: it removes this one key and nothing else. "Clear AI
 * data" must not take the theme, the cached user, or a draft attendance sheet
 * with it. Downloaded models and verification records are removed separately,
 * by the storage module and `integrity.forgetVerifications` respectively —
 * three explicit steps rather than one clear-everything that is difficult to
 * reason about later.
 */
export function clearPreferences() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* Nothing to clear if storage is unavailable. */
  }
}
