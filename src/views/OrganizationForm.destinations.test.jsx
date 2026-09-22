import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import OrganizationForm from './OrganizationForm';

/**
 * Where the organization form sends somebody when they leave it.
 *
 * ── The defect ──
 *
 * Both exits went to `/directory`, which is a redirect to
 * `/discover?find=people`. So archiving a club, and pressing Cancel on
 * "create organization", both landed the reader in a search for PEOPLE — a
 * different kind of thing from what they had just been doing, and not where
 * either of them came from.
 *
 * `/organizations` is the page that lists "You manage" and "You belong to", it
 * is where `OrganizationsHome` links to the create form from, and every role
 * that can create an organization also holds `organization.join` (checked:
 * organizer and admin hold both), so it cannot refuse them.
 *
 * Cancel while EDITING was already right — it returns to the club — and stays
 * untouched.
 */

const apiMock = vi.hoisted(() => {
  const made = new Map();
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!made.has(prop)) made.set(prop, vi.fn().mockResolvedValue(null));
      return made.get(prop);
    },
  });
});
vi.mock('../utils/api', () => ({ api: apiMock }));

function Probe() {
  const loc = useLocation();
  return <div data-testid="where" data-path={loc.pathname} data-search={loc.search} />;
}

const USER = { id: 'user-org', name: 'Jordan Whitfield', role: 'organizer', verified: true, withheld: [] };

const show = (entry) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/organizations/new" element={
        <><OrganizationForm currentUser={USER} addToast={vi.fn()} /><Probe /></>
      } />
      <Route path="/organizations/:key/edit" element={
        <><OrganizationForm currentUser={USER} addToast={vi.fn()} /><Probe /></>
      } />
      <Route path="*" element={<Probe />} />
    </Routes>
  </MemoryRouter>
);

const where = () => screen.getByTestId('where').dataset;

beforeEach(() => {
  apiMock.fetchOrganization.mockClear();
  apiMock.updateOrganization.mockClear();
  apiMock.updateOrganization.mockResolvedValue({});
  apiMock.fetchOrganization.mockResolvedValue({
    organization: {
      id: 'org-1', slug: 'chess-club', name: 'Chess Club', description: 'Play chess.',
      tags: [], joinPolicy: 'open', status: 'active', avatar: '♟️',
    },
    viewer: { canManage: true, isMember: true, memberRole: 'manager' },
    members: [], events: [], totals: null,
  });
});

describe('leaving the create form', () => {
  it('goes back to the organizations page, not a people search', async () => {
    show('/organizations/new');
    const cancel = await screen.findByRole('link', { name: /^Cancel$/i });

    expect(cancel, 'Cancel still points at the people search')
      .toHaveAttribute('href', '/organizations');
  });
});

describe('archiving a club', () => {
  it('lands on the organizations page, not a people search', async () => {
    show('/organizations/chess-club/edit');
    await screen.findByRole('link', { name: /^Cancel$/i });

    fireEvent.click(screen.getByRole('button', { name: /Archive/i }));
    /* The archive is behind its own confirmation. */
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const go = [...dialog.querySelectorAll('button')]
        .find(b => /archive/i.test(b.textContent || ''));
      fireEvent.click(go);
    }

    await waitFor(() => expect(apiMock.updateOrganization).toHaveBeenCalled());
    await waitFor(() => {
      expect(where().path).toBe('/organizations');
      expect(where().search).toBe('');
    });
  });

  it('still returns an editor to the club when they only cancel', async () => {
    /* The half that was already right, kept so the fix cannot flatten both
       exits into one. */
    show('/organizations/chess-club/edit');
    const cancel = await screen.findByRole('link', { name: /^Cancel$/i });

    expect(cancel.getAttribute('href')).toMatch(/^\/organizations\/@chess-club$/);
  });
});
