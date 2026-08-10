/**
 * Settings → Help & Support: the legal entries.
 *
 * ── What this file is responsible for ──
 *
 * The Legal Center is reachable from exactly two places in the product: the
 * signup consent block, which is behind an account the reader has not made yet,
 * and this row. So "the durable route to the documents you agreed to" is a claim
 * about this list, and it is worth pinning.
 *
 * The owner entry is the other half. Hiding it here is UX — `legal.edit` is in
 * SUPER_ONLY and the server refuses everyone else regardless of what this list
 * renders, which `server/routes.legalEditor.test.js` proves. What this asserts
 * is the far cheaper property that an ordinary user is never SHOWN a control
 * that would refuse them.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Settings from './Settings';

/* jsdom implements no `matchMedia`, and `useTheme` calls it on mount to resolve
   the 'system' theme. Stubbed rather than mocking the hook, so the component
   under test is the real one. */
beforeAll(() => {
  window.matchMedia = window.matchMedia || (query => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
});

vi.mock('../utils/api', () => ({
  api: {
    signOutOtherDevices: vi.fn(),
    updatePrivacySettings: vi.fn(),
    updateProfile: vi.fn(),
  },
}));

const USER = (over = {}) => ({
  id: 'user-1',
  name: 'Sam Rivera',
  email: 'sam@example.com',
  role: 'student',
  verified: true,
  profileVisibility: 'private',
  ...over,
});

const renderHelp = (user = USER()) => render(
  <MemoryRouter initialEntries={['/settings?section=help']}>
    <Settings currentUser={user} addToast={vi.fn()} onProfileChange={vi.fn()} />
  </MemoryRouter>
);

describe('Settings → Help & Support', () => {
  /**
   * The rename.
   *
   * This row read "Terms, privacy and safety policies" — a list of contents
   * standing in for a place. The page it opens is a hub of ten documents with
   * its own search and grouping; naming it after three of them made the other
   * seven invisible from the only durable route to them.
   */
  it('names the destination "Legal Center"', () => {
    renderHelp();
    const link = screen.getByRole('link', { name: /Legal Center/ });
    expect(link).toHaveAttribute('href', '/legal');
  });

  it('describes what the Legal Center holds, so the examples are not lost', () => {
    renderHelp();
    expect(screen.getByText(/View our Terms, Privacy Policy, and other legal documents\./))
      .toBeInTheDocument();
  });

  it('offers About Us beside it', () => {
    renderHelp();
    expect(screen.getByRole('link', { name: /About Us/ })).toHaveAttribute('href', '/about');
  });

  /**
   * Client-side navigations, not full page loads.
   *
   * `<Link>` renders a relative href; an `<a href>` full-reload would too, so the
   * assertion that separates them is the absence of a target and the presence of
   * the router's own click handling. Checking the rendered href is what a
   * MemoryRouter can see, and a plain anchor to `/legal` would look identical —
   * so this asserts the thing that actually differs to a reader: no new tab.
   */
  it('keeps internal destinations inside the app', () => {
    renderHelp();
    expect(screen.getByRole('link', { name: /Legal Center/ })).not.toHaveAttribute('target');
    expect(screen.getByRole('link', { name: /About Us/ })).not.toHaveAttribute('target');
  });

  describe('the owner-only editor entry', () => {
    it('is hidden from a student', () => {
      renderHelp(USER({ role: 'student' }));
      expect(screen.queryByRole('link', { name: /Edit Legal Center/ })).not.toBeInTheDocument();
    });

    /**
     * The case a role-shaped intuition gets wrong. `legal.edit` is SUPER_ONLY,
     * so an administrator does not hold it and cannot be granted it.
     */
    it('is hidden from an administrator', () => {
      renderHelp(USER({ role: 'admin' }));
      expect(screen.queryByRole('link', { name: /Edit Legal Center/ })).not.toBeInTheDocument();
    });

    it('is shown to the owner, directly beneath the Legal Center', () => {
      renderHelp(USER({ role: 'super_admin' }));
      const editor = screen.getByRole('link', { name: /Edit Legal Center/ });
      expect(editor).toHaveAttribute('href', '/admin/legal');
      expect(screen.getByText(/Owner access/)).toBeInTheDocument();
    });

    it('places it immediately after the Legal Center in reading order', () => {
      const { container } = renderHelp(USER({ role: 'super_admin' }));
      const labels = [...container.querySelectorAll('.settings-help-label')].map(n => n.textContent);
      expect(labels.indexOf('Edit Legal Center')).toBe(labels.indexOf('Legal Center') + 1);
    });
  });
});
