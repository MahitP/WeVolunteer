import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({ api: { fetchVolunteerProfile: vi.fn() } }));

import { api } from '../utils/api';
import VolunteerPortfolio from './VolunteerPortfolio';

/**
 * The transcript, which had no test at all.
 *
 * It is the document a volunteer hands to a college, and it used to contradict
 * itself on the page: a summary counting events above a table listing shifts,
 * so "1 event completed" sat over three rows for one food drive.
 */

const currentUser = { id: 'u1' };

const shift = (over = {}) => ({
  eventId: 'e1',
  title: 'Food Drive',
  organizerName: 'Sarah Jenkins',
  location: 'Community Center',
  category: 'Food Pantry',
  slotName: 'Setup',
  hours: 2,
  startDatetime: '2026-03-12T09:00:00.000Z',
  endDatetime: '2026-03-12T11:00:00.000Z',
  ...over,
});

const profile = (completed, over = {}) => ({
  volunteer: { id: 'u1', name: 'Olivia Garcia', username: 'olivia' },
  stats: { hours: 6, eventsCompleted: 1, shiftsCompleted: completed.length },
  completed,
  ...over,
});

const renderIt = () => render(
  <MemoryRouter><VolunteerPortfolio currentUser={currentUser} /></MemoryRouter>,
);

/** The service-history table's body rows. */
const historyRows = () => {
  const table = screen.getByRole('table');
  return within(table).getAllByRole('row').filter(r => within(r).queryAllByRole('cell').length > 0);
};

describe('VolunteerPortfolio', () => {
  beforeEach(() => { vi.mocked(api.fetchVolunteerProfile).mockReset(); });

  it('lists one row per event, not one per shift', async () => {
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([
      shift({ slotName: 'Setup' }),
      shift({ slotName: 'Distribution' }),
      shift({ slotName: 'Cleanup' }),
    ]));
    renderIt();

    await screen.findByText('Olivia Garcia');
    /* Three shifts of one food drive. Plus the tfoot total row. */
    const rows = historyRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Food Drive')).toBeInTheDocument();
  });

  it('sums the shifts of an event into one figure', async () => {
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([
      shift({ hours: 2 }), shift({ hours: 2 }), shift({ hours: 2 }),
    ]));
    renderIt();

    await screen.findByText('Food Drive');
    expect(screen.getAllByText('6 hrs').length).toBeGreaterThan(0);
  });

  it('never prints a shift name', async () => {
    /* "Food Drive — Setup" is an implementation detail of how attendance is
       taken, not something a college should read. */
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([
      shift({ slotName: 'Setup' }), shift({ slotName: 'Cleanup' }),
    ]));
    const { container } = renderIt();

    await screen.findByText('Food Drive');
    expect(container.textContent).not.toContain('Setup');
    expect(container.textContent).not.toContain('Cleanup');
  });

  it('says how many shifts an event took, without naming them', async () => {
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([shift(), shift(), shift()]));
    renderIt();
    expect(await screen.findByText('3 shifts')).toBeInTheDocument();
  });

  it('keeps separate events separate', async () => {
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([
      shift({ eventId: 'e1', title: 'Food Drive', hours: 6 }),
      shift({ eventId: 'e2', title: 'Community Cleanup', hours: 3.5, startDatetime: '2026-04-04T09:00:00.000Z' }),
    ]));
    renderIt();

    await screen.findByText('Food Drive');
    expect(screen.getByText('Community Cleanup')).toBeInTheDocument();
    expect(historyRows()).toHaveLength(3); // two events + total
  });

  it('agrees with its own table about the total', async () => {
    /**
     * The property that matters most on a document a scholarship decision is
     * made from. The headline is computed from the rows being printed, so the
     * two cannot drift.
     */
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([
      shift({ eventId: 'e1', hours: 2.5 }),
      shift({ eventId: 'e1', hours: 1.5 }),
      shift({ eventId: 'e2', hours: 3, startDatetime: '2026-04-04T09:00:00.000Z' }),
    ]));
    renderIt();

    await screen.findByText('Verified hours');
    /* 7 hrs appears as the headline figure and again in the table footer. */
    expect(screen.getAllByText('7 hrs').length).toBeGreaterThanOrEqual(2);
  });

  it('counts events, not shifts, beside the hours', async () => {
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([shift(), shift(), shift()]));
    renderIt();

    await screen.findByText('Events');
    const events = screen.getByText('Events').parentElement;
    expect(within(events).getByText('1')).toBeInTheDocument();
  });

  it('states that self-reported service is excluded', async () => {
    /* Credited and self-reported hours are kept apart at every layer, and the
       document a college reads is where saying so matters most. */
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([shift()]));
    renderIt();
    expect(await screen.findByText(/Self-reported service.*not included/i)).toBeInTheDocument();
  });

  it('is still a valid document for somebody with no service yet', async () => {
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([], {
      stats: { hours: 0, eventsCompleted: 0, shiftsCompleted: 0 },
    }));
    renderIt();

    expect(await screen.findByText(/No verified service on record/i)).toBeInTheDocument();
    /* The header and the signature block still print — an empty transcript is
       a statement, not a broken page. */
    expect(screen.getByText('Olivia Garcia')).toBeInTheDocument();
    expect(screen.getByText(/Authorized signature/i)).toBeInTheDocument();
  });

  it('keeps the print controls off the printed page', async () => {
    vi.mocked(api.fetchVolunteerProfile).mockResolvedValue(profile([shift()]));
    const { container } = renderIt();

    await screen.findByText('Food Drive');
    const printButton = screen.getByRole('button', { name: /print or save/i });
    expect(printButton.closest('.no-print')).toBeTruthy();
    /* And the document itself carries none of them. */
    expect(within(container.querySelector('.transcript')).queryAllByRole('button')).toHaveLength(0);
  });

  it('shows an error rather than a blank page when the record cannot load', async () => {
    vi.mocked(api.fetchVolunteerProfile).mockRejectedValue(new Error('nope'));
    renderIt();
    expect(await screen.findByText(/Transcript unavailable/i)).toBeInTheDocument();
  });
});
