import React from 'react';
import { RotateCw } from 'lucide-react';

/**
 * The medium weight: a section failed, not the application.
 *
 * ── Why this exists ──
 *
 * Using the wrong weight is its own design failure. A fullscreen takeover
 * because one panel could not refresh is melodrama, and it throws away the rest
 * of a page the reader can still use. This is for a widget, a modal body or a
 * fetch that failed while everything around it kept working.
 *
 * It replaces `ErrorBoundary`'s previous fallback, which centred a lucide
 * `AlertTriangle` above the copy — a browser-style warning triangle and a
 * stock icon standing in for artwork, in the one component the entire app
 * falls back to.
 *
 * ── One appearance, not three ──
 *
 * This shipped with `fault`/`denied`/`quiet` tones and a caller that never
 * passed one, so two of the three could not be reached and the static guard had
 * to allowlist their class names to stay green — a guard working around code
 * rather than checking it. A prop with one possible value is not an API, it is
 * an unproven guess about a second call site. Re-adding it when that call site
 * actually exists is a smaller change than carrying it until then.
 *
 * ── The mark ──
 *
 * Three strips with one broken: the Ops Wall motif at 40px, so the medium
 * weight is visibly the same product as the fullscreen one without pretending
 * to be a scene. Small enough to sit beside a heading, drawn rather than
 * imported, and it says "one row of several stopped" — which is exactly what a
 * failed section is.
 */

function PanelMark() {
  return (
    <svg
      className="err-panel-mark"
      viewBox="0 0 44 44"
      role="presentation"
      aria-hidden="true"
    >
      <rect x="0" y="0" width="44" height="44" rx="11" fill="var(--brand-soft)" />
      <rect x="9" y="11" width="26" height="6" rx="3" fill="var(--brand-primary)" opacity="0.55" />
      <rect
        x="9" y="21" width="26" height="6" rx="3"
        fill="none" stroke="var(--danger)" strokeWidth="1.75" strokeDasharray="4 3.5"
      />
      <rect x="9" y="31" width="18" height="6" rx="3" fill="var(--brand-primary)" opacity="0.35" />
    </svg>
  );
}

/**
 * @param {object}   props
 * @param {string}   props.title
 * @param {string}   props.message
 * @param {Function} [props.onRetry]      omit to hide the retry
 * @param {string}   [props.retryLabel]
 * @param {Function} [props.onDismiss]
 * @param {string}   [props.dismissLabel]
 */
export default function ErrorPanel({
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
  onDismiss,
  dismissLabel = 'Close',
}) {
  return (
    /* role="alert" for the same reason the fullscreen frame carries one: a
       section collapsing is not something a screen-reader user should learn
       about only at the next natural pause. */
    <div className="err-panel" role="alert">
      <PanelMark />
      <div className="err-panel-copy">
        <h2 className="err-panel-title">{title}</h2>
        <p className="err-panel-body">{message}</p>
        {(onRetry || onDismiss) && (
          <div className="err-panel-actions">
            {onRetry && (
              <button className="btn btn-primary" onClick={onRetry}>
                <RotateCw size={15} /> {retryLabel}
              </button>
            )}
            {onDismiss && (
              <button className="btn btn-secondary" onClick={onDismiss}>{dismissLabel}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
