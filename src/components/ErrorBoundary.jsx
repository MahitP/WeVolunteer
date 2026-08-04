import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

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
 * There is no error-reporting service in this deployment, so the error is
 * written to the console — that is the only place a developer can retrieve it
 * from a user's browser.
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

    return (
      /* role="alert" so a section collapsing is announced. The three call sites
         already pass specific copy ("This event didn't load"), which is why the
         wording here is left alone — only the announcement was missing. */
      <div className="card" role="alert" style={{ maxWidth: 520, margin: 'var(--s6) auto', padding: 'var(--s6)' }}>
        <div className="stack-sm" style={{ alignItems: 'flex-start' }}>
          <span style={{ color: 'var(--danger)' }}><AlertTriangle size={28} /></span>
          <h2 style={{ fontSize: '1.25rem' }}>{this.props.title || 'Something went wrong'}</h2>
          <p className="lead">
            {this.props.message
              || 'This part of the page failed to load. Your data is safe — nothing was changed.'}
          </p>
          <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              <RotateCw size={15} /> Try again
            </button>
            {this.props.onDismiss && (
              <button className="btn btn-secondary" onClick={this.props.onDismiss}>
                {this.props.dismissLabel || 'Close'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
