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
    expect(screen.getByRole('heading', { name: /could not find that page/i })).toBeInTheDocument();
    expect(screen.getByText(/nothing is wrong with your account/i)).toBeInTheDocument();
  });

  it('403 says it is a permission problem and what to do about it', () => {
    at({ kind: '403' });
    expect(screen.getByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
    // The whole point of replacing the bounce: say what to do next.
    expect(screen.getByText(/ask your school administrator/i)).toBeInTheDocument();
  });

  it('500 reassures about data before anything else', () => {
    at({ kind: '500' });
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.getByText(/your data is safe/i)).toBeInTheDocument();
  });

  /**
   * The icon assertion targets the icon's OWN wrapper.
   *
   * The first version asked whether ANY element carried aria-hidden, and lucide
   * marks its own `<svg>` that way — so removing the wrapper's attribute left
   * the assertion true and the mutation survived. What matters is that the
   * element wrapping the icon is hidden, so the icon is not announced twice.
   */
  it('announces itself to assistive technology and hides the decorative icon', () => {
    const { container } = at({ kind: '404' });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    const svg = container.querySelector('svg');
    expect(svg, 'no icon rendered at all').toBeTruthy();
    expect(
      svg.closest('[aria-hidden="true"]'),
      'the icon is not inside an aria-hidden wrapper, so it is announced alongside the heading'
    ).toBeTruthy();
    expect(svg.parentElement.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to 404 for an unknown kind rather than rendering nothing', () => {
    at({ kind: 'teapot' });
    expect(screen.getByRole('heading', { name: /could not find that page/i })).toBeInTheDocument();
  });
});

describe('ErrorPage: the way out matches the session', () => {
  it('offers in-app links to someone signed in', () => {
    at({ kind: '404' });
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /find an event/i })).toHaveAttribute('href', '/events');
  });

  /**
   * A signed-out visitor sent to `/events` is bounced straight back, which would
   * make the page look broken in the moment it is trying to help.
   */
  it('offers only the start page to someone signed out', () => {
    at({ kind: '404', signedIn: false });
    expect(screen.getByRole('link', { name: /start page/i })).toHaveAttribute('href', '/welcome');
    expect(screen.queryByRole('link', { name: /find an event/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /dashboard/i })).not.toBeInTheDocument();
  });

  it('offers a reload only on 500, where retrying is the useful action', () => {
    const a = at({ kind: '500' });
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    a.unmount();

    at({ kind: '403' });
    // Reloading a permission refusal just refuses again.
    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument();
  });

  it('does not offer "find an event" on a permission refusal', () => {
    at({ kind: '403' });
    expect(screen.queryByRole('link', { name: /find an event/i })).not.toBeInTheDocument();
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
