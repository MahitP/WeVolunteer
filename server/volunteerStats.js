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
export async function volunteerStats(db, userId, { now = new Date().toISOString() } = {}) {
  const signedUp = (await db.prepare(`
    SELECT COUNT(DISTINCT a.event_id) AS n ${DUE_COMMITMENTS}
  `).get(userId, now))?.n ?? 0;

  /**
   * Attendance is keyed by (slot, user) but the statistic is about events, so
   * both sides collapse to distinct events. A volunteer who worked two shifts
   * of the same festival attended one event, and — importantly — a volunteer
   * who made one shift and missed another is counted as having attended, not as
   * both attended and absent. MAX(present) is what expresses that: any present
   * shift makes the event attended.
   */
  const outcome = await db.prepare(`
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

  /**
   * Credited hours.
   *
   * ── Why the join is here now ──
   *
   * This was `FROM attendance WHERE user_id = ? AND present = 1` with no
   * reference to the event at all, which meant a CANCELLED event's hours
   * counted toward a student's total while `eventsAttended` two queries above
   * excluded that same event from their count. One number said the work
   * happened and the other said it did not.
   *
   * The transcript is the surface where that became untenable: it is a record
   * of completed service, and printing a called-off event as a verified row
   * under somebody's name is a claim the platform cannot support. So cancelled
   * events are excluded here, in the itemised `completed` list, and in the
   * organization figures — one rule, applied everywhere hours are presented as
   * credited service.
   *
   * Measured before changing it: zero attendance rows on cancelled events exist
   * in the pilot database, so no student's displayed total moves. This corrects
   * an edge case rather than restating anybody's record.
   */
  const hours = (await db.prepare(`
    SELECT COALESCE(SUM(a.hours_awarded), 0) AS h
    FROM attendance a
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id = ? AND a.present = 1 AND e.status <> 'cancelled'
  `).get(userId))?.h ?? 0;

  return {
    eventsSignedUp: signedUp,
    eventsAttended,
    eventsAbsent,
    eventsAwaitingRecord,
    hoursCredited: Number(hours.toFixed ? hours.toFixed(2) : hours),
    lastVolunteeredAt: await lastVolunteeredAt(db, userId),
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
 * ── External entries deliberately do NOT count ──
 *
 * They are self-reported and unverifiable, so including them would make "last
 * volunteered" a date anybody can set to today by typing it into a form. This
 * figure appears on a public profile, where a reader takes it as evidence that
 * somebody is still active; evidence nobody checked is not evidence. The
 * student's own log shows their external entries in full — that is where a
 * complete personal history belongs.
 */
export async function lastVolunteeredAt(db, userId) {
  return (await db.prepare(`
    SELECT MAX(s.end_datetime) AS t
    FROM attendance at
    JOIN slots s ON s.id = at.slot_id
    WHERE at.user_id = ? AND at.present = 1
  `).get(userId))?.t ?? null;
}

/**
 * External service totals for one volunteer.
 *
 * Every external entry is self-reported — that is the whole feature, and there
 * is no verification state to split on. `selfReportedHours` is named rather than
 * being a bare `hours` so that no caller can read it as a credited figure by
 * accident.
 *
 * Kept apart from `hoursCredited` at every layer: the two are never added
 * together by this module, and no caller should either. Credited hours are what
 * an organizer confirmed on a WeVolunteer event; these are what a student says
 * they did somewhere else.
 */
export async function externalHoursSummary(db, userId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(hours), 0) AS total, COUNT(*) AS entries
    FROM external_hours WHERE user_id = ?
  `).get(userId) ?? {};
  return {
    selfReportedHours: Number((row.total ?? 0).toFixed(2)),
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
export async function attendanceRecordsFor(db, userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(`
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

/**
 * `eventsSignedUp` and `eventsAttended` for MANY volunteers, in two queries.
 *
 * ── Why this exists beside `volunteerStats` ──
 *
 * The applicants list shows an organizer, at a glance, whether somebody
 * generally turns up — and it renders forty rows on a popular shift. Calling
 * `volunteerStats` per row is six queries per applicant; the whole point of the
 * screen is that it loads while the organizer is deciding.
 *
 * The DEFINITIONS are the shared ones, deliberately. `DUE_COMMITMENTS` is
 * interpolated here exactly as it is there, so "signed up" means the same thing
 * on the profile and in this list: an ACCEPTED application to a non-cancelled
 * event whose shift has ended. Being turned down never appears on a student's
 * record, and withdrawing in time — which the API already refuses to allow late
 * — is not counted against them. Attendance reuses `attendanceRecordsFor`, so
 * missing attendance is never read as absence in either place.
 *
 * A statistic an organizer uses to decide who gets a place has to be the same
 * number the student can see on their own profile. Two implementations of
 * "signed up" would eventually disagree, and the student would have no way to
 * find out which one was used about them.
 *
 * @returns {Map<string, {signedUp:number, attended:number, absent:number}>}
 */
export async function participationCountsFor(db, userIds, { now = new Date().toISOString() } = {}) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => '?').join(',');

  /* `DUE_COMMITMENTS` is written for one user; widened to a set here by
     replacing its equality with an IN, which is the only difference between the
     two — asserted by volunteerStats.test.js. */
  const signedUpRows = await db.prepare(`
    SELECT a.user_id, COUNT(DISTINCT a.event_id) AS n
    ${DUE_COMMITMENTS.replace('a.user_id = ?', `a.user_id IN (${placeholders})`)}
    GROUP BY a.user_id
  `).all(...ids, now);

  const attendance = await attendanceRecordsFor(db, ids);

  const out = new Map();
  for (const id of ids) {
    const record = attendance.get(id);
    out.set(id, {
      signedUp: signedUpRows.find(r => r.user_id === id)?.n ?? 0,
      attended: record?.attended ?? 0,
      absent: record?.absent ?? 0,
    });
  }
  return out;
}