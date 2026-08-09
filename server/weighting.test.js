/**
 * The Auto Select weighting curve, and the v1.3 attendance term.
 *
 * ── What this file exists to prevent ──
 *
 * Until v1.3 nothing in the suite asserted that a lower-hours volunteer
 * actually wins more often. `routes.autoselect.test.js` pins determinism by
 * hand-building applicants in camelCase, and `autoSelectScheduler.test.js` pins
 * that the scheduler and the manual route agree with each other — neither
 * notices if both agree on the wrong answer.
 *
 * They agreed on the wrong answer for as long as `computeDraw` aliased its
 * column `total_hours` while `performWeightedSelection` read `totalHours`.
 * Every applicant arrived with `Number(undefined) || 0`, every applicant got the
 * identical maximum weight of 10.0, and the draw was a uniform lottery — while
 * the organizer UI described weighting and
 * docs/legal/policies/07-volunteer-record-policy.md published the formula as
 * policy.
 *
 * So the assertions here are deliberately about OUTCOMES over the real curve,
 * not about the shape of a function. A rename that breaks the wiring again
 * fails these tests.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateWeight, applicantWeight, reliabilityMultiplier, smoothedShowUpRate,
  createRandom, performWeightedSelection, PRIOR_RATE, PRIOR_WEIGHT,
} from './weighting.js';

/** Runs the draw many times and returns how often each id was selected. */
function selectionRate(applicants, spots, runs = 4000) {
  const counts = new Map(applicants.map(a => [a.id, 0]));
  for (let i = 0; i < runs; i++) {
    const { selectedIds } = performWeightedSelection(applicants, spots, createRandom(`seed-${i}`));
    for (const id of selectedIds) counts.set(id, counts.get(id) + 1);
  }
  const out = {};
  for (const [id, n] of counts) out[id] = n / runs;
  return out;
}

describe('the hours curve', () => {
  it('gives a brand-new volunteer the maximum weight', () => {
    expect(calculateWeight(0)).toBeCloseTo(10, 6);
  });

  it('decays as hours rise, and never reaches the floor', () => {
    const weights = [0, 25, 50, 100, 250, 500, 5000].map(calculateWeight);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThan(weights[i - 1]);
    }
    expect(weights.at(-1)).toBeGreaterThan(1.5);
  });

  it('treats a missing, negative, or unparseable hours value as zero', () => {
    for (const bad of [undefined, null, -50, NaN, 'nonsense', {}]) {
      expect(calculateWeight(bad)).toBeCloseTo(10, 6);
    }
  });

  /**
   * The assertion whose absence let the `total_hours` bug survive. It is about
   * the draw's behaviour, not about a function's return value, so no amount of
   * hand-built camelCase fixtures elsewhere can make it pass vacuously.
   */
  it('actually selects lower-hours volunteers more often', () => {
    const rate = selectionRate([
      { id: 'fresh', totalHours: 0 },
      { id: 'seasoned', totalHours: 400 },
    ], 1);
    expect(rate.fresh).toBeGreaterThan(rate.seasoned);
    /* Comfortably more often, not marginally — 10.0 against ~2.33 is roughly
       four to one, and a regression that flattened the curve would land near
       0.5 without this bound. */
    expect(rate.fresh).toBeGreaterThan(0.7);
  });
});

describe('the smoothed show-up rate', () => {
  it('returns the prior exactly when there is no recorded history', () => {
    expect(smoothedShowUpRate(0, 0)).toBeCloseTo(PRIOR_RATE, 10);
  });

  it('moves only a fraction of the way on a single observation', () => {
    /* 1 of 1 is 100% raw. Smoothed it is barely above the prior, which is the
       entire point: one shift is one data point. */
    const p = smoothedShowUpRate(1, 1);
    expect(p).toBeGreaterThan(PRIOR_RATE);
    expect(p).toBeLessThan(PRIOR_RATE + 0.05);
  });

  it('does not let a large sample be beaten by a tiny perfect one', () => {
    expect(smoothedShowUpRate(45, 50)).toBeGreaterThan(smoothedShowUpRate(1, 1));
  });

  it('treats one missed shift out of two gently', () => {
    /* 50% raw. Smoothed it is a mild dip, not a verdict. */
    const p = smoothedShowUpRate(1, 2);
    expect(p).toBeGreaterThan(0.7);
  });

  it('converges on the raw rate once the sample is large', () => {
    expect(smoothedShowUpRate(900, 1000)).toBeCloseTo(0.9, 2);
  });

  it('never divides by zero, and never exceeds one', () => {
    expect(Number.isFinite(smoothedShowUpRate(0, 0))).toBe(true);
    expect(smoothedShowUpRate(10, 5)).toBeLessThanOrEqual(1);
    expect(smoothedShowUpRate(-5, -5)).toBeGreaterThan(0);
  });

  it('uses the documented prior weight', () => {
    /* Pins the constant against the formula, so changing one without the other
       is caught rather than silently re-tuning the whole feature. */
    expect(smoothedShowUpRate(1, 1)).toBeCloseTo((1 + PRIOR_RATE * PRIOR_WEIGHT) / (1 + PRIOR_WEIGHT), 10);
  });
});

describe('the reliability multiplier', () => {
  /**
   * The property that makes the term safe to have shipped at all: on the day
   * this went live, nobody had a recorded history under the new definitions,
   * and nobody's odds changed.
   */
  it('is exactly neutral for a volunteer with no recorded attendance', () => {
    expect(reliabilityMultiplier(null)).toBe(1);
    expect(reliabilityMultiplier(undefined)).toBe(1);
    expect(reliabilityMultiplier({ attended: 0, recorded: 0 })).toBe(1);
  });

  it('rewards reliability, but barely', () => {
    const m = reliabilityMultiplier({ attended: 45, recorded: 50 });
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThan(1.03);
  });

  it('does not let one perfect shift beat a long strong record', () => {
    expect(reliabilityMultiplier({ attended: 1, recorded: 1 }))
      .toBeLessThan(reliabilityMultiplier({ attended: 45, recorded: 50 }));
  });

  it('penalises one missed shift out of two only slightly', () => {
    const m = reliabilityMultiplier({ attended: 1, recorded: 2 });
    expect(m).toBeLessThan(1);
    expect(m).toBeGreaterThan(0.95);
  });

  it('bounds even a total no-show record', () => {
    expect(reliabilityMultiplier({ attended: 0, recorded: 100 })).toBeGreaterThanOrEqual(0.95);
  });

  it('stays inside its bounds for every input', () => {
    for (let recorded = 0; recorded <= 200; recorded += 1) {
      for (const attended of [0, Math.floor(recorded / 2), recorded]) {
        const m = reliabilityMultiplier({ attended, recorded });
        expect(m).toBeGreaterThanOrEqual(0.95);
        expect(m).toBeLessThanOrEqual(1.03);
      }
    }
  });
});

describe('hours stay primary', () => {
  /**
   * THE guarantee, swept across the range rather than sampled at a point.
   *
   * Below 200 credited hours — eight times this district's 25-hour Silver
   * threshold, so every student the draw will ever actually weigh — a 50-hour
   * difference in hours beats any possible difference in attendance.
   *
   * The bound is real and is documented in weighting.js: the hours curve
   * flattens, so W(h)/W(h+50) decays toward 1 and crosses the multiplier's
   * span at roughly 225 hours. An earlier draft of this feature used wider
   * reliability bounds and claimed the property held everywhere; this sweep is
   * what proved it did not, from about 40 hours upward.
   *
   * Widening RELIABILITY_MIN/MAX, or flattening the hours curve, turns this
   * red — which is the only reason a second factor is safe to have.
   */
  it('never lets attendance reverse a 50-hour difference below 200 credited hours', () => {
    const BEST = { attended: 1000, recorded: 1000 };
    const WORST = { attended: 0, recorded: 1000 };

    for (let hours = 0; hours <= 200; hours += 1) {
      /* The volunteer with FEWER hours, saddled with the worst possible
         attendance, against the one with 50 more hours and a perfect record. */
      const fewerHours = applicantWeight({ totalHours: hours, attendance: WORST });
      const moreHours = applicantWeight({ totalHours: hours + 50, attendance: BEST });
      expect(fewerHours).toBeGreaterThan(moreHours);
    }
  });

  it('lets attendance decide between two volunteers with equal hours', () => {
    const reliable = applicantWeight({ totalHours: 40, attendance: { attended: 20, recorded: 20 } });
    const unreliable = applicantWeight({ totalHours: 40, attendance: { attended: 5, recorded: 20 } });
    expect(reliable).toBeGreaterThan(unreliable);
  });

  it('keeps the attendance swing smaller than a 50-hour swing in hours, up to 200', () => {
    const attendanceSwing = 1.03 / 0.95;
    /* Measured at the WORST point in the supported range — the ratio shrinks as
       hours rise, so 200 is where the guarantee is tightest. */
    const hoursSwingAt200 = calculateWeight(200) / calculateWeight(250);
    expect(attendanceSwing).toBeLessThan(hoursSwingAt200);
  });

  it('does not let a tiny sample meaningfully move the draw', () => {
    const rate = selectionRate([
      { id: 'perfect-tiny', totalHours: 20, attendance: { attended: 1, recorded: 1 } },
      { id: 'unknown', totalHours: 20, attendance: null },
    ], 1);
    /* Both near 50%: a single attended shift is worth about a percentage point,
       not an advantage. */
    expect(Math.abs(rate['perfect-tiny'] - rate.unknown)).toBeLessThan(0.05);
  });

  it('does not punish a volunteer whose attendance was never recorded', () => {
    const unrecorded = applicantWeight({ totalHours: 30, attendance: null });
    const neverShowedUp = applicantWeight({ totalHours: 30, attendance: { attended: 0, recorded: 4 } });
    expect(unrecorded).toBeGreaterThan(neverShowedUp);
    /* And is treated identically to somebody the system knows nothing about,
       rather than as a middling case. */
    expect(unrecorded).toBeCloseTo(calculateWeight(30), 10);
  });
});

describe('the draw itself', () => {
  it('is deterministic for a given seed', () => {
    const applicants = [
      { id: 'a', totalHours: 0 }, { id: 'b', totalHours: 10 },
      { id: 'c', totalHours: 60, attendance: { attended: 3, recorded: 4 } },
    ];
    const first = performWeightedSelection(applicants, 2, createRandom('event:slot:run-1'));
    const second = performWeightedSelection(applicants, 2, createRandom('event:slot:run-1'));
    expect(first).toEqual(second);
  });

  it('returns every applicant exactly once, across selected and waitlist', () => {
    const applicants = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, totalHours: i * 7 }));
    const { selectedIds, waitlistIds } = performWeightedSelection(applicants, 4, createRandom('s'));
    expect(selectedIds).toHaveLength(4);
    expect(waitlistIds).toHaveLength(8);
    expect(new Set([...selectedIds, ...waitlistIds]).size).toBe(12);
  });

  it('handles an empty pool and a zero-spot draw without throwing', () => {
    expect(performWeightedSelection([], 3, createRandom('s'))).toEqual({ selectedIds: [], waitlistIds: [] });
    const { selectedIds, waitlistIds } = performWeightedSelection(
      [{ id: 'a', totalHours: 1 }], 0, createRandom('s')
    );
    expect(selectedIds).toEqual([]);
    expect(waitlistIds).toEqual(['a']);
  });
});
