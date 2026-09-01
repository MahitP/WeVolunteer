/**
 * When two shifts clash — one definition of it, for every caller that decides.
 *
 * ── Why this is a module and not three queries ──
 *
 * Three places in the platform ask "is this person already somewhere else at
 * that time": the apply-time warning in `applicationRoutes`, the Auto Select
 * draw, and waitlist promotion. They ask it for different reasons and act on it
 * differently — the first warns a human who may override, the other two are
 * automatic and have nobody to ask. What they must NOT differ on is where the
 * boundary of a clash is. Two shifts that the warning calls back-to-back and
 * the draw calls a conflict would make the platform contradict itself about the
 * same pair of times, and the student would have been told the first answer.
 *
 * So the predicate lives here once, as SQL, and the callers interpolate it.
 * What each caller decides — which statuses count, whether cancelled events
 * count, and what to do about it — stays with the caller, because those really
 * are different questions per caller and pretending otherwise would need a
 * parameter for each and would be one function doing three jobs.
 */

/**
 * The overlap predicate, over a `slots` row that the caller has aliased `s`.
 *
 * Two shifts overlap when each starts before the other ends. Written with
 * STRICT inequalities, which is the entire content of the boundary case:
 * 09:00–11:00 and 11:00–13:00 do not overlap, because a volunteer finishing one
 * shift as another begins is doing two shifts, not being in two places.
 *
 * Takes two bind parameters, in this order: the candidate shift's END, then its
 * START. Put it last in a WHERE clause and pass them last.
 */
export const OVERLAPS_SHIFT_SQL = 's.start_datetime < ? AND s.end_datetime > ?';

/**
 * The same rule in JavaScript, for callers that already hold both pairs of
 * times and would otherwise re-derive it by hand.
 *
 * ISO-8601 strings in a fixed offset compare correctly as strings, which is why
 * the SQL above can compare them directly and why this does too — the two are
 * the same comparison, and `shiftOverlap.test.js` asserts they agree.
 */
export function shiftsOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

/**
 * Which of these people are already ACCEPTED to a shift that clashes with this
 * one.
 *
 * ── Only `accepted`, deliberately ──
 *
 * A pending or waitlisted row elsewhere is a request, not a place. Counting it
 * would let an application a student may never be given keep them out of one
 * they would be — and the two automatic callers would then be able to lock
 * somebody out of every shift they applied to. Only a place actually held means
 * the student is spoken for.
 *
 * This is narrower than the apply-time warning, which counts all three statuses
 * on purpose: that one is advice to a human who can weigh it and override, and
 * "you have also applied for something then" is worth saying. Refusing a seat
 * over it, with nobody deciding, is not.
 *
 * ── Cancelled events are not held time ──
 *
 * A called-off event holds nobody's afternoon, and keeping a student out of a
 * shift they are free for because of one would be a penalty for somebody else's
 * decision. This is the same exclusion `attendanceRecordsFor`, the credited
 * hours subquery in `computeDraw` and the pending-application quota all make,
 * for the same reason.
 *
 * ── One query, not one per person ──
 *
 * Both callers hold a whole pool — every pending applicant on a slot, or the
 * whole waitlist queue — and both already batch their other pool-wide reads for
 * exactly this reason. The set is bounded by the applications on one slot.
 *
 * @param {object} db a database handle
 * @param {string[]} userIds the pool to check
 * @param {{id: string, start_datetime: string, end_datetime: string}} slot the
 *   shift being given out; its own applications are excluded by `id`
 * @returns {Promise<Set<string>>} the user ids that clash
 */
export async function usersWithClashingAcceptance(db, userIds, slot) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Set();

  /* Defensive, though both columns are NOT NULL in both schemas: without times
     there is no question to answer, and inventing one would refuse people. */
  if (!slot?.start_datetime || !slot?.end_datetime) return new Set();

  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT DISTINCT a.user_id
    FROM applications a
    JOIN slots s ON s.id = a.slot_id
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id IN (${placeholders})
      AND a.status = 'accepted'
      AND a.slot_id <> ?
      AND e.status <> 'cancelled'
      AND ${OVERLAPS_SHIFT_SQL}
  `).all(...ids, slot.id, slot.end_datetime, slot.start_datetime);

  return new Set(rows.map(r => r.user_id));
}
