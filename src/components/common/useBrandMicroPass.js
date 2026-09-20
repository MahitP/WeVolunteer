import { useCallback, useEffect, useRef } from 'react';

/** The micro-pass's own duration, from `wvMotion.css`'s `--wv-micro`. */
const MICRO_MS = 560;

/**
 * Fires the brand micro-pass once, on hover or keyboard focus.
 *
 * ── Why this exists, rather than just putting `.wv-micro` on the link ──
 *
 * The stylesheet offers three triggers: `:hover`, `:focus-visible` and
 * `[data-wv-fire]`. The first two are *states*, and the pass is a 560ms
 * one-shot, so a pointer that rests on the link — or a keyboard focus that
 * stays put, which is the normal case — outlives its own animation. When the
 * animation ends the comet keeps `opacity: 1` and its dash offset returns to 0,
 * which paints a static 52-unit gap in the surface colour across the first arm
 * of the W: a bite out of the mark for as long as the reader hovers or stays
 * focused. Observed in the running application, and present in the reference
 * lab's own demo.
 *
 * That contradicts the system's own rule — the mark is always full strength,
 * and every behaviour rests as the complete mark — so it is an implementation
 * defect rather than a design question. The fix costs nothing frozen: no
 * keyframe, curve, duration, dash value or colour changes. The element simply
 * carries `.wv-micro` (and the `[data-wv-fire]` hook the stylesheet already
 * defines) *for the length of one pass*, and stops carrying it afterwards, so
 * the resting state is the complete mark again.
 *
 * Returns a ref for the interactive element and the two handlers to spread on
 * it. The element itself stays a plain link or button; nothing here animates
 * anything or touches layout.
 */
export default function useBrandMicroPass() {
  const ref = useRef(null);
  const timer = useRef(null);

  const clear = useCallback(() => {
    const el = ref.current;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (el) { el.classList.remove('wv-micro'); el.removeAttribute('data-wv-fire'); }
  }, []);

  /* Cancel on unmount: a route change mid-pass must not leave a timer holding a
     reference to a detached node. */
  useEffect(() => clear, [clear]);

  const fire = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    /* Both motion preferences, the same two the stylesheet honours. Under either
       one the pass is `animation: none`, so firing would only add a class that
       does nothing — but leaving it unset keeps the DOM honest. */
    const reduced = document.documentElement.getAttribute('data-motion') === 'reduce'
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    /* Already running: let the pass finish rather than restarting it. */
    if (el.hasAttribute('data-wv-fire')) return;

    el.classList.add('wv-micro');
    el.setAttribute('data-wv-fire', '');
    timer.current = setTimeout(clear, MICRO_MS);
  }, [clear]);

  /**
   * Focus fires the pass only when the focus ring would show — the same
   * condition the stylesheet's own `:focus-visible` trigger uses. A click that
   * focuses the link has already had its pointer pass.
   */
  const onFocus = useCallback((event) => {
    if (event.target.matches?.(':focus-visible')) fire();
  }, [fire]);

  return { ref, onPointerEnter: fire, onFocus, onBlur: clear };
}
