import { describe, it, expect } from 'vitest';
import {
  MILESTONE_TIERS, MILESTONE_METRICS, SERVICE_HOUR_GOAL, buildMilestones,
} from './milestones.js';

/**
 * The milestone ladder.
 *
 * ── Why this file exists ──
 *
 * These are the hour and event thresholds a student's service record is judged
 * against, including the district's 25-hour Silver Award, and until now they had
 * **no tests at all** — while existing in three places: inline in
 * `routes/userRoutes.js`, an unused byte-for-byte export in `utils.js`, and
 * `const HOUR_GOAL = 25` in two client views. Four copies of the same policy,
 * nothing checking any of them against each other.
 *
 * `milestones.js` is now the one definition. This file is what makes that worth
 * something: a pure module with no database and no HTTP, so the ladder can be
 * asserted directly rather than inferred from a profile response.
 */

describe('the milestone ladder', () => {
  it('declares a known metric and a positive threshold for every tier', () => {
    for (const tier of MILESTONE_TIERS) {
      expect(MILESTONE_METRICS, `${tier.id} uses an unknown metric`).toContain(tier.metric);
      expect(typeof tier.threshold, `${tier.id} threshold is not a number`).toBe('number');
      expect(tier.threshold, `${tier.id} threshold must be positive`).toBeGreaterThan(0);
      expect(tier.label, `${tier.id} has no label`).toBeTruthy();
      expect(tier.hint, `${tier.id} has no hint`).toBeTruthy();
    }
  });

  it('gives every tier a unique id', () => {
    const ids = MILESTONE_TIERS.map(t => t.id);
    expect(new Set(ids).size, `duplicate ids in ${ids.join(', ')}`).toBe(ids.length);
  });

  /**
   * Thresholds ascend WITHIN a metric.
   *
   * This is the property that makes "your next milestone" meaningful — the
   * client picks it with `milestones.find(m => !m.earned)`, i.e. the first
   * unearned tier in array order. If a 50-hour tier were listed before a
   * 25-hour one, somebody with 30 hours would be told their next target was one
   * they had already passed.
   *
   * It is asserted per metric rather than over the whole array on purpose: the
   * array interleaves hours and events deliberately, so that the ladder reads in
   * rough order of effort rather than grouping all hours together.
   */
  it('orders thresholds upward within each metric', () => {
    for (const metric of MILESTONE_METRICS) {
      const thresholds = MILESTONE_TIERS.filter(t => t.metric === metric).map(t => t.threshold);
      const ascending = [...thresholds].sort((a, b) => a - b);
      expect(thresholds, `${metric} tiers are out of order`).toEqual(ascending);
    }
  });

  it('derives the progress-meter goal from the Silver tier rather than restating it', () => {
    const silver = MILESTONE_TIERS.find(t => t.id === 'silver');
    expect(silver, 'the Silver tier is what the meter is drawn against').toBeTruthy();
    expect(silver.metric).toBe('hours');
    expect(SERVICE_HOUR_GOAL).toBe(silver.threshold);
  });
});

describe('buildMilestones', () => {
  const byId = (list) => Object.fromEntries(list.map(m => [m.id, m]));

  it('returns every tier, earned or not, rather than only the earned ones', () => {
    const all = buildMilestones(0, 0);
    expect(all).toHaveLength(MILESTONE_TIERS.length);
    /* A reader who sees three of seven knows where they are on the ladder; a
       reader who sees three knows nothing about what comes next. */
    expect(all.every(m => m.earned === false)).toBe(true);
  });

  it('carries the metric and threshold out, so no client needs its own copy', () => {
    const silver = byId(buildMilestones(0, 0)).silver;
    expect(silver.metric).toBe('hours');
    expect(silver.threshold).toBe(SERVICE_HOUR_GOAL);
  });

  /**
   * An untouched account has earned nothing.
   *
   * `SUM()` returns null on an empty ledger, not 0, and `null >= 1` is **true**
   * in JavaScript — so an unguarded comparison would award `first-shift` to
   * somebody who has never signed up for anything. That is the specific reason
   * `buildMilestones` coerces rather than trusting its inputs.
   */
  it.each([
    ['nulls from an empty ledger', null, null],
    ['undefined', undefined, undefined],
    ['zeros', 0, 0],
    ['negatives', -5, -2],
    ['non-numeric', 'x', 'y'],
  ])('earns nothing on %s', (_label, hours, events) => {
    expect(buildMilestones(hours, events).some(m => m.earned)).toBe(false);
  });

  it('earns a tier exactly AT its threshold, not one past it', () => {
    /* 25.0 hours is the Silver Award. A `>` would tell a student who reached it
       precisely that they had not, which is the boundary somebody actually lands
       on when an organizer confirms a round number of hours. */
    expect(byId(buildMilestones(25, 1)).silver.earned).toBe(true);
    expect(byId(buildMilestones(24.99, 1)).silver.earned).toBe(false);
  });

  it('keeps the two metrics independent', () => {
    /* Many hours at one event: the hours tiers are earned and the event-count
       tiers are not. Conflating them is how a single day-long event with five
       slots would score as five events — the defect badgeService's
       `collectStats` had, fixed there for the same reason. */
    const manyHoursOneEvent = byId(buildMilestones(100, 1));
    expect(manyHoursOneEvent.century.earned).toBe(true);
    expect(manyHoursOneEvent['five-events'].earned).toBe(false);
    expect(manyHoursOneEvent['first-shift'].earned).toBe(true);

    const manyEventsFewHours = byId(buildMilestones(2, 10));
    expect(manyEventsFewHours['ten-events'].earned).toBe(true);
    expect(manyEventsFewHours['ten-hours'].earned).toBe(false);
  });

  it('earns every tier below the one it reached', () => {
    /* No gaps. A ladder that could show `century` earned while `ten-hours` was
       not would be reporting an impossibility about a monotonic total. */
    const earned = buildMilestones(1000, 1000).filter(m => m.earned);
    expect(earned).toHaveLength(MILESTONE_TIERS.length);
  });

  it('does not let a caller mutate the shared tier definitions', () => {
    const built = buildMilestones(10, 2);
    built[0].label = 'tampered';
    expect(MILESTONE_TIERS[0].label).not.toBe('tampered');
  });
});

/**
 * The boundary against badges, from the milestone side.
 *
 * `badges.test.js` asserts the same boundary from the other direction — that the
 * shipped badge catalogue defines no hours or events threshold, and that
 * migration 024's four that did are retired at boot. This is the half that
 * fails if somebody adds a milestone for something a badge already confers.
 */
describe('milestones do not reach into what badges confer', () => {
  it('is a function of the service ledger only', () => {
    /* `hours` and `events` are both derivable from `attendance` on every read,
       which is what lets a milestone be recomputed rather than stored. A tier
       keyed on when somebody joined, or on a ratio, or on organizer work, cannot
       be — those are conferred records, and they belong to badges. */
    expect(MILESTONE_METRICS).toEqual(['hours', 'events']);
    for (const tier of MILESTONE_TIERS) {
      expect(['hours', 'events']).toContain(tier.metric);
    }
  });
});
