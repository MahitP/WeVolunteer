import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminDashboard from './AdminDashboard';

/**
 * The two destructive administrative actions, and what stands between them and
 * the reader.
 *
 * ── Why these two ──
 *
 * Denying an organizer removes their account. Removing an event deletes every
 * sign-up under it. Both were gated on `window.confirm`, which
 * `components/common/ConfirmDialog.jsx` was written to replace and which the
 * stabilization report tracked as roadmap P2-7: "`window.confirm` remains in 7
 * non-auth places; `ConfirmDialog` exists to replace them." The deployment
 * runbook records the concrete cost at L5 — "Unstyled, poor on mobile, and with
 * no room to explain consequences ('this will remove 12 sign-ups')."
 *
 * ── What these cases actually pin ──
 *
 * Not that a dialog exists. That the action does not happen until somebody says
 * yes IN THE APPLICATION, and that it does happen when they do. A
 * `window.confirm` that a browser has suppressed returns `false` silently, and
 * jsdom does not implement it at all — so a test written against the old
 * mechanism could only ever assert the mock it installed.
 */

const apiMock = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  fetchEvents: vi.fn(),
  fetchAdminStats: vi.fn(),
  deleteEvent: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const PENDING_ORG = {
  id: 'org-pending-1', name: 'Riverbank Trust', email: 'trust@example.invalid',
  createdAt: '2026-09-01T10:00:00.000Z',
};

const EVENT = {
  id: 'event-1', title: 'Riverbank Litter Sweep', status: 'open',
  location: 'Reichler Park', category: 'Other',
  startDatetime: '2026-10-01T14:00:00.000Z',
  endDatetime: '2026-10-01T16:00:00.000Z',
  organizerName: 'Jordan Whitfield', slots: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchEvents.mockResolvedValue([EVENT]);
  apiMock.fetchAdminStats.mockResolvedValue(null);
  apiMock.deleteEvent.mockResolvedValue({});
  apiMock.apiFetch.mockImplementation((path) => {
    if (path.includes('/organizers/pending')) return Promise.resolve([PENDING_ORG]);
    if (path.includes('/reports')) return Promise.resolve([]);
    return Promise.resolve({});
  });
});

const renderDash = () => render(
  <MemoryRouter initialEntries={['/']}>
    <AdminDashboard addToast={() => {}} user={{ id: 'user-admin', role: 'admin' }} />
  </MemoryRouter>
);

/**
 * The confirm control inside the dialog, not the row control that opened it.
 *
 * The row's Remove is an icon button named by its `title`
 * ("Remove this event"); the dialog's is a labelled button. Scoping to the
 * dialog is what keeps the two apart.
 */
const dialogButton = (name) => {
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog, 'no in-app dialog was opened').not.toBeNull();
  return [...dialog.querySelectorAll('button')]
    .find(b => new RegExp(name, 'i').test(b.textContent || ''));
};

describe('denying an organizer', () => {
  it('asks in the application before removing the account', async () => {
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: /^Deny$/i }));

    /* The request must not have gone out on the click alone. */
    expect(apiMock.apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/deny'), expect.anything(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('names the account and the consequence, which a native dialog could not style', async () => {
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: /^Deny$/i }));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toMatch(/Riverbank Trust/);
    expect(dialog.textContent).toMatch(/removed/i);
  });

  it('denies once confirmed', async () => {
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: /^Deny$/i }));
    fireEvent.click(dialogButton('Deny'));

    await waitFor(() => expect(apiMock.apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/deny'), expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('does nothing at all on cancel', async () => {
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: /^Deny$/i }));
    fireEvent.click(dialogButton('Cancel'));

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(apiMock.apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/deny'), expect.anything(),
    );
  });
});

describe('removing an event', () => {
  it('asks in the application before deleting the sign-ups', async () => {
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: /Remove this event/i }));

    expect(apiMock.deleteEvent).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('names the event and what goes with it', async () => {
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: /Remove this event/i }));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toMatch(/Riverbank Litter Sweep/);
    expect(dialog.textContent).toMatch(/sign-ups/i);
  });

  it('removes once confirmed', async () => {
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: /Remove this event/i }));
    fireEvent.click(dialogButton('Remove'));

    await waitFor(() => expect(apiMock.deleteEvent).toHaveBeenCalledWith('event-1'));
  });

  it('does nothing at all on cancel', async () => {
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: /Remove this event/i }));
    fireEvent.click(dialogButton('Cancel'));

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(apiMock.deleteEvent).not.toHaveBeenCalled();
  });
});
