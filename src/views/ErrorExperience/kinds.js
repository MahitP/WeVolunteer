/**
 * The canonical set of failure situations, and the tone each one is allowed.
 *
 * ── Why these are situations, not status codes ──
 *
 * `500`, `crash` and `chunk` are all "our fault", and a system that keyed off
 * the status code would give all three the same words. They need different
 * words, because what the reader should DO about them differs: a server fault
 * is worth retrying in a minute, a render crash is worth reloading now, and a
 * bundle that failed to arrive is usually a stale tab against a new deploy.
 *
 * ── The tone ladder ──
 *
 * This is the rule the research kept turning up and the one most error pages
 * break. A dead link costs the reader nothing, so warmth is welcome. A 500 may
 * mean they just lost work, and a joke told at that moment reads as not
 * understanding what happened to them — it spends exactly the trust an error
 * screen exists to keep.
 *
 * So tone is not left to whoever writes the next theme's copy. `SERIOUS` is
 * enforced by `errorCopy.test.js`: those kinds must carry the reassurance, and
 * must not contain an exclamation mark, in every theme.
 */

/** Every fullscreen situation the experience can render. */
export const KINDS = Object.freeze([
  '404',
  '403',
  '500',
  'crash',
  'chunk',
  'offline',
  'expired',
  'maintenance',
]);

/**
 * Kinds written flat, in every theme.
 *
 * `offline` is here despite being nobody's fault: someone on a school bus with
 * one bar does not want whimsy, they want to know whether to keep waiting.
 * `expired` is here because they are usually mid-form and about to lose what
 * they typed.
 */
export const SERIOUS = Object.freeze(['500', 'crash', 'offline', 'expired']);

/** Kinds where retrying is the useful action, so the frame offers a retry. */
export const RETRYABLE = Object.freeze(['500', 'crash', 'chunk', 'offline', 'maintenance']);

/**
 * The sentence every serious kind must contain, in some form.
 *
 * Not a style preference: "did I just lose my hours?" is the actual question a
 * volunteer has when a page dies, and answering it is more urgent than
 * explaining what broke.
 */
export const REASSURANCE = /your (data|work|hours) (is|are) safe/i;

export function isKind(value) {
  return KINDS.includes(value);
}

/**
 * The wordings a browser uses when a lazy route's bundle does not arrive.
 *
 * Chrome, Firefox and Safari each phrase it differently and none of them
 * attaches a code, so this is string matching against a message — fragile by
 * construction, which is why the list is pinned by `kinds.test.js` rather than
 * left inline at the call site where nobody would notice it rotting.
 *
 * The last entry is Vite's own preload helper rather than the engine.
 */
const CHUNK_MESSAGES = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

/**
 * Which situation a caught error actually is.
 *
 * A tab left open across a release asks for a hashed filename that no longer
 * exists on the server. That is not a crash: nothing is broken, the reader's
 * copy of the app is simply out of date, and the fix is a reload — which is
 * precisely what the crash wording does not tell them to do, and what the
 * boundary's own `reset` cannot achieve, since the file is genuinely gone.
 *
 * Everything else is `crash`. Guessing "stale tab" for a real render fault is
 * the worse mistake of the two: it sends somebody to reload a page whose
 * unsaved state the reload then destroys, and it does not fix anything.
 *
 * Total by design — a boundary is handed whatever was thrown, and that is not
 * always an `Error`. Anything unreadable is a crash.
 */
export function kindForError(error) {
  try {
    if (error?.name === 'ChunkLoadError') return 'chunk';
    const message = typeof error?.message === 'string' ? error.message : '';
    if (CHUNK_MESSAGES.some((re) => re.test(message))) return 'chunk';
  } catch {
    /* A hostile getter on the thrown value. It is still a crash. */
  }
  return 'crash';
}
