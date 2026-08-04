import React, { useId, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { RotateCw, ArrowLeft } from 'lucide-react';
import { APP_NAME } from '../../config';
import { RETRYABLE, kindForError } from './kinds';
import { copyFor } from './errorCopy';
import { selectTheme, themeForSeed, modeFor } from './selector';
import { getTheme } from './themes/index.js';

/**
 * The fullscreen error experience.
 *
 * ── The frame owns behaviour; themes own pixels ──
 *
 * Everything that can be got WRONG lives here, exactly once: the announcement,
 * the heading wiring, the product mark, the session-dependent way out, and the
 * guarantee that nothing internal reaches the page. A theme is a pure
 * presentational component that receives a `mode` — a statement about the
 * picture, never a status code — renders artwork into an `aria-hidden` slot,
 * and can reach nothing else. No router, no session, no data.
 *
 * That boundary is the entire reason six themes do not mean six chances to
 * reintroduce the bug this feature was built to fix (a denied route silently
 * redirecting to the dashboard, so "denied" and "unknown path" were
 * indistinguishable). The behavioural suite renders every theme through these
 * same assertions.
 *
 * ── Layout ──
 *
 * An asymmetric two-column stage, not a centred card. Centred text is the
 * default of every error page ever made, and a centred card has no *place* —
 * it is a dialog box with better typography. The copy sits left on a narrow
 * measure and the scene bleeds right, which is what gives the screen a horizon.
 *
 * "Full screen" means full-bleed within its region, never `100vh`: the
 * authenticated catch-all renders inside the app shell, and a viewport-height
 * block there pushes the chrome off the screen.
 */

/**
 * @param {object}   props
 * @param {string}   props.kind      one of `KINDS`
 * @param {boolean}  props.signedIn  A signed-out visitor sent to `/events` is
 *   bounced straight back to `/welcome`, which would make this page look broken
 *   in the moment it is trying to help. They get the start page instead.
 * @param {string}   [props.theme]   Force a theme. Tests and the dev preview
 *   only — rotation never sets it, so forcing is the only way a theme is asked
 *   for a kind it is not eligible for. `copyFor`/`modeFor` both fall back.
 * @param {number}   [props.seed]    Force the rotation seed, for tests.
 * @param {Function} [props.onRetry] Replaces the page reload. `ErrorBoundary`
 *   passes its own reset, so recovering from a caught render error does not
 *   have to cost a full round trip.
 */
export default function ErrorExperience({
  kind = '404',
  signedIn = true,
  theme: forcedTheme,
  seed,
  onRetry,
}) {
  const titleId = useId();

  /**
   * Memoised, not held in state.
   *
   * `useState` with a lazy initialiser looks like the careful choice — pick
   * once, never reshuffle — and is the wrong one: it freezes the theme for the
   * life of the instance, so a `kind` this component is later handed repaints
   * nothing. That was visible in the dev gallery, where moving from
   * `radio/offline` to `ops/500` client-side kept the radio on screen and only
   * a hard reload agreed with the URL. The dangerous version of the same bug is
   * quieter: `copyFor` reads the LIVE kind while the scene comes from the dead
   * one, so a permission refusal gets narrated over a server-fault picture.
   *
   * Nothing is lost by dropping the state. `selectTheme` is deterministic given
   * a seed that is persisted on first read, so re-running it during a render
   * returns the same theme — the stability comes from the seed, which is where
   * it was always coming from.
   */
  const theme = useMemo(() => {
    if (forcedTheme) return getTheme(forcedTheme) ?? selectTheme(kind);
    if (Number.isInteger(seed)) return themeForSeed(kind, seed);
    return selectTheme(kind);
  }, [forcedTheme, seed, kind]);

  const { eyebrow, title, body } = copyFor(theme.id, kind);
  const { Scene } = theme;
  const canRetry = RETRYABLE.includes(kind);

  return (
    <section
      className={`err err-t-${theme.id}`}
      role="alert"
      aria-labelledby={titleId}
      /* Stable across rotation and absent from `textContent`, so routing tests
         can assert WHICH experience rendered without pinning a theme's
         headline — and without putting a status code in front of a reader who
         cannot use one. */
      data-error-kind={kind}
      data-error-theme={theme.id}
    >
      <div className="err-copy">
        {/* Branding: this is a landing moment and often the only thing on
            screen. Quiet — the scene is what should be remembered. */}
        <p className="err-mark">{APP_NAME}</p>

        <p className="err-eyebrow">{eyebrow}</p>
        <h1 className="err-title" id={titleId}>{title}</h1>
        <p className="err-body">{body}</p>

        <div className="err-actions">
          {canRetry && (
            <button
              className="btn btn-primary"
              onClick={onRetry ?? (() => window.location.reload())}
            >
              <RotateCw size={15} /> Try again
            </button>
          )}

          {kind === 'expired' ? (
            <Link className={`btn ${canRetry ? 'btn-secondary' : 'btn-primary'}`} to="/welcome">
              Sign in again
            </Link>
          ) : signedIn ? (
            <>
              <Link className={`btn ${canRetry ? 'btn-secondary' : 'btn-primary'}`} to="/">
                <ArrowLeft size={15} /> Back to my dashboard
              </Link>
              {kind === '404' && (
                <Link className="btn btn-secondary" to="/events">Browse open shifts</Link>
              )}
            </>
          ) : (
            <Link className={`btn ${canRetry ? 'btn-secondary' : 'btn-primary'}`} to="/welcome">
              Go to the start page
            </Link>
          )}
        </div>
      </div>

      {/* The scene says nothing a screen-reader user needs that the headline
          does not already say, so it is hidden rather than described. An alt
          text like "five pinned sheets and one empty outline" is noise, not
          access. */}
      <div className="err-stage" aria-hidden="true">
        <Scene mode={modeFor(theme, kind)} />
      </div>
    </section>
  );
}

/**
 * The fallback both fullscreen `ErrorBoundary`s use.
 *
 * Shared rather than written twice: the boundaries sit in different files
 * (`main.jsx` around the shell, `App.jsx` around `<main>`) and were carrying
 * identical eight-line closures. Two copies of a rule drift, and the one that
 * stops being updated is the one still catching errors.
 *
 * The rule: a caught render error clears with the boundary's own `reset`, so
 * recovering costs no round trip. A missing CHUNK is the opposite — the file is
 * genuinely not on the server any more, `reset` would re-throw immediately, and
 * only a reload picks up the release the tab has fallen behind. Passing no
 * `onRetry` is what selects the reload.
 */
export function crashFallback({ error, reset }) {
  const kind = kindForError(error);
  return <ErrorExperience kind={kind} onRetry={kind === 'chunk' ? undefined : reset} />;
}
