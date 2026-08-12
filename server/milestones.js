/**
 * Milestones — the derived half of this platform's recognition.
 *
 * ── The split, and why there are two systems ──
 *
 * `services/badgeService.js` owns the other half, and its header carries the
 * same boundary from the other side. In short:
 *
 *   MILESTONES (here) are DERIVED from the attendance ledger on every read and
 *   never stored. They cannot be wrong and cannot go stale — revoke an hour and
 *   the milestone is gone on the next request, with nothing to reconcile. They
 *   own every threshold that is a function of the service record: credited hours
 *   and distinct events.
 *
 *   BADGES are CONFERRED: a row, with a date, an optional `awarded_by`,
 *   revocable, and surviving in somebody's history after the definition behind
 *   it is retired. They own what a milestone cannot honestly express — a
 *   reliability ratio, organizer work, when somebody joined — and anything an
 *   administrator grants by hand.
 *
 * Both used to ship hour thresholds and both rendered on the volunteer profile:
 * a 25-hour "Silver Award" milestone beside a 50-hour "Community Champion"
 * badge, and a 10-hour milestone saying the same thing as a 10-hour "Helping
 * Hand" badge under a different name. A student could not tell which was the
 * real record of their service. `scripts/seed_badges.js` retires the badge side
 * of that overlap; this module is the side that keeps it.
 *
 * ── Why this is a module and not an array in a route handler ──
 *
 * It was `MILESTONE_TIERS` inline in `routes/userRoutes.js`, and an exported
 * byte-for-byte duplicate in `utils.js` that nothing imported. Two copies of the
 * hour thresholds a student's service record is judged against — including the
 * district's Silver Award — which diverge silently: whoever next raised the
 * target had even odds of editing the copy nobody calls, shipping a change that
 * appeared to work because the page and the tests both read the other one.
 *
 * There is now one definition, in a module, with tests. Same rule as
 * `hoursLedger.js` and `weighting.js`: domain logic does not live in a handler.
 *
 * ── Thresholds are DATA, not closures ──
 *
 * Each tier declares `metric` and `threshold` instead of carrying a `test`
 * function. Three things follow, and all three were problems before:
 *
 *   1. A tier can be SERIALISED. `VolunteerProfile.jsx` and
 *      `VolunteerDashboard.jsx` each hardcoded `const HOUR_GOAL = 25` — a third
 *      and fourth copy of the Silver threshold, in a different language, where
 *      nothing could check them against the server that decides `earned`. The
 *      meter could say "8 hours to go" beside a milestone rendered as earned.
 *      The threshold now travels in the payload.
 *   2. A test can assert the LADDER — that tiers ascend within a metric — which
 *      is not expressible over opaque functions and is the one property that
 *      makes "next milestone" meaningful.
 *   3. The comparison is written once, so a tier cannot accidentally use `>`
 *      where its neighbours use `>=`.
 */

/** The metrics a milestone may be a function of. Both come from `attendance`. */
export const MILESTONE_METRICS = Object.freeze(['hours', 'events']);

/**
 * Every milestone, in ascending order of the effort it represents.
 *
 * ── These mark service ALREADY COMPLETED ──
 *
 * They are not targets to chase and there are no points. Each one is either
 * earned or it is not. The ordering exists so a reader can see where they are,
 * not to imply an obligation to reach the end of it.
 *
 * This used to say "and there is no streak", which is no longer true — see
 * `buildStreak` in volunteerInsights.js. The distinction it was drawing still
 * holds, though, and is worth restating: a milestone is a threshold crossed by
 * service already completed, and nothing about it can be lost. A streak is a
 * separate, non-punitive continuity signal, counted in whole months so that an
 * exam week, a holiday or an illness cannot break it, and hidden entirely below
 * two months so it never reads as a scoreboard opening in front of somebody who
 * has volunteered once.
 *
 * `hours` is credited hours — `SUM(hours_awarded) WHERE present = 1`, the same
 * derivation as everywhere else (INV-001). `events` is DISTINCT events, not
 * shifts: two shifts at one event is one commitment, and counting it as two
 * would turn a breadth measure into an attendance measure. `badgeService`'s
 * `collectStats` had exactly that bug and it was fixed for the same reason.
 */
export const MILESTONE_TIERS = Object.freeze([
  {
    id: 'first-shift',
    label: 'First shift',
    hint: 'Completed your first volunteer shift',
    metric: 'events',
    threshold: 1,
  },
  {
    id: 'ten-hours',
    label: '10 hours',
    hint: 'Ten hours of service',
    metric: 'hours',
    threshold: 10,
  },
  {
    id: 'five-events',
    label: '5 events',
    hint: 'Helped at five different events',
    metric: 'events',
    threshold: 5,
  },
  {
    /**
     * The district's Silver Award, and the only tier named after something
     * outside this platform.
     *
     * That is why it is the one the progress meter is drawn against: it is a
     * target a student is measured by somewhere else, so it is the number they
     * actually care about their distance from. `SERVICE_HOUR_GOAL` below is
     * derived from this row rather than restated, so the meter and the milestone
     * cannot disagree about what Silver means.
     */
    id: 'silver',
    label: 'Silver Award',
    hint: '25 hours — the district Silver Award target',
    metric: 'hours',
    threshold: 25,
  },
  {
    id: 'fifty-hours',
    label: '50 hours',
    hint: 'Fifty hours of service',
    metric: 'hours',
    threshold: 50,
  },
  {
    id: 'ten-events',
    label: '10 events',
    hint: 'Helped at ten different events',
    metric: 'events',
    threshold: 10,
  },
  {
    id: 'century',
    label: '100 hours',
    hint: 'One hundred hours of service',
    metric: 'hours',
    threshold: 100,
  },
]);

/**
 * The hours figure the client draws its progress meter against.
 *
 * DERIVED from the Silver tier, never restated. This replaced
 * `const HOUR_GOAL = 25` in two client views, and the point of deriving it is
 * that raising the Silver threshold moves the meter with it — under the previous
 * arrangement it moved neither, and the two disagreed silently.
 */
export const SERVICE_HOUR_GOAL = MILESTONE_TIERS.find(t => t.id === 'silver').threshold;

/**
 * Which milestones a service record has reached.
 *
 * Returns EVERY tier with an `earned` flag rather than only the earned ones, and
 * carries `metric` and `threshold` out to the caller, so a client can render the
 * ladder — and its own distance along it — without holding a second copy of any
 * number in this file.
 *
 * Both inputs are coerced and floored at zero. They arrive from `SUM()` and
 * `COUNT()`, so `hours` is null on an empty ledger rather than 0, and a null
 * compared with `>=` is not the false a reader expects — `null >= 0` is true, so
 * an untouched account would have earned `first-shift` at zero events.
 */
export function buildMilestones(hours, events) {
  const reached = {
    hours: Math.max(0, Number(hours) || 0),
    events: Math.max(0, Number(events) || 0),
  };

  return MILESTONE_TIERS.map(tier => ({
    id: tier.id,
    label: tier.label,
    hint: tier.hint,
    metric: tier.metric,
    threshold: tier.threshold,
    earned: reached[tier.metric] >= tier.threshold,
  }));
}
