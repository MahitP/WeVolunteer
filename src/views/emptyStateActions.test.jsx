import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CalendarView from './CalendarView';
import OrganizerDashboard from './OrganizerDashboard';
import { LocationProvider } from '../contexts/LocationContext';

/**
 * Empty states that name an action have to offer it.
 *
 * ── The two that did not ──
 *
 * `OrganizerDashboard`'s unverified-organizer screen — the whole dashboard for
 * every organizer between registering and being approved — said "You can browse
 * opportunities in the meantime" and offered no control. `CalendarView`'s empty
 * day said "Pick another date, or browse opportunities to fill it" and offered
 * no control either.
 *
 * Both are recoverable: Discover is in an organizer's rail and in a student's.
 * That is what makes this a broken promise rather than a trap — the sentence
 * names a next step and the screen makes the reader go and find it.
 *
 * ── The four that are fine, and are deliberately not touched ──
 *
 * `OrganizerDashboard`'s "No confirmed volunteers yet", `CalendarView`'s
 * "Nothing scheduled", "No pending applications" and "No past shifts yet" all
 * state a condition and name no action. An empty state is not required to offer
 * one; it is required not to promise one it withholds. `VolunteerProfile`'s
 * failure card already carries its own "Go back".
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

const STUDENT = { id: 'u1', name: 'Leo Chen', role: 'student', verified: true, withheld: [] };

describe('the calendar on a day with nothing on it', () => {
  it('offers the Discover it suggests', () => {
    render(
      <MemoryRouter>
        <LocationProvider>
          <CalendarView currentUser={STUDENT} events={[]} applications={[]} onViewEvent={vi.fn()} />
        </LocationProvider>
      </MemoryRouter>
    );

    /* The empty-day card appears only once a day is SELECTED, so the test
       selects one — the calendar's own grid buttons are the production path. */
    const dayCells = document.querySelectorAll('button.cal-day');
    expect(dayCells.length, 'the calendar drew no day cells').toBeGreaterThan(0);
    fireEvent.click(dayCells[15]);

    expect(screen.getByText(/Nothing on this day/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /^Discover$/i });
    expect(link).toHaveAttribute('href', '/discover');
  });
});

describe('an organizer waiting to be approved', () => {
  const PENDING = { id: 'u2', name: 'Jordan Whitfield', email: 'j@example.org',
    role: 'organizer', verified: false, withheld: [] };

  it('offers the Discover it suggests', () => {
    render(
      <MemoryRouter>
        <OrganizerDashboard
          currentUser={PENDING} events={[]} applications={[]}
          addToast={vi.fn()} refreshEvents={vi.fn()} setActiveTab={vi.fn()}
          onViewDetails={vi.fn()} onViewVolunteerProfile={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /^Discover$/i });
    expect(link).toHaveAttribute('href', '/discover');
  });

  it('still says which address is waiting on approval', () => {
    /* The control: adding a button must not cost the one fact the screen
       exists to deliver. */
    render(
      <MemoryRouter>
        <OrganizerDashboard
          currentUser={PENDING} events={[]} applications={[]}
          addToast={vi.fn()} refreshEvents={vi.fn()} setActiveTab={vi.fn()}
          onViewDetails={vi.fn()} onViewVolunteerProfile={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(screen.getByText('j@example.org')).toBeInTheDocument();
  });
});
