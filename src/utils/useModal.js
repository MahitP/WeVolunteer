import { useEffect, useRef } from 'react';

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
 * @returns {React.RefObject<HTMLElement>} ref to spread onto the dialog element
 */
export function useModal(onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

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

    // Prefer the first real control over the close button, so keyboard users
    // land on the content rather than on "dismiss".
    const items = focusable();
    const target = items.find(el => !el.classList.contains('modal-close')) || items[0] || node;

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

      if (e.key === 'Escape') {
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
    };
  }, []);

  return ref;
}
