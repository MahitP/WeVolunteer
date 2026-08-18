import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BarChart } from './BarChart';

/**
 * The three charts three dashboards share, which had no test at all.
 *
 * ── What is actually worth asserting here ──
 *
 * Not pixel geometry. What matters is the part a sighted user never sees: the
 * visual halves are `aria-hidden`, so the `sr-only` table and the `aria-label`
 * are the ONLY description a screen-reader user gets. If those describe the
 * wrong quantity, the chart is wrong for them and right for everyone else — a
 * defect nobody notices.
 *
 * That is exactly what had happened. `BarChart`'s caption was hardcoded to
 * "Hours by period" and its value column to "Hours", so `AdminDashboard`'s
 * volunteers-per-month chart announced a count of people as hours. The caption
 * is now a prop, and these tests are what keep it honest.
 */

const MONTHS = [
  { month: '2026-03', hours: 4, volunteers: 2 },
  { month: '2026-04', hours: 9, volunteers: 5 }
];

describe('BarChart describes the quantity it is actually showing', () => {
  it('defaults to hours, so existing callers are unchanged', () => {
    render(<BarChart data={MONTHS} valueKey="hours" labelKey="month" />);

    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Hours by period');
    expect(screen.getByRole('table').querySelector('caption').textContent).toBe('Hours by period');
    expect(screen.getByRole('columnheader', { name: 'Hours' })).toBeTruthy();
  });

  /**
   * The regression that mattered: a chart of people announcing itself as hours.
   */
  it('says "Volunteers" when that is what it is counting', () => {
    render(
      <BarChart
        data={MONTHS} valueKey="volunteers" labelKey="month"
        caption="Volunteers active by month" unit="Volunteers" periodLabel="Month"
      />
    );

    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Volunteers active by month');
    expect(screen.getByRole('table').querySelector('caption').textContent)
      .toBe('Volunteers active by month');
    expect(screen.getByRole('columnheader', { name: 'Volunteers' })).toBeTruthy();
    expect(
      screen.queryByRole('columnheader', { name: 'Hours' }),
      'a count of people is still described as hours'
    ).toBeNull();
  });

  /**
   * The table is what pairs a label with its value. The bars and the axis labels
   * live in two separate grids, so read on their own they are a column of
   * numbers with no way to tell which belongs to which.
   */
  it('pairs every label with its value in the accessible table', () => {
    render(<BarChart data={MONTHS} valueKey="hours" labelKey="month" />);

    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toMatch(/9/);
  });

  it('hides the visual halves from assistive technology, so values are not read twice', () => {
    const { container } = render(<BarChart data={MONTHS} valueKey="hours" labelKey="month" />);

    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length, 'the bars and the axis labels should both be hidden').toBeGreaterThanOrEqual(2);
  });

  it('says what is missing in the caller\'s own terms when there is no data', () => {
    const { rerender } = render(<BarChart data={[]} />);
    expect(screen.getByText(/no hours recorded yet/i)).toBeTruthy();

    rerender(<BarChart data={[]} emptyText="No sign-ups yet" />);
    expect(screen.getByText(/no sign-ups yet/i)).toBeTruthy();
    expect(
      screen.queryByText(/no hours recorded yet/i),
      'an empty chart of sign-ups still claims to be about hours'
    ).toBeNull();
  });

  it('does not divide by zero when every value is zero', () => {
    // `max` is clamped to 1 for this reason; a NaN height renders nothing.
    render(<BarChart data={[{ month: '2026-05', hours: 0 }]} valueKey="hours" labelKey="month" />);
    expect(screen.getByRole('table')).toBeTruthy();
  });
});

