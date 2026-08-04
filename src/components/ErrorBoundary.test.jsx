/**
 * The boundary fallback, and the one thing about it that is invisible.
 *
 * A section collapsing into a card is obvious to anyone who can see it and
 * silent to anyone who cannot — the replacement happens without focus moving,
 * so nothing announces it. `role="alert"` is what makes the swap perceivable,
 * and it is the kind of attribute that gets dropped in a refactor without
 * anything going red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

const Boom = () => { throw new Error('component exploded'); };

// React logs the caught error; that is expected here and only adds noise.
const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => quiet.mockClear());

describe('ErrorBoundary fallback', () => {
  it('announces itself when a section collapses', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('reassures about data and offers the recovery action', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText(/your data is safe/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('uses the caller\'s own wording when it has some', () => {
    render(
      <ErrorBoundary title="This event didn't load" message="Nothing was changed.">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole('heading', { name: /this event didn't load/i })).toBeInTheDocument();
  });

  it('leaks no stack frame or internal path to the reader', () => {
    const { container } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(container.textContent).not.toMatch(/\bat .+:\d+:\d+/);
    expect(container.textContent).not.toMatch(/\/(src|server|node_modules)\//);
    expect(container.textContent).not.toContain('component exploded');
  });

  /**
   * Both fullscreen call sites read `error` out of the fallback's argument to
   * tell a stale tab (`chunk`) from a real crash. If this hand-off is ever
   * narrowed to `{ reset }`, `kindForError(undefined)` answers `crash` for
   * everything and every user of a tab left open across a release is told to
   * do the one thing that will not help them — with nothing going red.
   */
  it('hands the caught error to a custom fallback, not just the reset', () => {
    const seen = [];
    render(
      <ErrorBoundary fallback={(arg) => { seen.push(arg); return <p>caught</p>; }}>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText('caught')).toBeInTheDocument();
    expect(seen[0].error, 'the fallback was given no error to classify').toBeInstanceOf(Error);
    expect(seen[0].error.message).toBe('component exploded');
    expect(typeof seen[0].reset).toBe('function');
  });

  it('renders its children when nothing is wrong', () => {
    render(<ErrorBoundary><p>all good</p></ErrorBoundary>);
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
