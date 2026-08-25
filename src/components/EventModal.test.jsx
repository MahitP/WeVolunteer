import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventModal from './EventModal';
import { api } from '../utils/api';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  api: {
    fetchCheckins: vi.fn(),
    fetchAutoSelectRuns: vi.fn(),
    /* Every api method this tree can reach must exist here. A missing key is
       not a no-op — it throws `undefined is not a function` from inside a
       passive effect, which surfaces as a confusing hook-order failure rather
       than as "you forgot to mock getWeather". */
    getWeather: vi.fn(() => new Promise(() => {})),
    /* Added when TravelTime joined the "Getting there" row, and it failed
       exactly as the note above predicts: `api.getTravelTime is not a function`
       thrown from a passive effect, in a distance test that has nothing to do
       with travel times. Both resolve to a promise that never settles, so
       neither renders and neither races the assertions. */
    getTravelTime: vi.fn(() => new Promise(() => {})),
  }
}));

/* Overridden per-test where a position matters; see the distance cases. */
const locationState = { location: null };
vi.mock('../contexts/LocationContext', () => ({
  useLocationContext: () => locationState
}));

const mockEvent = {
  id: 'event-1',
  title: 'Test Event',
  category: 'School',
  description: 'A test event description',
  location: 'Library',
  status: 'open',
  applicationDeadline: new Date(Date.now() + 86400000).toISOString(),
  autoApprove: false,
  organizerId: 'org-1',
  slots: [
    {
      id: 'slot-1',
      name: 'Morning Shift',
      startDatetime: new Date(Date.now() - 90000000).toISOString(),
      endDatetime: new Date(Date.now() - 86400000).toISOString(),
      maxSpots: 10,
      filledSpots: 2
    }
  ]
};

const mockCurrentUser = {
  id: 'org-1',
  role: 'organizer'
};

const renderWithRouter = (ui) => {
  return render(<BrowserRouter>{ui}</BrowserRouter>);
};

describe('EventModal Characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders event details', () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={mockCurrentUser}
        applications={[]}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Test Event')).toBeInTheDocument();
    expect(screen.getByText('Morning Shift')).toBeInTheDocument();
  });

  it('can enter edit mode', async () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={mockCurrentUser}
        applications={[]}
        onClose={vi.fn()}
      />
    );
    
    const editBtn = screen.getByText('Edit event');
    fireEvent.click(editBtn);

    expect(screen.getByLabelText(/Event name/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Test Event')).toBeInTheDocument();
  });

  it('can enter attendance mode', async () => {
    api.fetchCheckins.mockResolvedValue([]);
    
    // Add an ended application so the button is enabled
    const mockApp = {
      id: 'app-1',
      eventId: 'event-1',
      status: 'accepted',
      slot: {
        id: 'slot-1',
        endDatetime: new Date(Date.now() - 86400000).toISOString(),
        hours: 1
      },
      volunteer: { id: 'v-1', name: 'Test Vol' }
    };

    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={mockCurrentUser}
        applications={[mockApp]}
        onClose={vi.fn()}
      />
    );
    
    const attendanceBtn = screen.getByText('Finalise hours');
    fireEvent.click(attendanceBtn);

    await waitFor(() => {
      expect(screen.getByText('Mark who actually attended. Only the volunteers you tick are credited.')).toBeInTheDocument();
    });
  });
});

/**
 * Location, which this modal is the only live surface for.
 *
 * The rich location components existed and worked, but the only file importing
 * them had no route and no importer of its own, so no volunteer had ever seen a
 * map, a distance or a directions link. These pin the wiring.
 */
describe('EventModal location', () => {
  const pinned = {
    ...mockEvent,
    location: 'Reichler Park',
    address: '100 Reichler Park Drive, Example Valley, NJ 08824',
    latitude: 40.386,
    longitude: -74.556,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    locationState.location = null;
  });

  it('makes the location a directions link', () => {
    renderWithRouter(
      <EventModal event={pinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
    );
    /* Anchored: the "Get directions" pill also names the place, and both
       links being present is the intended design, not an ambiguity. */
    expect(screen.getByRole('link', { name: /^Reichler Park/ })).toBeInTheDocument();
  });

  it('shows the street address when it adds something to the place name', () => {
    renderWithRouter(
      <EventModal event={pinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
    );
    expect(screen.getByText('100 Reichler Park Drive, Example Valley, NJ 08824')).toBeInTheDocument();
  });

  it('offers directions as an action of its own', () => {
    renderWithRouter(
      <EventModal event={pinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
    );
    expect(screen.getByRole('link', { name: /get directions/i })).toBeInTheDocument();
  });

  it('does not load map tiles until asked', () => {
    renderWithRouter(
      <EventModal event={pinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
    );
    /* The tile provider is the only third party that sees a student's IP. */
    expect(screen.getByRole('button', { name: /show map/i })).toBeInTheDocument();
  });

  it('shows the distance once the volunteer has shared a position', () => {
    locationState.location = { latitude: 40.4188, longitude: -74.5931 };
    renderWithRouter(
      <EventModal event={pinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
    );
    expect(screen.getByText(/mi away/)).toBeInTheDocument();
  });

  it('shows no distance when the volunteer has not shared one', () => {
    renderWithRouter(
      <EventModal event={pinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
    );
    expect(screen.queryByText(/mi away/)).toBeNull();
  });

  describe('an event with no pin', () => {
    /* The ordinary case: an organizer typed a place name and never opened the
       picker. Everything has to degrade, and nothing may break. */
    const unpinned = { ...mockEvent, location: 'Local Shelter', address: null, latitude: null, longitude: null };

    it('still links the location, using the place name as the destination', () => {
      renderWithRouter(
        <EventModal event={unpinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
      );
      expect(screen.getByRole('link', { name: /^Local Shelter/ })).toBeInTheDocument();
    });

    it('offers no map, because there is no point to put on one', () => {
      renderWithRouter(
        <EventModal event={unpinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
      );
      expect(screen.queryByRole('button', { name: /show map/i })).toBeNull();
    });

    it('asks for no forecast, because there is nowhere to forecast for', () => {
      renderWithRouter(
        <EventModal event={unpinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
      );
      expect(api.getWeather).not.toHaveBeenCalled();
    });

    it('shows no distance even when the volunteer has shared a position', () => {
      locationState.location = { latitude: 40.4188, longitude: -74.5931 };
      renderWithRouter(
        <EventModal event={unpinned} currentUser={mockCurrentUser} applications={[]} onClose={vi.fn()} />
      );
      expect(screen.queryByText(/mi away/)).toBeNull();
    });
  });
});

/**
 * `initialMode`, and why it is gated.
 *
 * The organizer dashboard's close-out reminder links straight to the Closeout
 * screen rather than to the event page beside a button that reaches it. It does
 * that through `?event=<id>&mode=hours`, which is how this modal already carries
 * its event id — so the destination survives a reload and a shared link.
 *
 * The consequence is that a mode can now arrive from the URL, and a URL is
 * user-supplied. Until now `'attendance'` was reachable only from a button
 * rendered inside `{isOwner && …}`; ungated, any signed-in student could type
 * the parameter and be handed the full roster with names and credited hours —
 * which is exactly what `attendeeVisibility` exists to control.
 *
 * The server refuses to ACT on any of it regardless (`canRunEvent` guards every
 * attendance route). These cases are about not RENDERING what it would refuse.
 */
describe('opening straight into the hours screen', () => {
  const ATTENDANCE_COPY = /Only ticked volunteers are credited|Everyone is accounted for|Hours for this event are final/;

  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchCheckins.mockResolvedValue([]);
  });

  /* The screen loads check-ins before it renders anything but a skeleton, so
     the copy arrives on the next tick rather than synchronously. */
  it('opens on the hours screen for the organizer who hosts it', async () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={mockCurrentUser}
        applications={[]}
        onClose={vi.fn()}
        initialMode="attendance"
      />
    );
    expect(await screen.findByText(ATTENDANCE_COPY)).toBeInTheDocument();
  });

  it('opens on the hours screen for an administrator', async () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={{ id: 'admin-1', role: 'admin' }}
        applications={[]}
        onClose={vi.fn()}
        initialMode="attendance"
      />
    );
    expect(await screen.findByText(ATTENDANCE_COPY)).toBeInTheDocument();
  });

  /** THE case. A crafted URL must not become a roster. */
  it('ignores the request from a student, showing the event instead', () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={{ id: 'stu-1', role: 'student' }}
        applications={[]}
        onClose={vi.fn()}
        initialMode="attendance"
      />
    );
    expect(screen.queryByText(ATTENDANCE_COPY)).toBeNull();
    /* Ignored, not refused: a stale link should open the event, not an error. */
    expect(screen.getByText('Test Event')).toBeInTheDocument();
  });

  it('ignores the request from an organizer who does not host this event', () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={{ id: 'org-2', role: 'organizer' }}
        applications={[]}
        onClose={vi.fn()}
        initialMode="attendance"
      />
    );
    expect(screen.queryByText(ATTENDANCE_COPY)).toBeNull();
    expect(screen.getByText('Test Event')).toBeInTheDocument();
  });

  it('opens on the event itself when no mode is asked for', () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={mockCurrentUser}
        applications={[]}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByText(ATTENDANCE_COPY)).toBeNull();
    expect(screen.getByText('Test Event')).toBeInTheDocument();
  });
});
