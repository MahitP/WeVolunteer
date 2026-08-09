/**
 * Service Hours Weighting & Selection Module
 *
 * This module is isolated so that the weighting curve and pseudo-random selection
 * parameters can easily be inspected, tested, and tuned in the future.
 *
 * ── What the draw is for ──
 *
 * Auto Select exists to spread opportunity, not to rank students. The hours
 * curve is the whole of that: a volunteer with fewer credited hours is more
 * likely to be drawn. v1.3 adds a second, deliberately much smaller term for
 * attendance reliability, and the sections below are as much about the bounds
 * on that term as about the term itself.
 *
 * ── Only CREDITED hours enter this file ──
 *
 * `external_hours` is self-attested and never reaches the draw. If it did, the
 * cheapest way to improve your odds of being selected would be to type a large
 * number into a form — and since the curve rewards FEWER hours, the cheapest
 * way would actually be to type a number into somebody else's. Either way the
 * draw would be gameable by assertion. Credited hours come from an organizer
 * confirming attendance, which is why they are the only ones here.
 */

/**
 * Calculates a selection weight based on a student's total volunteer hours.
 * Uses a rational decay (reciprocal) curve: W(h) = 1.5 + 8.5 / (1.0 + 0.005 * hours).
 *
 * - A brand-new volunteer (0 hours) gets the maximum weight of 10.0.
 * - An experienced volunteer (e.g. 500+ hours) gets a weight that smoothly
 *   approaches 1.5 but never hits a flat floor.
 * - Ensures that students with different hours never receive identical weights,
 *   while guaranteeing that highly active volunteers always remain competitive.
 *
 * @param {number} hours - Total service hours credited to the user
 * @returns {number} The weight (higher weight = higher selection probability)
 */
export function calculateWeight(hours) {
  const h = Math.max(0, Number(hours) || 0);
  return 1.5 + 8.5 / (1.0 + 0.005 * h);
}

/* ── The attendance reliability term ─────────────────────────────────────────
 *
 * An organizer who holds twenty places and has six people not turn up has a
 * real problem, and the draw is the only lever the platform has on it. But a
 * raw show-up percentage is a terrible instrument, for two reasons that pull in
 * opposite directions:
 *
 *   - 1 signup, 1 attended is 100%. It is also one data point. It must not beat
 *     45 out of 50, which is a far stronger claim about the same person.
 *   - 2 signups, 1 attended is 50%. It is also one missed shift, which for a
 *     fifteen-year-old is a bus, a parent, or a bad week. It must not be
 *     treated as evidence of a habit.
 *
 * Both are the same statistical mistake — reading a small sample as if it were
 * a large one — so both get the same fix. The rate is smoothed toward a prior
 * with a pseudo-count, which is the standard Bayesian treatment:
 *
 *     p = (attended + PRIOR_RATE * PRIOR_WEIGHT) / (recorded + PRIOR_WEIGHT)
 *
 * PRIOR_WEIGHT = 5 means "start everyone with five imaginary shifts at the
 * platform-typical rate". A first real shift then moves the estimate by about a
 * sixth of the way, and it takes a genuine pattern to move it far.
 */

/** The rate a volunteer with no history is assumed to have. */
export const PRIOR_RATE = 0.85;

/** How many pseudo-observations that assumption is worth. */
export const PRIOR_WEIGHT = 5;

/** How hard the smoothed rate is allowed to push the weight. */
const RELIABILITY_SLOPE = 0.35;

/**
 * The hard bounds on the reliability multiplier.
 *
 * These two numbers ARE the guarantee that hours stay primary, and they were
 * derived against the hours curve rather than chosen by feel.
 *
 * The widest swing attendance can produce is RMAX/RMIN = 1.03 / 0.95 = 1.084.
 * For that to be unable to reverse a 50-hour difference in credited hours, the
 * curve's own ratio W(h) / W(h+50) has to stay above it. That ratio is not
 * constant — the curve flattens, so it starts at W(0)/W(50) = 1.205 and decays
 * toward 1 as hours grow. It crosses 1.084 at roughly 225 credited hours.
 *
 * So the honest, tested property is bounded, and stated as such:
 *
 *   **Below 200 credited hours, a 50-hour difference in hours outweighs any
 *   possible difference in attendance.**
 *
 * Two hundred hours is eight times this district's Silver Award threshold
 * (SERVICE_HOUR_GOAL = 25), so it covers every student the draw will ever
 * actually weigh. Above it the two factors become comparable — which is the
 * correct behaviour anyway, since at that point the hours curve is nearly flat
 * and is no longer expressing much of a preference to preserve.
 *
 * The first draft of this used [0.90, 1.05] and claimed the guarantee held
 * everywhere. It did not: it failed from about 40 hours upward, and the test
 * below caught it. The bounds are tight because the claim is precise; widening
 * them, or narrowing the hours curve, fails the build rather than quietly
 * making attendance the dominant term.
 */
const RELIABILITY_MIN = 0.95;
const RELIABILITY_MAX = 1.03;

/**
 * The smoothed show-up rate. Exported because it is what the profile and the
 * organizer-facing explanation should quote — a raw attended/signedUp is the
 * number this function exists to stop anybody using.
 *
 * `recorded` is attended + absent: outcomes an organizer actually recorded. A
 * shift whose attendance was never confirmed is in NEITHER, so an organizer
 * who forgets to close out an event cannot make their volunteers look
 * unreliable. That is the "missing attendance is not absence" rule, enforced at
 * the one place the number is computed.
 */
export function smoothedShowUpRate(attended, recorded) {
  const a = Math.max(0, Number(attended) || 0);
  const n = Math.max(0, Number(recorded) || 0);
  /* A caller that passes attended > recorded is confused; clamping beats
     returning a rate above 1 and letting it propagate into the multiplier. */
  const hits = Math.min(a, n);
  return (hits + PRIOR_RATE * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT);
}

/**
 * The multiplier applied to the hours weight.
 *
 * Centred on the prior, so a volunteer with no recorded history gets exactly
 * 1.0 and is neither helped nor harmed. That is the property that makes the
 * term safe to add: it changes nothing for anybody the platform knows nothing
 * about, including every volunteer on the day this shipped.
 *
 *   no history      → 1.000   (unchanged)
 *   1 of 1          → 1.009   (a nudge, not a prize)
 *   45 of 50        → 1.016   (a stronger claim, still a nudge)
 *   1 of 2          → 0.965   (mild, as one missed shift should be)
 *   0 of 10         → 0.950   (floored — a real pattern, bounded anyway)
 */
export function reliabilityMultiplier(record) {
  if (!record || !record.recorded) return 1;
  const p = smoothedShowUpRate(record.attended, record.recorded);
  const raw = 1 + RELIABILITY_SLOPE * (p - PRIOR_RATE);
  return Math.min(RELIABILITY_MAX, Math.max(RELIABILITY_MIN, raw));
}

/**
 * The complete selection weight: the hours curve, nudged by reliability.
 *
 * @param {{totalHours:number, attendance?:{attended:number, recorded:number}}} applicant
 */
export function applicantWeight(applicant) {
  return calculateWeight(applicant?.totalHours) * reliabilityMultiplier(applicant?.attendance);
}

/**
 * Mulberry32 Seedable Pseudo-Random Number Generator.
 * Used to ensure weighted random selections are fully reproducible and auditable
 * for a single selection run (seeded with unique event + slot ID combination).
 *
 * @param {string} seedString - Unique identifier to seed the generator
 * @returns {function} A PRNG function returning values in [0, 1)
 */
export function createRandom(seedString) {
  let h = 0;
  for (let i = 0; i < seedString.length; i++) {
    h = Math.imul(31, h) + seedString.charCodeAt(i) | 0;
  }
  return function() {
    let t = h += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Performs a weighted random selection without replacement.
 * Continues to draw applicants until all slots are filled.
 * Remaining drawn applicants form the waitlist order.
 *
 * @param {Array} applicants - Array of objects:
 *   { id: string, totalHours: number, attendance?: { attended, recorded } }
 * @param {number} spots - Number of accepted spots to fill
 * @param {function} randomFn - Seeded PRNG function
 * @returns {object} { selectedIds: string[], waitlistIds: string[] }
 */
export function performWeightedSelection(applicants, spots, randomFn) {
  const pool = [...applicants];
  const ordered = [];

  while (pool.length > 0) {
    // Compute current weights for all remaining pool elements
    const weights = pool.map(a => applicantWeight(a));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    if (totalWeight <= 0) {
      // Fallback: simple random selection if total weight is 0
      const idx = Math.floor(randomFn() * pool.length);
      ordered.push(pool[idx]);
      pool.splice(idx, 1);
      continue;
    }

    const r = randomFn() * totalWeight;
    let cumulative = 0;
    let selectedIndex = 0;

    for (let i = 0; i < pool.length; i++) {
      cumulative += weights[i];
      if (cumulative >= r) {
        selectedIndex = i;
        break;
      }
    }

    ordered.push(pool[selectedIndex]);
    pool.splice(selectedIndex, 1);
  }

  const selectedIds = ordered.slice(0, spots).map(a => a.id);
  const waitlistIds = ordered.slice(spots).map(a => a.id);

  return { selectedIds, waitlistIds };
}
