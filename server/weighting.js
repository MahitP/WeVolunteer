/**
 * Service Hours Weighting & Selection Module
 *
 * This module is isolated so that the weighting curve and pseudo-random selection
 * parameters can easily be inspected, tested, and tuned in the future.
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
 * @param {Array} applicants - Array of objects: { id: string, totalHours: number }
 * @param {number} spots - Number of accepted spots to fill
 * @param {function} randomFn - Seeded PRNG function
 * @returns {object} { selectedIds: string[], waitlistIds: string[] }
 */
export function performWeightedSelection(applicants, spots, randomFn) {
  const pool = [...applicants];
  const ordered = [];

  while (pool.length > 0) {
    // Compute current weights for all remaining pool elements
    const weights = pool.map(a => calculateWeight(a.totalHours));
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
