import { useEffect, useRef } from 'react';

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
    target?.focus?.();

    const onKeyDown = (e) => {
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
      document.body.style.overflow = previousOverflow;
      // Give focus back to whatever opened the dialog
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  return ref;
}
