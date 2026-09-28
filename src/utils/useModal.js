import { useEffect, useRef } from 'react';
import { playDialogExit } from './motion';

/**
 * The dialogs currently open, outermost first.
 *
 * Escape has to dismiss the TOP dialog and only that one. Every modal listens on
 * `document`, and `stopPropagation` does not stop other listeners bound to the
 * same node — that needs `stopImmediatePropagation`, which would hand the event
 * to whichever modal registered FIRST, i.e. the one underneath. Observed once a
 * dialog could open on top of another: one Escape closed the schedule-conflict
 * warning AND the event modal behind it.
 *
 * A stack is the smallest thing that expresses "topmost wins" without depending
 * on listener registration order.
 */
const modalStack = [];

/**
 * Test seam: the stack is module state and suites must not inherit each other's.
 *
 * ── Why this exists ──
 *
 * A token is pushed in a passive effect and popped in its cleanup. If a tree is
 * torn down in a way that skips the cleanup — an unmount while the effect is
 * still queued, or an exception thrown from an earlier cleanup in the same
 * pass — the token stays on top FOREVER. From then on `isTopmost()` is false
 * for every dialog that follows, and Escape becomes a silent no-op: the dialog
 * is open, the key is pressed, nothing happens, no error is raised.
 *
 * That is exactly what made `TwoFactorSetup.test.jsx` fail about one full-suite
 * run in two and never in isolation. `geocodeRoutes.js` already gives its
 * module state a `__resetUpstreamThrottle` seam for the same reason; this had
 * equivalent state and none.
 */
export function __resetModalStack() {
  modalStack.length = 0;
}

/** How many dialogs believe they are open. Lets a test name the leak. */
export function __modalStackDepth() {
  return modalStack.length;
}

/**
 * Standard dialog behaviour, applied identically by every modal in the app.
 *
 * Without this each modal was mouse-only: no Escape, no focus containment, and
 * focus was silently dropped to <body> on close, which strands keyboard and
 * screen-reader users at the top of the page.
 *
 * Handles:
 *   • Escape closes
 *   • focus moves into the dialog on open and returns to the trigger on close
 *   • Tab and Shift+Tab cycle within the dialog
 *   • background page cannot scroll behind the overlay
 *
 * @param {() => void} onClose - called when the user dismisses the dialog
 * @param {object} [options]
 * @param {boolean} [options.dismissible=true] - false for a dialog that has no
 *   "close": see the Escape note inside.
 * @param {string} [options.initialFocus] - CSS selector, queried inside the
 *   dialog, for where focus should land instead of the first control.
 * @returns {React.RefObject<HTMLElement>} ref to spread onto the dialog element
 */
export function useModal(onClose, { dismissible = true, initialFocus = null } = {}) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /* Through a ref for the same reason `onClose` is: the effect below runs once
     with `[]` deps, so a value read straight from the closure would be the one
     this dialog mounted with. That is true of `dismissible` in every current
     caller, and a latent bug the first time it is not. */
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const node = ref.current;

    // Identity for this dialog's place in the stack.
    const token = {};
    modalStack.push(token);
    const isTopmost = () => modalStack[modalStack.length - 1] === token;

    const focusable = () => {
      if (!node) return [];
      return [...node.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
        ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter(el => el.offsetParent !== null);
    };

    /**
     * Prefer the first real control over the close button, so keyboard users
     * land on the content rather than on "dismiss".
     *
     * ── Unless the dialog names its own landing place ──
     *
     * "First control" is the right default and the wrong answer for a dialog
     * whose first control is consequential. The legal re-acceptance dialog's
     * footer reads Sign out · Read the document · Accept and continue, in that
     * visual order, so the default armed SIGN OUT: a keyboard user who pressed
     * Space on arrival — which is what people do — would be signed out by a
     * dialog that had just told them they needed to read something.
     *
     * Focusing "Accept" instead is worse, because it arms agreeing to a
     * document nobody has read yet. The APG's own guidance covers this case
     * both ways: focus a static element at the start of the content
     * (`tabindex="-1"`) so a screen reader begins at the beginning, and prefer
     * the least destructive option for an irreversible action. A heading arms
     * nothing at all.
     *
     * A selector rather than a ref, because `Modal` portals its children and
     * the caller does not own the node this hook is attached to.
     */
    const named = initialFocus ? node?.querySelector(initialFocus) : null;
    const items = focusable();
    const target = named
      || items.find(el => !el.classList.contains('modal-close'))
      || items[0]
      || node;

    /**
     * Falling back to the dialog itself has to actually work.
     *
     * When the filter finds no candidate, `target` is the dialog `<div>` — and
     * calling `.focus()` on a div with no `tabindex` does nothing except blur
     * whatever had focus, dropping it to `<body>`. That is precisely the
     * failure this hook's own docblock says it exists to prevent: a keyboard or
     * screen-reader user stranded at the top of the page, now with a modal open
     * in front of them.
     *
     * `tabIndex = -1` makes the container programmatically focusable without
     * putting it in the tab order, which is the standard way to give a dialog a
     * focus target of last resort.
     *
     * It is not only a jsdom concern, though jsdom is where it is reliably
     * reproducible: `offsetParent` is null for anything inside a
     * `position: fixed` ancestor in some engines, and for a dialog that
     * genuinely contains no controls, the fallback is the only path.
     */
    if (target === node && node && !node.hasAttribute('tabindex')) {
      node.setAttribute('tabindex', '-1');
    }
    target?.focus?.();

    const onKeyDown = (e) => {
      // A dialog with something open on top of it is inert: neither Escape nor
      // the Tab cycle belongs to it while it is covered.
      if (!isTopmost()) return;

      /**
       * Escape closes — unless there is nothing to close to.
       *
       * ── Why a dialog would ever refuse it ──
       *
       * The APG lists Escape as a required function of the modal dialog
       * pattern, and it is right for every dialog in this application but one:
       * the legal re-acceptance dialog, which exists because the account cannot
       * continue using the product until it has answered. "Close" is not one of
       * the answers. Wiring Escape to a close that immediately reopens would be
       * worse than not wiring it — a key that appears to work and does not is
       * how somebody concludes the page is broken.
       *
       * ── Why that is not a keyboard trap ──
       *
       * WCAG 2.1.2 asks that focus can be moved away using standard navigation,
       * OR that the reader is advised of a method for doing so. Both ways out of
       * that dialog — accepting, and signing out — are ordinary buttons in the
       * tab cycle, named in the dialog's own text. The dialog is not a state
       * somebody is stuck in; it is a question with two answers.
       *
       * Tab containment, focus placement, focus restore and the scroll lock all
       * still apply. Only the dismissal is withheld, and only where dismissal
       * is not a thing the dialog offers.
       */
      if (e.key === 'Escape') {
        if (!dismissibleRef.current) return;
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;

      const list = focusable();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = modalStack.indexOf(token);
      if (at !== -1) modalStack.splice(at, 1);

      /**
       * Only the last dialog to close restores page scrolling.
       *
       * Each modal saves `document.body.style.overflow` on mount. A stacked
       * dialog therefore saves 'hidden' — the value the dialog underneath had
       * already set — and on unmount would write 'hidden' straight back, leaving
       * the page unscrollable for as long as the outer modal stayed open. Only
       * the outermost dialog holds the value worth restoring.
       */
      if (modalStack.length === 0) document.body.style.overflow = previousOverflow;

      // Give focus back to whatever opened the dialog
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();

      /* The exit fade, played on an inert copy once the dialog is gone — see
         `playDialogExit`. After the focus restore, so it cannot affect it. */
      playDialogExit(node);
    };
  }, []);

  return ref;
}
