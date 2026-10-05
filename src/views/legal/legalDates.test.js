import { describe, it, expect } from 'vitest';
import { effectiveDateLabel } from './legalDates';

/**
 * How a version line describes its effective date.
 *
 * Every version line said "in effect since <date>", which was true while every
 * document was dated on or before the day it was published. A notice period
 * breaks that: Terms 2.0 is published thirty days before it takes effect, as
 * Terms §13 promises, and the Acceptable Use Policy and End-User Licence are
 * dated to take effect with it. For those thirty days the Legal Center would
 * have told every reader that a document not yet binding them already was.
 */
describe('effectiveDateLabel', () => {
  it('says "in effect since" once the date has arrived', () => {
    expect(effectiveDateLabel('2026-08-06', '2026-10-05')).toBe('in effect since August 6, 2026');
  });

  it('counts the effective day itself as in effect', () => {
    expect(effectiveDateLabel('2026-10-05', '2026-10-05')).toBe('in effect since October 5, 2026');
  });

  it('says "takes effect" while the date is still ahead', () => {
    expect(effectiveDateLabel('2026-11-06', '2026-10-05')).toBe('takes effect November 6, 2026');
  });

  it('reads a timestamp as the day it names', () => {
    expect(effectiveDateLabel('2026-11-06T00:00:00.000Z', '2026-10-05')).toBe('takes effect November 6, 2026');
  });

  it('says nothing about a missing or unreadable date', () => {
    expect(effectiveDateLabel(null, '2026-10-05')).toBeNull();
    expect(effectiveDateLabel('soon', '2026-10-05')).toBeNull();
  });
});
