import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrganizerDashboard from './OrganizerDashboard';

vi.mock('../utils/api', () => ({
  api: {
    fetchOrganizerStats: vi.fn(),
    fetchOrganizerAgreement: vi.fn(),
    deleteEvent: vi.fn(),
    duplicateEvent: vi.fn(),
    toggleEventStatus: vi.fn(),
    updateEvent: vi.fn(),
    exportRosterCSV: vi.fn(),
  },
}));

import { api } from '../utils/api';

/**
 * The order of the figures in "Programme at a glance", and the review section
 * beneath them.
 *
 * ── What the order says ──
 *
 * The first three tiles are the settled record of the programme — events
 * running, volunteers confirmed, hours credited. The fourth is the only one
 * that is a job still to do, and it now ends the strip, directly above the
 * review work itself rather than buried between two totals.
 *
 * ── Why the close-out section is asserted here too ──
 *
 * Moving a tile that says "Hours credited" past one that says "Awaiting
 * review", on a page that also carries the hours close-out card, is exactly the
 * edit that could take something else with it. So this file checks the strip
 * AND that the card below still lists what it should and still opens the hours
 * workflow. `OrganizerDashboard.closeOutReminder.test.jsx` covers that card in
 * full; these are the two assertions that would notice this change breaking it.
 */

const ORGANIZER = {
  id: 'org-1',
  name: 'Jordan Whitfield',
  role: 'organizer',
  verified: true,
  grants: [],
};

const baseEvent = (over = {}) => ({
  id: 'evt-1',
  title: 'Park Cleanup',
  organizerId: 'org-1',
  category: 'Environment',
  location: 'Reichler Park',
  status: 'open',
  hoursClosedOutAt: null,
  applicationDeadline: '2026-08-01T12:00:00.000Z',
  startDatetime: '2026-08-05T13:00:00.000Z',
  endDatetime: '2026-08-05T17:00:00.000Z',
  maxSpots: 5,
  spotsRemaining: 0,
  slots: [],
  ...over,
});

/* Two people accepted across three shift assignments, two applications still to
   review — figures that are all different from one another, so a value landing
   under the wrong label cannot pass unnoticed. */
const applications = [
  { id: 'ap-1', userId: 'stu-1', eventId: 'evt-1', status: 'accepted' },
  { id: 'ap-2', userId: 'stu-1', eventId: 'evt-1', status: 'accepted' },
  { id: 'ap-3', userId: 'stu-2', eventId: 'evt-1', status: 'accepted' },
  { id: 'ap-4', userId: 'stu-3', eventId: 'evt-1', status: 'pending' },
  { id: 'ap-5', userId: 'stu-4', eventId: 'evt-1', status: 'pending' },
];

const draw = (events = [baseEvent()], { onViewDetails = vi.fn() } = {}) => {
  const view = render(
    <MemoryRouter>
      <OrganizerDashboard
        currentUser={ORGANIZER}
        events={events}
        applications={applications}
        refreshEvents={vi.fn()}
        addToast={vi.fn()}
        onViewDetails={onViewDetails}
        onViewVolunteerProfile={vi.fn()}
        setActiveTab={vi.fn()}
      />
    </MemoryRouter>,
  );
  return { ...view, onViewDetails };
};

/**
 * `[label, value]` for the "Programme at a glance" strip.
 *
 * Selected by the section that carries four tiles rather than by document
 * order, because this page draws other `.stats` blocks and picking the first
 * one would make the test depend on which sections happen to be visible.
 */
function tiles(container) {
  const strip = [...container.querySelectorAll('.stats')]
    .find(s => s.querySelectorAll('.stat').length === 4);
  expect(strip, 'the four-tile summary strip is no longer on this page').toBeTruthy();
  return [...strip.querySelectorAll('.stat')].map(stat => [
    stat.querySelector('.stat-label')?.textContent.trim(),
    stat.querySelector('.stat-value')?.textContent.trim(),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchOrganizerStats).mockResolvedValue({ hoursAwarded: 236.72 });
  vi.mocked(api.fetchOrganizerAgreement).mockResolvedValue({ required: false });
});

describe('the organizer dashboard summary tiles', () => {
  /* The owner's own order, pasted in his request (CK-12): "ACTIVE EVENTS,
     VOLUNTEERS CONFIRMED, AWAITING REVIEW, HOURS CREDITED … keep everything as
     is". An earlier change swapped the last two after reading "the review hours
     box" as the Awaiting-review tile; it was the close-out card (see below). */
  it('reads Active events, Volunteers confirmed, Awaiting review, Hours credited — the owner\'s order', () => {
    const { container } = draw();
    expect(tiles(container).map(([label]) => label)).toEqual([
      'Active events',
      'Volunteers confirmed',
      'Awaiting review',
      'Hours credited',
    ]);
  });

  it('keeps each figure with the label it belongs to', async () => {
    const { container } = draw();
    /* The credited total arrives from `fetchOrganizerStats` after mount, so the
       assertion waits for it rather than reading the 0 it starts at. */
    await waitFor(() => expect(tiles(container)[3][1]).toMatch(/236/));

    const drawn = tiles(container);
    expect(drawn[0]).toEqual(['Active events', '1']);
    expect(drawn[1]).toEqual(['Volunteers confirmed', '2']);
    expect(drawn[2]).toEqual(['Awaiting review', '2']);
    expect(drawn[3][0]).toBe('Hours credited');
  });

  it('keeps the shift-assignment note under Volunteers confirmed', () => {
    const { container } = draw();
    const strip = [...container.querySelectorAll('.stats')]
      .find(s => s.querySelectorAll('.stat').length === 4);
    const stat = [...strip.querySelectorAll('.stat')]
      .find(s => s.querySelector('.stat-label')?.textContent.trim() === 'Volunteers confirmed');
    expect(stat.querySelector('.stat-note').textContent).toBe('3 shift assignments');
  });

  it('still draws exactly four tiles and adds nothing', () => {
    const { container } = draw();
    expect(tiles(container)).toHaveLength(4);
  });

  /**
   * `--warn` marks a queue somebody is waiting in. It belongs to Awaiting
   * review and must not have travelled to the tile that swapped past it.
   */
  it('leaves the warning colour on Awaiting review alone', () => {
    const { container } = draw();
    const strip = [...container.querySelectorAll('.stats')]
      .find(s => s.querySelectorAll('.stat').length === 4);
    const byLabel = label => [...strip.querySelectorAll('.stat')]
      .find(s => s.querySelector('.stat-label')?.textContent.trim() === label)
      .querySelector('.stat-value');

    expect(byLabel('Awaiting review').getAttribute('style')).toMatch(/--warn/);
    expect(byLabel('Hours credited').getAttribute('style') || '').not.toMatch(/--warn/);
    expect(byLabel('Hours credited').className).toMatch(/accent/);
  });
});

describe('the hours review section below the tiles', () => {
  const finished = () => [
    baseEvent({ id: 'evt-1', title: 'Park Cleanup', status: 'completed' }),
    baseEvent({
      id: 'evt-2', title: 'Food Drive', status: 'completed',
      endDatetime: '2026-07-02T17:00:00.000Z',
    }),
  ];

  /* CK-12, the request itself: "This box should be above the review hours box.
     I'll send the review hours box below" — and what he sent was the close-out
     card ("READY WHEN YOU ARE … Review hours"). Nothing asserted this before,
     which is how a change claiming to fix it could leave the card on top. */
  it('draws the summary strip ABOVE the close-out card', () => {
    const { container } = draw(finished());
    const strip = [...container.querySelectorAll('.stats')]
      .find(s => s.querySelectorAll('.stat').length === 4);
    const card = screen.getByText(/finished events with\s+hours not closed out/i).closest('section');
    expect(strip).toBeTruthy();
    expect(card).toBeTruthy();
    expect(strip.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('still reports the events whose hours are not closed out', () => {
    draw(finished());
    expect(screen.getByText(/2 finished events with\s+hours not closed out/i)).toBeInTheDocument();
    expect(screen.getByText(/still correctable/i)).toBeInTheDocument();
  });

  it('still opens the hours workflow', () => {
    const { onViewDetails } = draw(finished());
    fireEvent.click(screen.getByRole('button', { name: /Review hours/i }));
    expect(onViewDetails).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt-2' }),
      { mode: 'hours' },
    );
  });
});
