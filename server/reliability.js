import { PRIOR_RATE, PRIOR_WEIGHT, smoothedShowUpRate } from './weighting.js';

/**
 * The one answer to "does this volunteer turn up?".
 *
 * ── Why this module exists ──
 *
 * The question was being answered three ways that disagreed with each other.
 *
 *   · `badgeService.collectStats` counted SHIFTS and included cancelled events,
 *     then divided: `(present / signups) * 100`.
 *   · `attendanceRecordsFor` counted distinct EVENTS with `MAX(present)` and
 *     excluded cancelled ones, then fed `smoothedShowUpRate`.
 *   · `ApplicantReview` gated its display on three completed commitments, while
 *     the badge gated on five and the smoother's prior assumed a fourth number.
 *
 * So the "Reliable Volunteer" badge and Auto Select could reach opposite
 * conclusions about the same person on the same afternoon, and the badge's own
 * description — "turned up for at least 90% of the shifts you signed up for" —
 * was a promise the raw ratio behind it did not keep.
 *
 * Everything now derives from `summarise()` below.
 *
 * ── The problem a plain percentage cannot solve ──
 *
 * Volunteer A signed up for 1,000 commitments and attended 900. Volunteer B
 * signed up for 10 and attended 10. A plain percentage says 90% and 100%, so B
 * looks better — despite A having turned up nine hundred times and B nine.
 *
 * Bayesian smoothing already fixes half of that: a small sample is pulled
 * toward the prior, so B's ten-for-ten reads as "probably good, not certain",
 * while A's thousand records overwhelm the prior and stand on their own. That
 * is `smoothedShowUpRate`, and it is reused here rather than reinvented.
 *
 * What it does NOT fix is *when* the misses happened. A volunteer with a bad
 * first term and a flawless year since is not the same as one who has missed
 * their last four, and a lifetime ratio cannot tell them apart. So this adds
 * recency weighting on top, and nothing else.
 *
 * ── The shape of the recency weight ──
 *
 * Each completed commitment carries a weight that decays geometrically with
 * how many commitments ago it was — NOT with elapsed time. A volunteer who
 * serves twice a year should not have their record silently forgotten for being
 * infrequent; what should fade is a miss they have since worked past. Counting
 * in commitments rather than days is what makes recovery something a volunteer
 * can *do* rather than something they wait out.
 *
 * `RECENCY_HALF_LIFE` commitments back, a record counts half as much. Older
 * evidence is never discarded — the weight approaches zero but never reaches
 * it, so a thousand-commitment history still outweighs a ten-commitment one.
 */

/**
 * How many commitments back a record counts half as much.
 *
 * Eight puts the owner's "last 10-20 completed commitments" window at roughly
 * 60-80% of the total weight, without a hard cutoff that would let the
 * eleventh-most-recent miss vanish overnight.
 */
export const RECENCY_HALF_LIFE = 8;

/**
 * Completed commitments required before the model will call anybody reliable.
 *
 * ── Why one number replaces three ──
 *
 * There were three: the badge's five-signup floor, the applicant row's
 * three-commitment floor, and the smoother's prior weight of five. The first
 * two were arbitrary; the third is a real statistical statement. Four is chosen
 * to sit just under `PRIOR_WEIGHT`, so the badge can only be earned once the
 * evidence is starting to outweigh the assumption behind it rather than merely
 * matching it.
 *
 * Below this, `summarise()` reports `hasEnoughEvidence: false` and every
 * consumer shows "new volunteer" rather than a verdict. One missed shift out of
 * one is not a pattern.
 */
export const MIN_EVIDENCE = 4;

/**
 * The smoothed, recency-weighted rate at which a volunteer is called reliable.
 *
 * The owner asked for "over 90%", and this is a strict `>`. Note it is applied
 * to the SMOOTHED rate, so it is harder than a raw 90% at small samples and
 * easier at large ones — which is the point: four-for-four is not the same
 * evidence as four hundred-for-four hundred, and a threshold that treats them
 * identically is the thing being fixed.
 */
export const RELIABLE_THRESHOLD = 0.9;

/**
 * A commitment that has come due: attended, or missed, or still unconfirmed.
 *
 * @typedef {{ present: 0|1|null, occurredAt: string }} Commitment
 */

/**
 * Weight for a record `index` positions back from the most recent.
 *
 * Geometric decay, so the ratio between consecutive records is constant and
 * there is no cliff anywhere for somebody to fall off.
 */
export function recencyWeight(index, halfLife = RECENCY_HALF_LIFE) {
  return 0.5 ** (index / halfLife);
}

/**
 * Reduces a volunteer's completed commitments to the numbers every surface uses.
 *
 * @param {Commitment[]} commitments newest first; `present: null` means the
 *   organizer never confirmed, which is a fact about the organizer and is
 *   excluded from the denominator entirely.
 * @returns {{
 *   recorded: number, attended: number, absent: number, awaitingRecord: number,
 *   rate: number, weightedRate: number, score: number,
 *   hasEnoughEvidence: boolean, isReliable: boolean,
 *   lastAttendedAt: string|null,
 * }}
 */
export function summarise(commitments) {
  const list = Array.isArray(commitments) ? commitments.filter(Boolean) : [];

  let attended = 0;
  let absent = 0;
  let awaitingRecord = 0;
  let lastAttendedAt = null;

  /* Weighted sums are accumulated over CONFIRMED records only, and the index
     used for decay counts confirmed records too — otherwise a run of
     unconfirmed shifts would push a volunteer's real history into the past and
     quietly discount it for something they did not do. */
  let weightedHits = 0;
  let weightedTotal = 0;
  let confirmedIndex = 0;

  for (const record of list) {
    if (record.present === null || record.present === undefined) {
      awaitingRecord += 1;
      continue;
    }

    const present = Number(record.present) === 1;
    if (present) {
      attended += 1;
      if (record.occurredAt && (!lastAttendedAt || record.occurredAt > lastAttendedAt)) {
        lastAttendedAt = record.occurredAt;
      }
    } else {
      absent += 1;
    }

    const weight = recencyWeight(confirmedIndex);
    weightedTotal += weight;
    if (present) weightedHits += weight;
    confirmedIndex += 1;
  }

  const recorded = attended + absent;

  /* The plain smoothed rate, kept because it is what Auto Select has always
     used and what `weighting.test.js` pins the dominance guarantee against. */
  const rate = smoothedShowUpRate(attended, recorded);

  /**
   * The recency-weighted rate: what share of a volunteer's record they have
   * turned up for, counting recent commitments more heavily.
   *
   * A mean of the outcomes, NOT a sum of weights — the distinction matters.
   * Weights decay, so for a 26-commitment history they sum to about 9.75. Had
   * the prior been added in weight units it would have counted as a third of
   * that volunteer's entire life, and somebody who recovered through twenty
   * consecutive attendances would still have been held under the threshold by
   * an assumption. Recency decides the RATE; the number of records decides how
   * far that rate is trusted, and those are two separate questions.
   */
  const weightedMean = weightedTotal > 0 ? weightedHits / weightedTotal : PRIOR_RATE;

  const weightedRate = recorded === 0
    ? PRIOR_RATE
    : (weightedMean * recorded + PRIOR_RATE * PRIOR_WEIGHT) / (recorded + PRIOR_WEIGHT);

  /**
   * The score every surface reads.
   *
   * The recency-weighted rate, and only that.
   *
   * An earlier draft took `min(rate, weightedRate)`, reasoning that a volunteer
   * should have to satisfy both. The simulation showed what that actually does:
   * it makes the lifetime ratio a permanent ceiling. Volunteer A — a thousand
   * commitments, nine hundred attended, every miss years old and every recent
   * shift worked — sat at exactly 0.8998 and was refused, which is the precise
   * unfairness this model was built to remove. It also made recovery
   * impossible, because no amount of recent attendance can lift a lifetime
   * ratio quickly.
   *
   * The weighted rate already accounts for history: every record contributes,
   * older ones just contribute less. So it handles both directions on its own —
   * a strong past with a bad present falls, and a bad past with a strong
   * present rises. Taking the minimum only re-imposed the unweighted number the
   * weighting existed to replace.
   */
  const score = weightedRate;

  const hasEnoughEvidence = recorded >= MIN_EVIDENCE;

  return {
    recorded,
    attended,
    absent,
    awaitingRecord,
    rate: round(rate),
    weightedRate: round(weightedRate),
    score: round(score),
    hasEnoughEvidence,
    isReliable: hasEnoughEvidence && score > RELIABLE_THRESHOLD,
    lastAttendedAt,
  };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Completed commitments per volunteer, newest first, with dates.
 *
 * ── Why this query and not one of the existing ones ──
 *
 * Neither `attendanceRecordsFor` nor `participationCountsFor` carries a date —
 * both are aggregates — and `attendance` has no timestamp column of its own.
 * Time has to come from `slots.end_datetime` through a join, which is the same
 * route `attendanceMonths` already takes.
 *
 * The grain is the EVENT, collapsed with `MAX(present)`, matching
 * `attendanceRecordsFor`: somebody who worked one shift of a festival and
 * missed another attended that event. Cancelled events are excluded on both
 * sides — a volunteer turned up to nothing because there was nothing to turn up
 * to.
 *
 * A commitment whose shift has ended but which no organizer ever confirmed
 * arrives with `present: null`. It is counted as awaiting a record and kept out
 * of the denominator, because an organizer who never got round to closing an
 * event must not thereby mark a student unreliable.
 *
 * Batched over many users in one query, because the organizer's applicant list
 * needs this for every row and a per-row call is the N+1 that turns a
 * 40-applicant draw into 40 round trips.
 *
 * @returns {Map<string, Commitment[]>}
 */
export async function commitmentsFor(db, userIds, { now = new Date().toISOString() } = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;

  const placeholders = ids.map(() => '?').join(',');

  /* Driven by `idx_applications_user_status`; the joins are primary-key
     lookups. `a.status = 'accepted'` and the ended-shift bound are the same
     DUE_COMMITMENTS definition `volunteerStats` uses, so the two cannot
     disagree about what a commitment is. */
  const rows = await db.prepare(`
    SELECT a.user_id                AS "userId",
           a.event_id               AS "eventId",
           MAX(s.end_datetime)      AS "occurredAt",
           MAX(at.present)          AS present
    FROM applications a
    JOIN slots  s ON s.id = a.slot_id
    JOIN events e ON e.id = a.event_id
    LEFT JOIN attendance at ON at.slot_id = a.slot_id AND at.user_id = a.user_id
    WHERE a.user_id IN (${placeholders})
      AND a.status = 'accepted'
      AND e.status <> 'cancelled'
      AND s.end_datetime <= ?
    GROUP BY a.user_id, a.event_id
    ORDER BY occurredAt DESC
  `).all(...ids, now);

  for (const row of rows) {
    if (!out.has(row.userId)) out.set(row.userId, []);
    out.get(row.userId).push({
      present: row.present === null || row.present === undefined ? null : Number(row.present),
      occurredAt: row.occurredAt,
      eventId: row.eventId,
    });
  }

  return out;
}

/** The canonical summary for many volunteers at once. */
export async function reliabilityFor(db, userIds, options = {}) {
  const commitments = await commitmentsFor(db, userIds, options);
  const out = new Map();
  for (const [userId, list] of commitments) out.set(userId, summarise(list));
  return out;
}

/** The canonical summary for one volunteer. */
export async function reliabilityOf(db, userId, options = {}) {
  return (await reliabilityFor(db, [userId], options)).get(userId) ?? summarise([]);
}
