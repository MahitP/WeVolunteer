import { describe, it, expect } from 'vitest';
import { auditLabel, auditTone, auditTimestamp, TONES } from './auditFormat';

/**
 * Turning a stored audit row into something a person can read.
 *
 * The screen showed `REPORT_EVIDENCE_VIEWED` and five more like it, in caps. A
 * page of SCREAMING_SNAKE is a page nobody scans: every row looks like every
 * other row, and the one that matters — somebody read a student's private
 * messages — sits at the same weight as a routine approval.
 */
describe('auditLabel', () => {
  it('reads as a sentence about something that already happened', () => {
    expect(auditLabel('ACCOUNT_SUSPENDED')).toBe('Account suspended');
    expect(auditLabel('REPORT_EVIDENCE_VIEWED')).toBe('Report evidence read');
    expect(auditLabel('APPROVE_ORGANIZER')).toBe('Organizer approved');
  });

  /**
   * The trail outlives this file. A row written by a release that knew an action
   * this build does not must still be readable — the alternative is a blank cell
   * in the one record that is supposed to be permanent.
   */
  it('falls back to sentence case for an action it has never heard of', () => {
    expect(auditLabel('SOME_FUTURE_THING')).toBe('Some future thing');
  });

  it('never returns nothing, whatever it is handed', () => {
    for (const bad of [null, undefined, '', 42, {}]) {
      expect(typeof auditLabel(bad)).toBe('string');
      expect(auditLabel(bad).length).toBeGreaterThan(0);
    }
  });
});

describe('auditTone', () => {
  /**
   * `grave` is reserved for what this platform can do to a person that they
   * cannot undo themselves: lock them out, read their private messages, or
   * change who holds power over them. These are usually correct and always
   * consequential, and an owner skimming a year of records should find them
   * without reading every line.
   */
  it.each([
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_WARNED',
    'REPORT_EVIDENCE_VIEWED',
    'ADMIN_PROMOTED',
    'ADMIN_REVOKED',
    'OWNER_BOOTSTRAPPED',
  ])('marks %s as grave', (action) => {
    expect(auditTone(action)).toBe(TONES.GRAVE);
  });

  /**
   * A moderator resolving a report against themselves is the conflict-of-interest
   * case that `suspensionTargetError` exists to prevent and that only a
   * super_admin can reach. It must not read as routine.
   */
  it('does not treat a self-review as an ordinary resolution', () => {
    expect(auditTone('MODERATE_REPORT')).toBe(TONES.NOTABLE);
    expect(auditTone('MODERATE_REPORT_SELF_REVIEW')).toBe(TONES.GRAVE);
  });

  /** Loud is a claim, and a build that has never heard of an action cannot make it. */
  it('is routine for an unrecognised action rather than alarming', () => {
    expect(auditTone('SOME_FUTURE_THING')).toBe(TONES.ROUTINE);
  });
});

describe('auditTimestamp', () => {
  /**
   * The old column used `toLocaleDateString()` alone, so every row of a busy
   * afternoon read the same date and the ordering — the whole point of an
   * append-only log — was invisible.
   */
  it('carries a time as well as a date', () => {
    const t = auditTimestamp('2026-08-01T14:30:00.000Z');
    expect(t.date).toMatch(/2026/);
    expect(t.time).toMatch(/\d{1,2}:\d{2}/);
  });

  /** Full precision on hover, for when seconds settle an argument about order. */
  it('keeps a fuller form for the tooltip', () => {
    const t = auditTimestamp('2026-08-01T14:30:05.000Z');
    expect(t.title.length).toBeGreaterThan(t.date.length);
  });

  it('degrades to a dash rather than "Invalid Date"', () => {
    for (const bad of [null, undefined, 'not-a-date', '']) {
      expect(auditTimestamp(bad).date).toBe('—');
    }
  });
});
