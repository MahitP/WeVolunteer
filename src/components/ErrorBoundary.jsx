import React from 'react';
import ErrorPanel from '../views/ErrorExperience/ErrorPanel';
import { reportClientError } from '../utils/errorReporting';
import { kindForError } from '../views/ErrorExperience/kinds';

/**
 * Catches a render error and shows a recoverable panel instead of a blank page.
 *
 * React unmounts the entire tree when a render throws. With no boundary
 * anywhere, any error in any component produced a white screen with no message
 * and no route back — and nothing on screen told the user that reloading would
 * fix it. The organizer's day-of tools run on a phone, at an event, with no
 * engineer available; a blank screen there is a lost event, not a bug report.
 *
 * Two levels are used (see App.jsx):
 *   · one around the shell, so a failure anywhere still leaves a usable page
 *   · one around EventModal, so a failure inside 1,500 lines of modal does not
 *     take the navigation down with it — closing the modal is enough to recover
 *
 * `resetKey` lets the parent clear a caught error when the user navigates
 * somewhere else: without it, a boundary that has caught once keeps showing the
 * fallback forever, even after the thing that failed is gone from the screen.
 *
 * Every caught error is also reported to `/api/errors/report`, which is the
 * only way a maintainer sees a failure that happened on somebody else's phone.
 * The console line is kept as well: it is what a developer reads while the tab
 * is still open.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Render error caught by boundary:', error, info?.componentStack);

    /* The console line above is only retrievable by asking the user to open dev
       tools, which is not a support process for a fourteen-year-old at an event.
       This is the same failure, sent somewhere a maintainer can actually see it.
       `reportClientError` decides whether to send — it caps, dedupes, refuses
       network errors, and never throws, so nothing here can turn a caught error
       into an uncaught one. See errorReporting.js. */
    reportClientError(error, {
      kind: kindForError(error),
      route: globalThis.location?.pathname,
    });
  }

  componentDidUpdate(prevProps) {
    // A new resetKey means the user moved on; stop showing a stale failure.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback({ error, reset: () => this.setState({ error: null }) });
    }

    /**
     * The medium weight. A section collapsed, not the application — so this is
     * a panel, and a caller who wants the fullscreen experience passes it as
     * `fallback` (App.jsx does, for the routed views).
     *
     * This used to centre a lucide `AlertTriangle` above the copy. A warning
     * triangle is browser-chrome iconography and a stock glyph standing in for
     * artwork, which is the one thing the error system is not allowed to do —
     * in the component the whole app falls back to, of all places.
     *
     * The wording is still the caller's: all three call sites pass copy
     * specific to what failed ("This event didn't load"), which is far more use
     * than anything generic written here.
     */
    return (
      <ErrorPanel
        title={this.props.title || 'This section stopped responding'}
        message={
          this.props.message
          || 'This part of the page failed to load. Your data is safe — nothing was changed.'
        }
        onRetry={() => window.location.reload()}
        onDismiss={this.props.onDismiss}
        dismissLabel={this.props.dismissLabel}
      />
    );
  }
}
