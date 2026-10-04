import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../utils/api', () => ({ api: { fetchAttendees: vi.fn() } }));

import { api } from '../utils/api';
import AttendeeList from './AttendeeList';

/**
 * The confirmed roster, as event staff read it.
 *
 * A student running the event is staff, and is sent grade and school only for
 * volunteers who share them (server/applicantDisclosure.js) — the key is
 * OMITTED for the rest. "Including N students" was counted from grades, so with
 * some withheld it would state a number that is simply wrong.
 */
const roster = (attendees) => api.fetchAttendees.mockResolvedValue({ visible: true, attendees });

describe('AttendeeList', () => {
  beforeEach(() => api.fetchAttendees.mockReset());

  it('counts the students when every grade is known', async () => {
    roster([
      { id: 'a', name: 'Ava', grade: '10', school: 'EVHS' },
      { id: 'b', name: 'Ben', grade: 'Adult', school: null },
    ]);
    render(<AttendeeList eventId="e1" currentUser={{ id: 'me' }} />);
    expect(await screen.findByText(/including 1 student\b/)).toBeInTheDocument();
  });

  it('does not count students when some grades were withheld from this reader', async () => {
    roster([
      { id: 'a', name: 'Ava', grade: '10', school: 'EVHS' },
      { id: 'c', name: 'Cal' },
      { id: 'd', name: 'Dee' },
    ]);
    render(<AttendeeList eventId="e1" currentUser={{ id: 'me' }} />);
    expect(await screen.findByText(/3 volunteers/)).toBeInTheDocument();
    expect(screen.queryByText(/including/)).not.toBeInTheDocument();
  });

  it('draws a withheld grade and school as nothing, not as a gap', async () => {
    roster([{ id: 'c', name: 'Cal' }]);
    const { container } = render(<AttendeeList eventId="e1" currentUser={{ id: 'me' }} />);
    await screen.findByText('Cal');
    expect(container.querySelector('.person-meta')).toBeNull();
    expect(container.textContent).not.toMatch(/undefined/);
  });
});
