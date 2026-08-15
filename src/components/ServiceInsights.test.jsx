import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({ api: { fetchVolunteerStats: vi.fn() } }));
vi.mock('../utils/errorReporting', () => ({ reportClientError: vi.fn() }));

import { api } from '../utils/api';
import ServiceInsights from './ServiceInsights';

/**
 * The insight section, and the four states the version it replaces could not
 * express.
 *
 * The old code fetched with `.catch(() => {})` and gated the whole section on
 * the data being non-empty, so a 500, a slow network and a brand-new account
 * all produced exactly the same screen: nothing at all, with no explanation and
 * no way to retry.
 */

const months = (values) => values.map((hours, i) => ({
  month: `2026-0${i + 3}`, hours,
}));

const payload = (over = {}) => ({
  monthlyHours: months([0, 2, 0, 4, 3, 5]),
  record: {
    hoursCredited: 14,
    eventsSignedUp: 5,
    eventsAttended: 4,
    eventsAbsent: 0,
    eventsAwaitingRecord: 1,
    lastVolunteeredAt: '2026-08-02T18:00:00.000Z',
    firstVolunteeredAt: '2026-03-14T13:00:00.000Z',
    kindsOfService: 3,
    shiftsWorked: 6,
    ...over.record,
  },
  milestones: [
    { id: 'first-shift', label: 'First shift', metric: 'events', threshold: 1, earned: true },
    { id: 'ten-hours', label: '10 hours', metric: 'hours', threshold: 10, earned: true },
    { id: 'silver', label: 'Silver', metric: 'hours', threshold: 25, earned: false },
  ],
  streak: { current: 3, longest: 5 },
  upcomingCount: 2,
  serviceHourGoal: 25,
  ...over,
});

const renderIt = (props = {}) =>
  render(<MemoryRouter><ServiceInsights userId="u1" {...props} /></MemoryRouter>);

describe('ServiceInsights', () => {
  beforeEach(() => { vi.mocked(api.fetchVolunteerStats).mockReset(); });

  describe('states', () => {
    it('keeps its heading while loading, so the page does not reflow', async () => {
      vi.mocked(api.fetchVolunteerStats).mockReturnValue(new Promise(() => {}));
      renderIt();

      /* The heading is present before the data lands AND after — which is the
         whole reason nothing above the fold jumps when it arrives. */
      expect(screen.getByRole('heading', { name: /your service so far/i })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: /your service so far/i })).toHaveAttribute('aria-busy', 'true');
    });

    it('says so when the summary fails, and offers a retry', async () => {
      vi.mocked(api.fetchVolunteerStats).mockRejectedValue(new Error('500'));
      renderIt();

      const alert = await screen.findByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('reassures the reader that their hours are not the thing that broke', async () => {
      vi.mocked(api.fetchVolunteerStats).mockRejectedValue(new Error('500'));
      renderIt();
      /* An error box beside a number of hours reads as "your hours are gone"
         unless it says otherwise. */
      expect(await screen.findByText(/hours are safe/i)).toBeInTheDocument();
    });

    it('retries when asked, and recovers', async () => {
      vi.mocked(api.fetchVolunteerStats)
        .mockRejectedValueOnce(new Error('500'))
        .mockResolvedValueOnce(payload());
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

      expect(await screen.findByText(/Hours by month/i)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('welcomes a volunteer who has not started yet', async () => {
      vi.mocked(api.fetchVolunteerStats).mockResolvedValue(payload({
        record: { hoursCredited: 0, eventsAttended: 0, eventsAwaitingRecord: 0, eventsSignedUp: 0, kindsOfService: 0, firstVolunteeredAt: null },
      }));
      renderIt();

      expect(await screen.findByText(/starts with your first shift/i)).toBeInTheDocument();
    });

    it('distinguishes "nothing confirmed yet" from "nothing done yet"', async () => {
      /* A real situation the previous code could not express at all: the
         volunteer HAS worked, and is waiting on somebody else. */
      vi.mocked(api.fetchVolunteerStats).mockResolvedValue(payload({
        record: { hoursCredited: 0, eventsAttended: 0, eventsAwaitingRecord: 2, eventsSignedUp: 2, kindsOfService: 0, firstVolunteeredAt: null },
      }));
      renderIt();

      expect(await screen.findByText(/Nothing confirmed yet/i)).toBeInTheDocument();
      /* No action button: there is nothing they can do, and a button would
         imply otherwise. */
      expect(screen.queryByRole('button')).toBeNull();
    });
  });

  describe('content', () => {
    beforeEach(() => { vi.mocked(api.fetchVolunteerStats).mockResolvedValue(payload()); });

    it('leads with what is waiting on somebody else', async () => {
      renderIt();
      expect(await screen.findByText(/Waiting on an organizer/i)).toBeInTheDocument();
    });

    it('explains that checking in is not what credits hours', async () => {
      renderIt();
      expect(await screen.findByText(/doesn’t credit them/i)).toBeInTheDocument();
    });

    it('renders all six months, including the quiet ones', async () => {
      renderIt();
      await screen.findByText(/Hours by month/i);

      /* The accessible table is what a screen reader reads, and a month with no
         hours vanishing from it is the version of this bug nobody could see. */
      const rows = screen.getAllByRole('row');
      expect(rows.length).toBe(7); // header + six months
    });

    it('names the highlighted column instead of relying on its colour', async () => {
      renderIt();
      await screen.findByText(/Hours by month/i);
      expect(screen.getByRole('rowheader', { name: /this month/i })).toBeInTheDocument();
    });

    it('shows the record without inventing a rate', async () => {
      renderIt();
      expect(await screen.findByText('Events attended')).toBeInTheDocument();
      expect(screen.getByText('Kinds of service')).toBeInTheDocument();
      expect(screen.getByText('Volunteering since')).toBeInTheDocument();
      /* Counts, never a percentage: "1 of 2 — 50%" reads as a verdict on a
         person when the evidence is one missed shift. */
      expect(screen.queryByText(/%/)).toBeNull();
    });

    it('shows earned milestones and names the next one', async () => {
      renderIt();
      expect(await screen.findByText('First shift')).toBeInTheDocument();
      expect(screen.getByText(/Next milestone: Silver/)).toBeInTheDocument();
    });
  });

  describe('the streak, which must not become pressure', () => {
    it('shows a run of three months', async () => {
      vi.mocked(api.fetchVolunteerStats).mockResolvedValue(payload({ streak: { current: 3, longest: 5 } }));
      renderIt();
      expect(await screen.findByText(/3 months in a row/i)).toBeInTheDocument();
    });

    it('says nothing at all for a single month', async () => {
      /* A "1 month streak" is one month with a flame next to it, and putting
         one in front of somebody who has volunteered once reads as a
         scoreboard opening. */
      vi.mocked(api.fetchVolunteerStats).mockResolvedValue(payload({ streak: { current: 1, longest: 1 } }));
      renderIt();
      await screen.findByText(/Milestones/i);
      expect(screen.queryByText(/in a row/i)).toBeNull();
    });

    it('never nags', async () => {
      vi.mocked(api.fetchVolunteerStats).mockResolvedValue(payload());
      const { container } = renderIt();
      await screen.findByText(/3 months in a row/i);

      /* No countdown, no "keep it going", no indication of what would break it.
         Those are the mechanics that turn a record of what you did into
         pressure about what you must do next. */
      expect(container.textContent).not.toMatch(/keep it going|don't break|streak at risk|points|score|rank/i);
    });
  });

  it('does not refetch when the volunteer applies to something', async () => {
    vi.mocked(api.fetchVolunteerStats).mockResolvedValue(payload());
    const { rerender } = renderIt();
    await screen.findByText(/Hours by month/i);

    rerender(<MemoryRouter><ServiceInsights userId="u1" /></MemoryRouter>);

    await waitFor(() => expect(api.fetchVolunteerStats).toHaveBeenCalledTimes(1));
  });
});
