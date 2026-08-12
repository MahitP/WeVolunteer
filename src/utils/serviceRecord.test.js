import { describe, it, expect } from 'vitest';
import { aggregateServiceByEvent, totalServiceHours } from './serviceRecord';

/**
 * The transcript's grain.
 *
 * Attendance is recorded per shift because that is how an organizer confirms
 * it. A transcript read by a college is per event. These pin the translation,
 * and above all that the translation preserves the total — a document whose
 * rows do not add up to its own headline figure is worse than one with too many
 * rows.
 */

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

describe('aggregateServiceByEvent', () => {
  it('shows an event with three shifts once', () => {
    const rows = aggregateServiceByEvent([
      shift({ slotName: 'Setup' }),
      shift({ slotName: 'Distribution' }),
      shift({ slotName: 'Cleanup' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Food Drive');
  });

  it('sums the hours of those shifts', () => {
    const rows = aggregateServiceByEvent([
      shift({ hours: 2 }), shift({ hours: 2 }), shift({ hours: 2 }),
    ]);
    expect(rows[0].hours).toBe(6);
  });

  it('records how many shifts were rolled up', () => {
    const rows = aggregateServiceByEvent([shift(), shift(), shift()]);
    expect(rows[0].shifts).toBe(3);
  });

  it('keeps separate events separate', () => {
    const rows = aggregateServiceByEvent([
      shift({ eventId: 'e1', title: 'Food Drive', hours: 6 }),
      shift({ eventId: 'e2', title: 'Community Cleanup', hours: 3.5, startDatetime: '2026-04-04T09:00:00.000Z' }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.title)).toEqual(['Community Cleanup', 'Food Drive']);
  });

  it('never leaks a shift name into the event history', () => {
    /* The whole point: "Food Drive — Setup" is an implementation detail of how
       attendance is taken, not a thing a college should read. */
    const rows = aggregateServiceByEvent([shift({ slotName: 'Setup' })]);
    expect(JSON.stringify(rows)).not.toContain('Setup');
    expect(rows[0].slotName).toBeUndefined();
  });

  it('preserves the total exactly', () => {
    /**
     * The property that matters most. The transcript prints a headline total
     * and a table; if aggregation changed the sum, the document would disagree
     * with itself, and it is the document a scholarship decision is made on.
     */
    const shifts = [
      shift({ eventId: 'e1', hours: 2.25 }),
      shift({ eventId: 'e1', hours: 1.75 }),
      shift({ eventId: 'e2', hours: 3.5 }),
      shift({ eventId: 'e3', hours: 0.5 }),
    ];
    expect(totalServiceHours(aggregateServiceByEvent(shifts))).toBe(totalServiceHours(shifts));
  });

  it('does not accumulate floating point error across many shifts', () => {
    const shifts = Array.from({ length: 30 }, () => shift({ hours: 0.1 }));
    expect(aggregateServiceByEvent(shifts)[0].hours).toBe(3);
  });

  it('spans a multi-day event from its first shift to its last', () => {
    const rows = aggregateServiceByEvent([
      shift({ startDatetime: '2026-03-13T09:00:00.000Z', endDatetime: '2026-03-13T12:00:00.000Z' }),
      shift({ startDatetime: '2026-03-12T09:00:00.000Z', endDatetime: '2026-03-12T11:00:00.000Z' }),
    ]);

    expect(rows[0].firstStart).toBe('2026-03-12T09:00:00.000Z');
    expect(rows[0].lastEnd).toBe('2026-03-13T12:00:00.000Z');
  });

  it('orders newest first', () => {
    const rows = aggregateServiceByEvent([
      shift({ eventId: 'old', title: 'Old', startDatetime: '2025-01-01T09:00:00.000Z' }),
      shift({ eventId: 'new', title: 'New', startDatetime: '2026-08-01T09:00:00.000Z' }),
      shift({ eventId: 'mid', title: 'Mid', startDatetime: '2026-02-01T09:00:00.000Z' }),
    ]);
    expect(rows.map(r => r.title)).toEqual(['New', 'Mid', 'Old']);
  });

  describe('degenerate input', () => {
    it('returns nothing for an empty history', () => {
      expect(aggregateServiceByEvent([])).toEqual([]);
    });

    it('returns nothing rather than throwing for a missing history', () => {
      /* The profile payload redacts `completed` to [] for a viewer who may not
         see it, and an older payload could omit it entirely. */
      expect(aggregateServiceByEvent(undefined)).toEqual([]);
      expect(aggregateServiceByEvent(null)).toEqual([]);
    });

    it('does not merge two rows that both lack an event id', () => {
      /* Without an id there is nothing that says these are the same
         commitment, and merging them would invent a relationship. */
      const rows = aggregateServiceByEvent([
        shift({ eventId: undefined, title: 'One', hours: 1 }),
        shift({ eventId: undefined, title: 'Two', hours: 2 }),
      ]);
      expect(rows).toHaveLength(2);
    });

    it('treats an unreadable hours value as zero rather than NaN', () => {
      const rows = aggregateServiceByEvent([shift({ hours: null }), shift({ hours: 2 })]);
      expect(rows[0].hours).toBe(2);
    });
  });
});

describe('totalServiceHours', () => {
  it('adds hours to two decimal places', () => {
    expect(totalServiceHours([{ hours: 1.005 }, { hours: 2.005 }])).toBe(3.01);
  });

  it('is zero for nothing', () => {
    expect(totalServiceHours([])).toBe(0);
    expect(totalServiceHours(undefined)).toBe(0);
  });
});
