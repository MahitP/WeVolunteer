import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ImpactDashboard from './ImpactDashboard';
import { api } from '../utils/api';

vi.mock('../utils/api');

/**
 * The community impact page.
 *
 * The server suites own the arithmetic and the suppression threshold. This owns
 * the thing only the page can get wrong: presenting a suppressed bucket as if it
 * were a real zero, or presenting a figure without the sentence that makes it
 * checkable.
 */

const PAYLOAD = (over = {}) => ({
  generatedAt: '2026-03-01T10:00:00.000Z',
  minBucket: 5,
  community: {
    totalVolunteers: 42, totalHours: 318.5, eventsCompleted: 12, organizationsSupported: 4,
  },
  volunteers: { averageHours: 7.6, medianHours: 4, returningRate: 38, cohort: 42 },
  categories: [
    { label: 'Food Pantry', count: 20, suppressed: false, events: 6, hours: 180 },
    { label: 'Fundraiser', count: null, suppressed: true },
  ],
  growth: [
    { month: '2026-01', label: '2026-01', count: 18, suppressed: false, events: 4, hours: 120 },
    { month: '2026-02', label: '2026-02', count: null, suppressed: true },
  ],
  geography: { distinctLocations: 7, breakdown: [] },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchImpact.mockResolvedValue(PAYLOAD());
});

describe('ImpactDashboard', () => {
  /**
   * Scoped to each figure's own card rather than searching the page for a
   * number. Two figures legitimately share a value — four organizations and a
   * median of four hours — and a bare text lookup cannot tell them apart, which
   * would make this pass while the two were swapped.
   */
  const figure = (label) =>
    screen.getByText(label).closest('.impact-figure').querySelector('.impact-figure-value').textContent;

  it('shows the four community totals, each under its own label', async () => {
    render(<ImpactDashboard />);
    await screen.findByText('Volunteers');
    expect(figure('Volunteers')).toBe('42');
    expect(figure('Hours served')).toBe('318.5');
    expect(figure('Events completed')).toBe('12');
    expect(figure('Organizations')).toBe('4');
  });

  /**
   * The figure and its caveat travel together.
   *
   * "1,240 hours" invites "hours of what, claimed by whom", and a page that
   * leaves that unanswered is a page somebody checks once and then stops
   * quoting. These notes are the difference between a number and a claim.
   */
  it('says what each headline figure counts', async () => {
    render(<ImpactDashboard />);
    expect(await screen.findByText(/people who turned up, not sign-ups/i)).toBeInTheDocument();
    expect(screen.getByText(/confirmed by an organizer after the shift/i)).toBeInTheDocument();
    expect(screen.getByText(/events somebody actually attended/i)).toBeInTheDocument();
  });

  /**
   * The assertion the privacy work exists for, on the presentation side.
   *
   * A suppressed bucket has a null count. Rendering it through the same path as
   * a real value would print "0", which states that nothing happened in that
   * category — a false claim, and a more damaging one than the withheld figure
   * it replaced.
   */
  it('shows a suppressed bucket as withheld, never as zero', async () => {
    render(<ImpactDashboard />);
    await screen.findByText('Food Pantry');

    expect(screen.getByText('Fundraiser')).toBeInTheDocument();
    const withheld = screen.getAllByText(/withheld/i);
    expect(withheld.length).toBeGreaterThanOrEqual(2); // one category, one month
    expect(screen.queryByText('0 hrs')).not.toBeInTheDocument();
  });

  /** And it explains itself once, rather than leaving a gap that reads as a bug. */
  it('explains why anything was withheld, and names the threshold', async () => {
    render(<ImpactDashboard />);
    const note = await screen.findByText(/fewer than\s*5\s*volunteers/i);
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/under 18/i);
  });

  /** No footnote when nothing was held back — an unexplained caveat is noise. */
  it('does not explain a suppression that did not happen', async () => {
    api.fetchImpact.mockResolvedValue(PAYLOAD({
      categories: [{ label: 'Food Pantry', count: 20, suppressed: false, events: 6, hours: 180 }],
      growth: [{ month: '2026-01', label: '2026-01', count: 18, suppressed: false, events: 4, hours: 120 }],
    }));
    render(<ImpactDashboard />);
    await screen.findByText('Food Pantry');
    expect(screen.queryByText(/withheld/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fewer than/i)).not.toBeInTheDocument();
  });

  /**
   * An empty platform gets an explanation of what would make the numbers appear,
   * not a wall of zeros. A brand-new programme looking at "0, 0, 0, 0" has been
   * told it is failing; it has not started.
   */
  it('says what would make the figures appear, rather than showing zeros', async () => {
    api.fetchImpact.mockResolvedValue(PAYLOAD({
      community: { totalVolunteers: 0, totalHours: 0, eventsCompleted: 0, organizationsSupported: 0 },
      volunteers: { averageHours: null, medianHours: null, returningRate: null, cohort: 0 },
      categories: [], growth: [], geography: { distinctLocations: 0, breakdown: [] },
    }));
    render(<ImpactDashboard />);
    expect(await screen.findByText(/nothing to show yet/i)).toBeInTheDocument();
    expect(screen.getByText(/confirmed the hours/i)).toBeInTheDocument();
  });

  it('renders a dash rather than a zero when there is nobody to average', async () => {
    api.fetchImpact.mockResolvedValue(PAYLOAD({
      volunteers: { averageHours: null, medianHours: null, returningRate: null, cohort: 0 },
    }));
    render(<ImpactDashboard />);
    await screen.findByText('42');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a failure instead of an empty page', async () => {
    api.fetchImpact.mockRejectedValue(new Error('network'));
    render(<ImpactDashboard />);
    expect(await screen.findByText(/couldn.t load the figures/i)).toBeInTheDocument();
  });

  it('shows a loading state while the figures are on their way', async () => {
    let resolve;
    api.fetchImpact.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = render(<ImpactDashboard />);
    expect(container.querySelector('.skeleton, [class*="skeleton"]')).toBeTruthy();
    resolve(PAYLOAD());
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
  });
});
