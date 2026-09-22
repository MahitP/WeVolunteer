import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { api } from './utils/api';

/**
 * `?event=<id>` on a COLD LOAD — where every notification email lands.
 *
 * ── The defect ──
 *
 * `notificationWorker` turns any `event:` link into `${APP_URL}/?event=<id>`,
 * and 23 notification kinds emit one. That URL is opened from an inbox, so
 * nothing has been browsed yet: `seenEvents` is empty, and the SessionProvider
 * index holds only what `{mine: 'true'}` returned — "events this user is
 * involved in".
 *
 * For the two kinds whose whole purpose is to point somewhere the reader is
 * NOT involved — `FRIEND_SIGNED_UP` and `ORGANIZATION_EVENT_POSTED` — neither
 * source had the id. `selectedEvent` was null, `{selectedEvent && …}` rendered
 * nothing, and the reader arrived at their own dashboard with no modal, no
 * error and no explanation.
 *
 * These mount the real shell at that URL with an empty index, which is the
 * cold-load shape exactly.
 */

vi.mock('./utils/api');
vi.mock('./services/socket', () => ({
  connectSocket: vi.fn(), disconnectSocket: vi.fn(), getSocket: vi.fn(),
  subscribeSocket: vi.fn(), unsubscribeSocket: vi.fn(),
  emitTypingStart: vi.fn(), emitTypingStop: vi.fn()
}));

const stub = (name) => ({
  default: (props) => <div data-testid={name} data-event={props.event?.id ?? ''} />
});
vi.mock('./components/EventModal', () => stub('event-modal'));
vi.mock('./views/BrowseEvents', () => ({ default: () => <div data-testid="browse" /> }));
vi.mock('./views/VolunteerDashboard', () => ({ default: () => <div data-testid="vol-dash" /> }));
vi.mock('./components/ThemeToggle', () => ({ default: () => <div data-testid="theme" /> }));
vi.mock('./components/NotificationsBell', () => ({ default: () => <div data-testid="bell" /> }));
vi.mock('./components/account/ProfileMenu', () => ({ default: () => <div data-testid="profile-menu" /> }));

const STUDENT = {
  id: 'student-1', name: 'Leo', email: 'leo@example.com', username: 'leo',
  role: 'student', verified: true, emailVerified: true, hasPassword: true,
  avatar: '🧑', skills: [],
};

/** The event a friend signed up for — one this student is NOT part of. */
const FOREIGN_EVENT = {
  id: 'event-riverbank', title: 'Riverbank Litter Sweep',
  slots: [], viewerBan: null, instructions: '',
};

Element.prototype.scrollTo = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  api.getMe.mockResolvedValue(STUDENT);
  /* The index is EMPTY on purpose. That is `{mine: 'true'}` for a student who
     is not involved, and it is the condition the defect needed. */
  api.fetchEventsProgressive.mockResolvedValue([]);
  api.fetchApplications.mockResolvedValue([]);
  api.fetchFavorites.mockResolvedValue([]);
  api.fetchNotifications.mockResolvedValue({ unreadCount: 0, notifications: [] });
  api.fetchLegalDocument.mockReturnValue(new Promise(() => {}));
  api.fetchLegalConsentStatus?.mockReturnValue?.(new Promise(() => {}));
});

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
);

describe('a notification email opened from a cold inbox', () => {
  it('resolves the event the link names and shows it', async () => {
    api.fetchEventById.mockResolvedValue(FOREIGN_EVENT);

    renderAt('/?event=event-riverbank');

    const modal = await screen.findByTestId('event-modal', {}, { timeout: 5000 });
    expect(modal.dataset.event).toBe('event-riverbank');
  });

  it('asks the server, because neither local cache can hold it', async () => {
    api.fetchEventById.mockResolvedValue(FOREIGN_EVENT);

    renderAt('/?event=event-riverbank');

    await waitFor(() => expect(api.fetchEventById).toHaveBeenCalledWith('event-riverbank'));
  });

  it('asks once, not on every render', async () => {
    /* The attempt ledger is a ref keyed by id. Without it the effect would
       re-run on each render — `selectedEvent` is rebuilt every time — and an
       id the server does not have would be asked about forever. */
    api.fetchEventById.mockResolvedValue(null);

    renderAt('/?event=event-missing');

    await waitFor(() => expect(api.fetchEventById).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 50));
    expect(api.fetchEventById).toHaveBeenCalledTimes(1);
  });

  it('shows no modal for an event that genuinely does not exist', async () => {
    /* The narrowing this change makes: "no longer available" still means what
       it says, it is simply no longer said about live events. */
    api.fetchEventById.mockResolvedValue(null);

    renderAt('/?event=event-missing');

    await waitFor(() => expect(api.fetchEventById).toHaveBeenCalled());
    expect(screen.queryByTestId('event-modal')).toBeNull();
  });

  it('does not crash the shell when the lookup fails', async () => {
    api.fetchEventById.mockRejectedValue(new Error('offline'));

    renderAt('/?event=event-riverbank');

    await waitFor(() => expect(api.fetchEventById).toHaveBeenCalled());
    expect(screen.queryByTestId('event-modal')).toBeNull();
  });
});
