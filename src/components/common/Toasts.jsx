import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

const TOAST_ICON = { success: CheckCircle2, error: AlertTriangle, info: Info };

/** The toast queue. Moved out of App.jsx unchanged. */
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
      {toasts.map(toast => {
        const Icon = TOAST_ICON[toast.type] || Info;
        const isFailure = toast.type === 'error';
        return (
          <div
            key={toast.id}
            className={`toast ${toast.type}`}
            role={isFailure ? 'alert' : 'status'}
            aria-live={isFailure ? 'assertive' : 'polite'}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="toast-msg">{toast.message}</span>
            <button onClick={() => onRemove(toast.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
