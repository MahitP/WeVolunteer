import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * Interface motion: the small runtime half of the "Interface motion" section at
 * the end of `index.css`. The brand's own motion is `wvMotion.css` and is not
 * touched from here.
 *
 * Everything below degrades to "no motion": a browser without the API, a test
 * renderer without a document, and a reader who asked for less movement all get
 * the same immediate update.
 */

/** How long a wait may run before it is shown as one. Shorter waits flash. */
export const LOADING_THRESHOLD_MS = 300;

/** How long a full-page wait may run before it gets the brand loader. */
export const LONG_WAIT_MS = 1000;

/**
 * Whether the reader asked for less movement, by either of the app's two
 * triggers: the operating system, or their own setting (`data-motion`, written
 * pre-paint by `public/a11y-prefs.js`). There is no third value that animates
 * against either.
 */
export function prefersReducedMotion() {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

/**
 * True once `ms` has passed while `active` stays true; false again the moment
 * it stops. The timer is cleared on resolve, so a quick wait never flashes a
 * loading state.
 */
export function useDelayedFlag(active, ms = LOADING_THRESHOLD_MS) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return undefined; }
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && shown;
}

/**
 * Run a React state update inside a same-document view transition, so rows
 * with a `view-transition-name` move to their new places instead of jumping.
 *
 * `flushSync` is what makes the DOM change inside the callback, which is when
 * the browser takes its "after" snapshot. Without support the update simply
 * happens. Under reduced motion the transition still runs, and the CSS in both
 * reduced-motion blocks removes every group animation, so nothing moves.
 */
export function withViewTransition(update) {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  try {
    const transition = document.startViewTransition(() => flushSync(update));
    /* A skipped transition (a duplicate name, a hidden tab, a second one
       starting) rejects these; the update itself has still happened. Left
       unhandled they would reach the client error reporter as crashes. */
    transition.ready?.catch(() => {});
    transition.finished?.catch(() => {});
    transition.updateCallbackDone?.catch(() => {});
  } catch {
    update();
  }
}

/**
 * Replays a CSS entrance on an element that stays mounted, each time `key`
 * changes — never on the first render.
 *
 * For the route container: the shell's `<main>` is not remounted on
 * navigation (and must not be, or every route would lose its scroll position
 * and focus target), so its entrance is restarted by re-adding the class. The
 * class is only ever added here, and React never rewrites it because the
 * element's own `className` prop does not change.
 */
export function useReplayClass(key, className) {
  const ref = useRef(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    const el = ref.current;
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth; // restart the animation
    el.classList.add(className);
  }, [key, className]);
  return ref;
}

/**
 * A `view-transition-name` for one row of a list, as an inline style.
 *
 * The name is what lets the browser match a row before and after an update and
 * move it to its new place. It has to be a valid identifier and unique on the
 * page for the length of the transition — two rows sharing one abort the whole
 * transition — so it is built from the list's own prefix and the row's id.
 */
export function rowTransitionStyle(prefix, id) {
  if (id === undefined || id === null) return undefined;
  return { viewTransitionName: `${prefix}-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}` };
}

/**
 * `data-page-hidden` on the root while the tab is hidden, so the stylesheet can
 * pause every looping animation (skeleton shimmer, spinners, the brand loader).
 * A loop nobody can see still keeps the CPU out of its low-power state.
 */
export function installPageVisibilityFlag() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const sync = () => {
    if (document.hidden) root.setAttribute('data-page-hidden', '');
    else root.removeAttribute('data-page-hidden');
  };
  sync();
  document.addEventListener('visibilitychange', sync);
}

/** The dialog exit: opacity only, 160ms, the accelerating curve. */
const DIALOG_EXIT_FALLBACK_MS = 400;

/**
 * Fade a dialog out after React has already removed it.
 *
 * ── Why a copy, and why here ──
 *
 * Every dialog in the app is unmounted by its caller — `{open && <Modal …>}` —
 * so by the time anything could animate, the element is gone. Delaying the
 * unmount would mean changing every caller and every close path (Escape, the
 * backdrop, the X, each dialog's own Cancel). Instead `useModal`, which every
 * dialog already goes through, hands its node here on unmount: the overlay is
 * cloned, made inert and hidden from assistive technology, and faded out on its
 * own for 160ms before being removed. Focus has already gone back where it
 * came from, the real dialog is already gone from the accessibility tree, and a
 * click during the fade passes straight through to the page, so re-opening a
 * dialog mid-exit simply opens the new one above the fading copy.
 *
 * Skipped — so the dialog just disappears, as it always did — under reduced
 * motion, in a hidden tab, where the Web Animations API is missing (which is
 * how the test renderer opts out: jsdom has no `getAnimations`), and when the
 * node is still in the document (StrictMode's rehearsal unmount).
 */
export function playDialogExit(node) {
  if (!node || typeof document === 'undefined' || node.isConnected) return;
  if (typeof node.getAnimations !== 'function' || document.hidden || prefersReducedMotion()) return;
  const overlay = node.closest('.modal-overlay');
  if (!overlay) return;

  const ghost = overlay.cloneNode(true);
  ghost.classList.add('modal-exit');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  /* Ids must stay unique in the document; the copy needs none. */
  for (const el of [ghost, ...ghost.querySelectorAll('[id]')]) el.removeAttribute('id');

  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    ghost.remove();
  };
  ghost.addEventListener('animationend', (e) => { if (e.target === ghost) remove(); });
  setTimeout(remove, DIALOG_EXIT_FALLBACK_MS);
  document.body.appendChild(ghost);
}
