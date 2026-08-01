import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

const TOAST_ICON = { success: CheckCircle2, error: AlertTriangle, info: Info };

/** The toast queue. Moved out of App.jsx unchanged. */
export default function Toasts({ toasts, onRemove }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(toast => {
        const Icon = TOAST_ICON[toast.type] || Info;
        return (
          <div key={toast.id} className={`toast ${toast.type}`}>
            <Icon size={16} />
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
