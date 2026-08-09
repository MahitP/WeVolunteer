/**
 * Volunteer participation statistics.
 *
 * Derived on every read, never stored. Same rule as credited hours, and for the
 * same reason: a stored count is a second source of truth that drifts the first
 * time a row is deleted by a cascade nobody remembered, and the number it drifts
 * into is one a student will be judged on.
 *
 * ── The definitions, and why each one is drawn where it is ──
 *
 * These are not arbitrary. Each boundary below was chosen against the existing
 * lifecycle in applicationRoutes.js and attendanceRoutes.js, so that the counts
 * describe what actually happened rather than what the schema happens to record.
 *
 * **Signed up** — a commitment that came due. An application with status
 * 'accepted', on an event that was not cancelled, for a shift that has now
 * ended.
 *
 *   - Pending, waitlisted and rejected do NOT count. None of them is a promise
 *     the volunteer made; being turned down is not something to answer for, and
 *     counting it would let an organizer's selection decision damage a
 *     student's public record.
 *   - Withdrawn does NOT count. The API refuses to withdraw an accepted
 *     application once the shift has started (applicationRoutes.js), so a
 *     withdrawal is by construction a place that was given back in time for
 *     somebody else to take. Penalising that would teach students to no-show
 *     instead of withdrawing, which is strictly worse for the organizer.
 *   - A CANCELLED event does not count, on either side. The volunteer turned up
 *     to nothing because there was nothing to turn up to.
 *   - A shift that has not ended yet does not count. It is a commitment, not
 *     yet an outcome; it appears as "upcoming", never in the denominator.
 *
 * **Attended** — an attendance row with present = 1, counted once per event.
 * The organizer's record, not the signup. Check-in is explicitly not enough:
 * `attendance_checkin` is a scanner convenience, and hours confirmation is the
 * step where somebody takes responsibility for the statement.
 *
 * **Absent** — an attendance row with present = 0 and no present = 1 row for
 * the same event.
 *
 * **Awaiting record** — signed up, the shift has ended, and the organizer has
 * not confirmed attendance yet. This is the number that exists so that missing
 * attendance is never silently read as absence. It is shown to the volunteer,
 * excluded from the show-up rate's denominator, and excluded from Auto Select's
 * reliability term. An organizer who never gets round to confirming attendance
 * must not thereby mark a student unreliable.
 *
 * So: signedUp = attended + absent + awaitingRecord, exactly.
 *
 * ── What is NOT in here ──
 *
 * External hours. A self-reported record of service done elsewhere is not a
 * WeVolunteer signup and there is no attendance record behind it, so it enters
 * neither count. It is surfaced separately and labelled as what it is.
 */

/**
 * The one definition of "a commitment that came due", as a SQL fragment.
 *
 * Written once and interpolated into both queries below so the two can never
 * disagree about what is being counted. Takes `?` for the user id and `?` for
 * the current time, in that order.
 */
const DUE_COMMITMENTS = `
  FROM applications a
  JOIN slots  s ON s.id = a.slot_id
  JOIN events e ON e.id = a.event_id
  WHERE a.user_id = ?
    AND a.status = 'accepted'
    AND e.status <> 'cancelled'
    AND s.end_datetime <= ?
`;

/**
 * Participation counts for one volunteer.
 *
 * One query per figure, each an indexed aggregate — never a row scan the caller
 * then counts in JavaScript. `idx_applications_user_status` and
 * `idx_attendance_user` are what keep this cheap enough to run on a profile
 * page that any member can open about any other member.
 *
 * @returns {{eventsSignedUp:number, eventsAttended:number, eventsAbsent:number,
 *            eventsAwaitingRecord:number, hoursCredited:number,
 *            lastVolunteeredAt:string|null}}
 */
export function volunteerStats(db, userId, { now = new Date().toISOString() } = {}) {
  const signedUp = db.prepare(`
    SELECT COUNT(DISTINCT a.event_id) AS n ${DUE_COMMITMENTS}
  `).get(userId, now)?.n ?? 0;

  /**
   * Attendance is keyed by (slot, user) but the statistic is about events, so
   * both sides collapse to distinct events. A volunteer who worked two shifts
   * of the same festival attended one event, and — importantly — a volunteer
   * who made one shift and missed another is counted as having attended, not as
   * both attended and absent. MAX(present) is what expresses that: any present
   * shift makes the event attended.
   */
  const outcome = db.prepare(`
    SELECT
      SUM(CASE WHEN best = 1 THEN 1 ELSE 0 END) AS attended,
      SUM(CASE WHEN best = 0 THEN 1 ELSE 0 END) AS absent
    FROM (
      SELECT at.event_id, MAX(at.present) AS best
      FROM attendance at
      JOIN events e ON e.id = at.event_id
      WHERE at.user_id = ? AND e.status <> 'cancelled'
      GROUP BY at.event_id
    )
  `).get(userId) ?? {};

  const eventsAttended = outcome.attended ?? 0;
  const eventsAbsent = outcome.absent ?? 0;

  /**
   * Clamped at zero rather than trusted to be non-negative.
   *
   * The identity holds for every path the application offers, but attendance
   * can outlive the application it came from — a slot can be removed from an
   * event, and `PUT /api/events/:id` deletes the applications for a removed
   * slot while deliberately refusing to touch attendance. A profile is the
   * wrong place to discover that, and "awaiting: -1" is a worse answer than a
   * slightly conservative zero.
   */
  const eventsAwaitingRecord = Math.max(0, signedUp - eventsAttended - eventsAbsent);

  const hours = db.prepare(`
    SELECT COALESCE(SUM(hours_awarded), 0) AS h
    FROM attendance WHERE user_id = ? AND present = 1
  `).get(userId)?.h ?? 0;

  return {
    eventsSignedUp: signedUp,
    eventsAttended,
    eventsAbsent,
    eventsAwaitingRecord,
    hoursCredited: Number(hours.toFixed ? hours.toFixed(2) : hours),
    lastVolunteeredAt: lastVolunteeredAt(db, userId),
  };
}

/**
 * When this account last actually volunteered — not when it last signed in.
 *
 * A login timestamp is behavioural surveillance dressed as a statistic: it says
 * how often somebody opens the app, which is nobody else's business and is
 * exactly the sort of "last active" a public profile should not carry. What a
 * reader of a volunteer profile legitimately wants to know is whether this
 * person is still volunteering.
 *
 * Verified external service counts. It is service, it has been checked by
 * somebody holding `service.verify.external`, and excluding it would show a
 * student who volunteers weekly outside the platform as inactive. Self-reported
 * external hours do NOT count, because "last volunteered" would then be a date
 * anybody could set to today by typing it in.
 */
export function lastVolunteeredAt(db, userId) {
  const internal = db.prepare(`
    SELECT MAX(s.end_datetime) AS t
    FROM attendance at
    JOIN slots s ON s.id = at.slot_id
    WHERE at.user_id = ? AND at.present = 1
  `).get(userId)?.t ?? null;

  const external = db.prepare(`
    SELECT MAX(occurred_on) AS t
    FROM external_hours WHERE user_id = ? AND status = 'verified'
  `).get(userId)?.t ?? null;

  if (!internal) return external;
  if (!external) return internal;
  /* Lexicographic comparison is correct here and only here: both are ISO-8601,
     and `occurred_on` is a date whose YYYY-MM-DD prefix sorts consistently
     against a full timestamp's. */
  return external > internal ? external : internal;
}

/**
 * External service totals for one volunteer, split by whether anybody checked.
 *
 * Kept apart from `hoursCredited` at every layer — the two are never added
 * together by this module, and no caller should either. Credited hours are what
 * an organizer confirmed on a WeVolunteer event; these are what a student says
 * they did somewhere else.
 */
export function externalHoursSummary(db, userId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'verified'      THEN hours END), 0) AS verified,
      COALESCE(SUM(CASE WHEN status = 'self_reported' THEN hours END), 0) AS selfReported,
      COUNT(CASE WHEN status <> 'rejected' THEN 1 END) AS entries
    FROM external_hours WHERE user_id = ?
  `).get(userId) ?? {};
  return {
    verifiedHours: Number((row.verified ?? 0).toFixed(2)),
    selfReportedHours: Number((row.selfReported ?? 0).toFixed(2)),
    entries: row.entries ?? 0,
  };
}

/**
 * The same participation counts for MANY volunteers in one query.
 *
 * Auto Select needs the reliability term for every applicant to a shift, and a
 * search result page needs counts for every row. Calling `volunteerStats` in a
 * loop would be three queries per person — the N+1 that turns a 40-applicant
 * draw into 120 round trips.
 *
 * Returns a Map from user id to `{attended, absent, recorded}`. Users with no
 * history are absent from the Map; callers must treat a miss as "no record",
 * which is emphatically not the same as zero attendance. See
 * reliabilityMultiplier in weighting.js, where that distinction is the whole
 * point.
 */
export function attendanceRecordsFor(db, userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT user_id,
           SUM(CASE WHEN best = 1 THEN 1 ELSE 0 END) AS attended,
           SUM(CASE WHEN best = 0 THEN 1 ELSE 0 END) AS absent
    FROM (
      SELECT at.user_id, at.event_id, MAX(at.present) AS best
      FROM attendance at
      JOIN events e ON e.id = at.event_id
      WHERE at.user_id IN (${placeholders}) AND e.status <> 'cancelled'
      GROUP BY at.user_id, at.event_id
    )
    GROUP BY user_id
  `).all(...ids);

  const out = new Map();
  for (const r of rows) {
    const attended = r.attended ?? 0;
    const absent = r.absent ?? 0;
    out.set(r.user_id, { attended, absent, recorded: attended + absent });
  }
  return out;
}
