import { THEMES, FALLBACK_THEME_ID, getTheme, themesForKind } from './themes/index.js';

/**
 * Which theme this session sees.
 *
 * ── Store a seed, never a theme name ──
 *
 * The obvious implementation — pick a theme, remember its id — breaks the first
 * time one session hits two different failures. `fair` is not eligible for a
 * 500 and `radio` is not eligible for a 403, so a remembered name has to be
 * either overridden (the session is no longer stable) or obeyed (the screen is
 * no longer honest). Both are wrong.
 *
 * An integer seed avoids the choice. It indexes into the eligible list FOR THE
 * KIND BEING RENDERED, so a session keeps one personality across every error it
 * meets while every individual screen still tells the truth.
 *
 * ── Why sessionStorage and not localStorage ──
 *
 * A theme that never changes is not a rotation; a theme that changes on every
 * refresh is a distraction while somebody is trying to recover from a failure.
 * A tab is the right unit: stable for as long as the person is here, different
 * the next time they come back.
 */

const SEED_KEY = 'wv-error-seed';
const SEED_SPACE = 100003; // prime, so `% eligible.length` does not favour an index

/**
 * The seed used when storage is unavailable.
 *
 * Safari in private mode throws on `sessionStorage.setItem`, and an embedded
 * webview may deny access entirely. Falling back to a fresh random number per
 * call would reshuffle the theme on every re-render, so the fallback is held at
 * module scope: still stable for the life of the document, which is the whole
 * guarantee being made.
 */
let memorySeed = null;

function mintSeed() {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] % SEED_SPACE;
  }
  return Math.floor(Math.random() * SEED_SPACE);
}

/**
 * This tab's seed, minted once.
 *
 * A stored value is only trusted if it is a non-negative integer. Anything else
 * — a half-written value, another tool's key collision, a string — is replaced
 * rather than coerced, because `Number('12abc') % 3` is `NaN` and `NaN` indexes
 * an array as `undefined`, which would take the whole page down at exactly the
 * moment it is meant to be recovering from a failure.
 */
export function getSeed() {
  try {
    const raw = globalThis.sessionStorage?.getItem(SEED_KEY);
    if (raw !== null && raw !== undefined) {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0) return n;
    }
    const fresh = mintSeed();
    globalThis.sessionStorage?.setItem(SEED_KEY, String(fresh));
    return fresh;
  } catch {
    if (memorySeed === null) memorySeed = mintSeed();
    return memorySeed;
  }
}

/**
 * The theme for `kind`, given a seed.
 *
 * Pure and total: any kind, any seed, always a real theme. Exported separately
 * from `selectTheme` so the selection rule can be tested without touching
 * storage — the storage behaviour and the choosing behaviour are different
 * claims and fail for different reasons.
 */
export function themeForSeed(kind, seed) {
  const eligible = themesForKind(kind);

  /* No eligible theme means a kind was added to `KINDS` and nobody gave it a
     home. That is a programming error, and the honest answer at runtime is the
     fallback rather than a crash on the error page itself. A test fails the
     build on it, which is where it should be caught. */
  if (eligible.length === 0) {
    return getTheme(FALLBACK_THEME_ID) ?? THEMES[0];
  }

  const n = Number.isInteger(seed) && seed >= 0 ? seed : 0;
  return eligible[n % eligible.length];
}

/** The theme for `kind` in this session. */
export function selectTheme(kind) {
  return themeForSeed(kind, getSeed());
}

/**
 * The scene mode for a kind, or the theme's first mode if it somehow lacks one.
 *
 * Reached only when a theme is forced past its eligibility — the `theme` prop
 * used by tests and by the dev preview. Rotation cannot produce this state.
 */
export function modeFor(theme, kind) {
  return theme.modes[kind] ?? Object.values(theme.modes)[0];
}

/** Test seam: forget this tab's seed so the next read mints a new one. */
export function resetSeed() {
  memorySeed = null;
  try {
    globalThis.sessionStorage?.removeItem(SEED_KEY);
  } catch {
    /* Nothing to clear if storage was never reachable. */
  }
}

export { SEED_KEY };
