/**
 * The error pages.
 *
 * Behaviour, not markup: what a person is told and what they can do next. The
 * wiring — that a denied route and an unknown path actually reach these — is
 * asserted in `App.routeTable.test.jsx`, against the real router, which is a
 * different claim and the one that fails silently if the wiring is forgotten.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ErrorPage from './ErrorPage';

const at = (props) => render(<MemoryRouter><ErrorPage {...props} /></MemoryRouter>);

describe('ErrorPage: each kind says what happened', () => {
  it('404 names the problem and does not blame the account', async () => {
    at({ kind: '404' });
    expect(screen.getByRole('heading', { name: /on the board/i })).toBeInTheDocument();
    expect(screen.getByText(/nothing is wrong with your account/i)).toBeInTheDocument();
  });

  it('403 says it is a permission problem and what to do about it', () => {
    at({ kind: '403' });
    expect(screen.getByRole('heading', { name: /yours to open/i })).toBeInTheDocument();
    // The whole point of replacing the bounce: say what to do next.
    expect(screen.getByText(/school administrator/i)).toBeInTheDocument();
  });

  it('500 reassures about data before anything else', () => {
    at({ kind: '500' });
    expect(screen.getByRole('heading', { name: /being rebuilt/i })).toBeInTheDocument();
    expect(screen.getByText(/your data is safe/i)).toBeInTheDocument();
  });

  /**
   * The board is a picture. It says nothing a screen-reader user needs that the
   * headline does not already say, so it is hidden rather than described — an
   * alt text like "eleven filled tiles and one empty one" is noise, not access.
   */
  it('announces itself, and hides the whole board from assistive technology', () => {
    const { container } = at({ kind: '404' });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    const art = container.querySelector('.errb-art');
    expect(art, 'the board did not render').toBeTruthy();
    expect(art.getAttribute('aria-hidden')).toBe('true');
    // Every tile is inside it, so nothing decorative escapes.
    expect(container.querySelectorAll('.errb-tile').length).toBe(12);
  });

  it('marks exactly one tile as the anomaly, and matches it to the kind', () => {
    for (const [kind, cls] of [['404', 'errb-tile-gap'], ['403', 'errb-tile-locked'], ['500', 'errb-tile-sync']]) {
      const { container, unmount } = at({ kind });
      expect(container.querySelectorAll(`.${cls}`).length, `${kind} anomaly`).toBe(1);
      unmount();
    }
  });

  it('carries the product name, because this is often the only thing on screen', () => {
    at({ kind: '500' });
    expect(screen.getByText('WeVolunteer')).toBeInTheDocument();
  });

  it('falls back to 404 for an unknown kind rather than rendering nothing', () => {
    at({ kind: 'teapot' });
    expect(screen.getByRole('heading', { name: /on the board/i })).toBeInTheDocument();
  });
});

describe('ErrorPage: the way out matches the session', () => {
  it('offers in-app links to someone signed in', () => {
    at({ kind: '404' });
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /browse open shifts/i })).toHaveAttribute('href', '/events');
  });

  /**
   * A signed-out visitor sent to `/events` is bounced straight back, which would
   * make the page look broken in the moment it is trying to help.
   */
  it('offers only the start page to someone signed out', () => {
    at({ kind: '404', signedIn: false });
    expect(screen.getByRole('link', { name: /start page/i })).toHaveAttribute('href', '/welcome');
    expect(screen.queryByRole('link', { name: /browse open shifts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /dashboard/i })).not.toBeInTheDocument();
  });

  it('offers a reload only on 500, where retrying is the useful action', () => {
    const a = at({ kind: '500' });
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    a.unmount();

    at({ kind: '403' });
    // Reloading a permission refusal just refuses again.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('does not offer "find an event" on a permission refusal', () => {
    at({ kind: '403' });
    expect(screen.queryByRole('link', { name: /browse open shifts/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
  });

  /**
   * No error id, deliberately: a code the reader cannot use is noise, and asking
   * a fourteen-year-old to quote a UUID is not a support process. The server
   * already has the fingerprint.
   */
  it('shows no error code or identifier', () => {
    const { container } = at({ kind: '500' });
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(container.textContent).not.toMatch(/error id|reference|code:/i);
  });
});

/**
 * The board is decoration, so these assert the things that survive it being
 * ignored: nothing internal leaks, and motion is opt-out.
 */
describe('ErrorPage: leaks nothing, and motion is optional', () => {
  it('shows no stack trace, path, or internal detail for any kind', () => {
    for (const kind of ['404', '403', '500']) {
      const { container, unmount } = at({ kind });
      const text = container.textContent;
      expect(text, `${kind} leaked a path`).not.toMatch(/\/(server|src|node_modules)\//);
      expect(text, `${kind} leaked a stack frame`).not.toMatch(/\bat .+:\d+:\d+/);
      expect(text, `${kind} leaked SQL`).not.toMatch(/SELECT |INSERT |sqlite/i);
      expect(text, `${kind} leaked a status code`).not.toMatch(/\b(500|403)\b/);
      unmount();
    }
  });

  it('carries no inline animation, so the reduced-motion rule can win', () => {
    const { container } = at({ kind: '500' });
    // Motion lives in index.css behind a prefers-reduced-motion query. An inline
    // animation would be unreachable by that query and could not be turned off.
    for (const el of container.querySelectorAll('[style]')) {
      expect(el.getAttribute('style')).not.toMatch(/animation/i);
    }
  });
});
