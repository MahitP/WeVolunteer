import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizerDashboard from './OrganizerDashboard';

/**
 * Deleting an event an organizer hosts.
 *
 * Gated on `window.confirm`, which `ConfirmDialog` was written to replace and
 * which the stabilization report tracks as roadmap P2-7. The deployment
 * runbook names the cost at L5: "no room to explain consequences ('this will
 * remove 12 sign-ups')."
 *
 * That sentence is the point here. The count was ALREADY computed for the
 * native string and crammed in behind a `\n\n`; what changed is that it is now
 * readable, and emphasised, in the place somebody decides.
 */

/**
 * A self-populating api mock.
 *
 * This dashboard calls a dozen endpoints on mount, and naming each one here
 * would make the fixture a list of whatever the component happened to fetch on
 * the day it was written — a list that goes stale silently and fails as
 * `api.X is not a function` rather than as anything about deletion. Any method
 * not named below resolves to `null`, which every one of those call sites
 * already handles, and `deleteEvent` is asserted on explicitly.
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

const EVENT = {
  id: 'event-1', title: 'Riverbank Litter Sweep', status: 'open',
  location: 'Reichler Park', category: 'Other', organizerId: 'user-org',
  startDatetime: '2026-10-01T14:00:00.000Z',
  endDatetime: '2026-10-01T16:00:00.000Z',
  applicationDeadline: '2026-09-25T00:00:00.000Z',
  slots: [{ id: 'slot-1', name: 'Shift', startDatetime: '2026-10-01T14:00:00.000Z',
    endDatetime: '2026-10-01T16:00:00.000Z', maxSpots: 4, spotsRemaining: 2 }],
};

const application = (id, userId) => ({
  id, eventId: 'event-1', userId, status: 'accepted',
  slot: { id: 'slot-1', name: 'Shift' },
  volunteer: { id: userId, name: `Vol ${userId}`, volunteeredHours: 0 },
});

const USER = { id: 'user-org', name: 'Jordan Whitfield', role: 'organizer', verified: true, withheld: [] };

beforeEach(() => {
  apiMock.deleteEvent.mockClear();
  apiMock.deleteEvent.mockResolvedValue({});
});

const show = (applications = []) => render(
  <MemoryRouter>
    <OrganizerDashboard
      currentUser={USER}
      events={[EVENT]}
      applications={applications}
      addToast={() => {}}
      refreshEvents={() => {}}
      setActiveTab={() => {}}
      onViewDetails={() => {}}
      onViewVolunteerProfile={() => {}}
    />
  </MemoryRouter>
);

const dialog = () => document.querySelector('[role="dialog"]');
const dialogButton = (name) => [...dialog().querySelectorAll('button')]
  .find(b => new RegExp(`^${name}$`, 'i').test((b.textContent || '').trim()));

describe('deleting a hosted event', () => {
  it('asks in the application rather than through the browser', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Delete event/i }));

    expect(apiMock.deleteEvent, 'deleted on the click alone').not.toHaveBeenCalled();
    expect(dialog(), 'no in-app dialog was opened').not.toBeNull();
  });

  it('says how many sign-ups go with it, which is the point of the dialog', async () => {
    show([application('app-1', 'u1'), application('app-2', 'u2')]);
    fireEvent.click(await screen.findByRole('button', { name: /Delete event/i }));

    expect(dialog().textContent).toMatch(/2 volunteer sign-ups/i);
  });

  it('does not invent a count when there are none', async () => {
    show([]);
    fireEvent.click(await screen.findByRole('button', { name: /Delete event/i }));

    expect(dialog().textContent).not.toMatch(/sign-up/i);
    expect(dialog().textContent).toMatch(/cannot be undone/i);
  });

  it('deletes once confirmed', async () => {
    show([application('app-1', 'u1')]);
    fireEvent.click(await screen.findByRole('button', { name: /Delete event/i }));
    fireEvent.click(dialogButton('Delete'));

    await waitFor(() => expect(apiMock.deleteEvent).toHaveBeenCalledWith('event-1'));
  });

  it('does nothing at all on cancel', async () => {
    show([application('app-1', 'u1')]);
    fireEvent.click(await screen.findByRole('button', { name: /Delete event/i }));
    fireEvent.click(dialogButton('Cancel'));

    await waitFor(() => expect(dialog()).toBeNull());
    expect(apiMock.deleteEvent).not.toHaveBeenCalled();
  });
});
