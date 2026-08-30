import React, { useId, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { RotateCw, ArrowLeft } from 'lucide-react';
import { APP_NAME } from '../../config';
import BrandMark from '../../components/common/BrandMark';
import { RETRYABLE, kindForError, weightFor } from './kinds';
import { copyFor } from './errorCopy';
import { denialDetail } from './denialDetail';
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
 * ── Weight ──
 *
 * One, from `WEIGHTS` in kinds.js: `immersive` owns the viewport. There were
 * three, then two, and now every kind is a takeover — see the note above
 * `WEIGHTS` for why the middle tiers went, and for the drift that removing the
 * last one fixed. The attribute is the only thing that changes; the frame, the
 * scene and the copy are identical whatever it says.
 *
 * `100dvh`, not `100vh`: on mobile Safari `100vh` is the tallest the viewport
 * ever gets, so with the URL bar showing the actions land below the fold on the
 * one screen whose whole job is to offer a way out. Everything this component
 * renders is a top-level takeover, so there is no in-shell case to special-case
 * — an earlier version of this note pointed at an `.app .err` rule that does
 * not exist.
 */

/**
 * @param {object}   props
 * @param {string}   props.kind      one of `KINDS`
 * @param {boolean}  props.signedIn  A signed-out visitor sent to `/discover` is
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
  denied,
  /**
   * True when this IS the page, rather than content inside one.
   *
   * App.jsx returns a refusal or a 404 BEFORE it builds the shell — deliberately,
   * so a takeover reads as a page rather than as a card in a navigation frame the
   * reader has just been told they cannot use. The consequence nobody looked at:
   * with no shell there is no `<main>`, so this content sat in NO landmark at all.
   * Measured on twelve routes, `#main-content` was absent and the error was a
   * direct child of `#root`.
   *
   * For a screen-reader user that removes landmark navigation — one of the main
   * ways of orienting on an unfamiliar page — on exactly the pages where somebody
   * has just been stopped and needs to work out what to do.
   *
   * Left off by default because two of the callers legitimately already have a
   * `<main>`: the catch-all 404 route renders inside the shell's, and
   * OfflineOverlay covers an app whose shell is still mounted. Nesting a second
   * `<main>` inside either would be worse than none.
   */
  standalone = false,
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
  /**
   * Guarded on `kind` as well as on `denied`, so a caller cannot attach a
   * permission explanation to a 500 or a crash. Those are written flat and
   * reassurance-first on purpose (see errorCopy.js's tone ladder), and a sentence
   * about capabilities underneath one would be answering a question nobody asked
   * at the moment they have possibly just lost work.
   */
  const detail = kind === '403' ? denialDetail(denied) : null;
  const { Scene } = theme;
  const canRetry = RETRYABLE.includes(kind);
  const weight = weightFor(kind);

  const experience = (
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
      /* How much room this failure is allowed. The whole layout — viewport
         fill, type scale, artwork size, spacing — hangs off this one attribute
         rather than off a class per kind, so adding a kind is a row in
         `WEIGHTS` and not a new block of CSS. */
      data-error-weight={weight}
    >
      <div className="err-copy">
        {/* Branding: this is a landing moment and often the only thing on
            screen, so it carries the same mark as the app shell and the
            certificate page — the SAME component, not a copy of the markup, so
            the day the mark changes it cannot change everywhere but here.
            Quiet — the scene is still what should be remembered. */}
        <p className="err-mark">
          <BrandMark />
          <span className="err-mark-text">{APP_NAME}</span>
        </p>

        <p className="err-eyebrow">{eyebrow}</p>
        <h1 className="err-title" id={titleId}>{title}</h1>
        <p className="err-body">{body}</p>

        {/* The facts a refusal has to carry, under the themed acknowledgement:
            which feature, why this account is refused, and who can change it.
            Only ever rendered for a 403 with a matched route — see
            denialDetail.js for why the path alone is not the reason. */}
        {detail && (
          <p className="err-detail">
            {detail.reason}
            {detail.remedy ? ` ${detail.remedy}` : ''}
          </p>
        )}

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
                <Link className="btn btn-secondary" to="/discover">Browse open shifts</Link>
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

  /* A plain block wrapper: `.err` keeps its own `min-height`, `max-width` and
     centring, so nothing moves. The only thing this adds is the landmark. */
  return standalone
    ? <main className="err-page">{experience}</main>
    : experience;
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
