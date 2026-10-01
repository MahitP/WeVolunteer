import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CalendarView from './CalendarView';
import { LocationProvider } from '../contexts/LocationContext';

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

/**
 * An administrator's calendar is the district's schedule (ruling 2).
 *
 * Administrators got Calendar back on their bar on the owner's ruling, and the
 * same ruling says what it shows: every event on the platform. The page took
 * the volunteer's branch for anybody who was not an organizer, so an
 * administrator — who applies to nothing — saw only "Applications close"
 * markers for open events, under a legend about their own confirmed shifts and
 * an empty state promising "Shifts you are accepted for".
 */

const soon = (days, hour) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const event = (id, title, organizerId, status = 'open') => ({
  id, title, organizerId, status,
  applicationDeadline: soon(1, 9),
  slots: [{ id: `${id}-s1`, name: 'Morning', startDatetime: soon(3, 9), endDatetime: soon(3, 11), hours: 2 }],
});

const EVENTS = [
  event('e1', 'River Cleanup', 'org-a'),
  /* Closed to applications and run by somebody else: still on the schedule. */
  event('e2', 'Library Shelving', 'org-b', 'closed'),
  event('e3', 'Cancelled Bake Sale', 'org-b', 'cancelled'),
];

const ADMIN = { id: 'admin-1', role: 'admin', withheld: [], verified: true };

const renderFor = (user) => render(
  <MemoryRouter>
    <LocationProvider>
      <CalendarView currentUser={user} events={EVENTS} applications={[]} onViewEvent={vi.fn()} />
    </LocationProvider>
  </MemoryRouter>
);

describe('an administrator\'s calendar', () => {
  it('lists every scheduled event, whoever runs it and whether or not it is open', () => {
    renderFor(ADMIN);
    expect(screen.getAllByText('River Cleanup').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Library Shelving').length).toBeGreaterThan(0);
    expect(screen.queryByText('Cancelled Bake Sale')).toBeNull();
  });

  it('explains itself as the platform\'s schedule, not the reader\'s own shifts', () => {
    renderFor(ADMIN);
    expect(screen.getByText('Event shift')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed shift')).toBeNull();
    expect(screen.queryByText('Awaiting Decision')).toBeNull();
  });

  it('leaves a volunteer\'s calendar as their own commitments', () => {
    renderFor({ id: 'stu-1', role: 'student', withheld: [], verified: true });
    expect(screen.getByText('Confirmed shift')).toBeInTheDocument();
    expect(screen.queryByText('Event shift')).toBeNull();
  });
});
