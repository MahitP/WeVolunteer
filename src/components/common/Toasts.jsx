import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { prefersReducedMotion } from '../../utils/motion';

const TOAST_ICON = { success: CheckCircle2, error: AlertTriangle, info: Info };

/** How long a confirmation stays up, unread. */
export const TOAST_LIFETIME_MS = 5000;

/**
 * The least time a toast is given after the reader lets go of it. Moving the
 * pointer off a message that was one frame from closing should not close it
 * under the pointer as it leaves.
 */
export const TOAST_RESUME_MIN_MS = 1200;

/** The exit fade, `.toast-leaving` in index.css. */
const TOAST_EXIT_MS = 150;

/**
 * The toast queue. The queue itself (add, remove) lives in App.jsx; each toast
 * owns its own clock.
 */
export default function Toasts({ toasts, onRemove }) {
  return (
    /**
     * The container is polite; a FAILURE is not.
     *
     * Every toast previously announced through this one polite region, so a
     * screen-reader user was told an action had failed only once the reader
     * reached a natural pause — after they had likely moved on believing it
     * worked. Success and info are genuinely polite: they confirm something the
     * person just did. An error is the one that has to interrupt, so each toast
     * carries its own role and urgency rather than inheriting the container's.
     */
    <div className="toasts">
      {toasts.map(toast => <Toast key={toast.id} toast={toast} onRemove={onRemove} />)}
    </div>
  );
}

/**
 * One toast, and its clock.
 *
 * ── It waits while it is being read ──
 *
 * A message on a timer is easy to lose halfway through, so the countdown
 * pauses while the pointer is over the toast or focus is inside it (the
 * dismiss button), and resumes with whatever time was left — at least
 * `TOAST_RESUME_MIN_MS`.
 *
 * ── A failure does not dismiss itself ──
 *
 * It is announced assertively because the reader has to know; taking it away
 * after five seconds undoes that for anybody who looked away. It stays until
 * dismissed.
 *
 * ── It fades out ──
 *
 * 150ms of opacity, then removed. Under reduced motion, or without an
 * animation to wait for, it is removed at once.
 */
function Toast({ toast, onRemove }) {
  const Icon = TOAST_ICON[toast.type] || Info;
  const isFailure = toast.type === 'error';
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(TOAST_LIFETIME_MS);
  const startedRef = useRef(0);
  const nodeRef = useRef(null);

  const leave = () => {
    if (leaving) return;
    if (prefersReducedMotion() || typeof nodeRef.current?.getAnimations !== 'function') {
      onRemove(toast.id);
      return;
    }
    setLeaving(true);
  };

  /* The countdown: runs while not paused, not leaving, and not a failure. */
  useEffect(() => {
    if (isFailure || paused || leaving) return undefined;
    startedRef.current = Date.now();
    const timer = setTimeout(leave, remainingRef.current);
    return () => {
      clearTimeout(timer);
      const elapsed = Date.now() - startedRef.current;
      remainingRef.current = Math.max(remainingRef.current - elapsed, TOAST_RESUME_MIN_MS);
    };
    // `leave` is recreated each render; the timer only needs the latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFailure, paused, leaving]);

  /* Removal after the exit fade, with a fallback in case no `animationend`
     arrives (a hidden tab does not run animations). */
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = setTimeout(() => onRemove(toast.id), TOAST_EXIT_MS + 100);
    return () => clearTimeout(timer);
  }, [leaving, onRemove, toast.id]);

  return (
    <div
      ref={nodeRef}
      className={`toast ${toast.type}${leaving ? ' toast-leaving' : ''}`}
      role={isFailure ? 'alert' : 'status'}
      aria-live={isFailure ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false); }}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onRemove(toast.id); }}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="toast-msg">{toast.message}</span>
      <button onClick={leave} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
