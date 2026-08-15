/**
 * How many hours somebody has volunteered for one organization.
 *
 * ── Derived, like every other hours figure on the platform ──
 *
 * INV-001: credited hours are never stored on a user row. They are
 * `SUM(attendance.hours_awarded) WHERE present = 1`, computed at read time,
 * with `attendance` as the sole source of truth. There is no write path that
 * sets a user's hours directly and this file does not add one.
 *
 * Scoping that same sum to an organization needs no new column and no new
 * ledger, because the link already exists: `events.organization_id`, added by
 * migration 031 and set at creation by an organizer the org's managers
 * authorised. So the question "how many hours did this volunteer perform for
 * NHS" is answered by one join —
 *
 *     attendance → events → organization_id
 *
 * — and cannot disagree with the platform-wide total, because it is the same
 * arithmetic over a subset of the same rows.
 *
 * ── Why not tags ──
 *
 * The obvious-looking alternative is to mark events with an organization tag
 * and sum by tag. It was considered and rejected: tags are a free vocabulary
 * anybody can type, so an organizer inventing `#Fun` and a student writing
 * `#Fun` about something unrelated would land in the same bucket, and a club's
 * service record would be editable by strangers. Membership and credit are
 * authorisation questions; `organization_id` is written behind a `canManage`
 * check and a tag is not. The FK already existed, which makes this the simpler
 * system as well as the safe one.
 *
 * ── What counts ──
 *
 * Attendance rows on events whose `organization_id` is this organization, where
 * the volunteer was marked present. That includes events with
 * `credits_hours = 0`, which record attendance with `hours_awarded = 0` — they
 * add nothing to the hours and are still part of the history, which is the
 * behaviour the rest of the product already has.
 *
 * It does NOT require current membership. Somebody who volunteered at ten of a
 * club's events and later left still performed those hours for it, and a figure
 * that silently dropped them on the day they left would be a record of
 * membership rather than of service.
 */

/**
 * One volunteer's service for one organization.
 *
 * `COALESCE` because `SUM()` over no rows is NULL, and a member who has not yet
 * volunteered should read 0, not blank.
 */
export function organizationHoursForUser(db, organizationId, userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(a.hours_awarded), 0) AS hours,
           COUNT(DISTINCT a.event_id)        AS events
    FROM attendance a
    JOIN events e ON e.id = a.event_id
    WHERE e.organization_id = ? AND a.user_id = ? AND a.present = 1
  `).get(organizationId, userId);

  return { hours: Number(row?.hours ?? 0), events: Number(row?.events ?? 0) };
}

/**
 * Every volunteer's service for one organization, in one query.
 *
 * Returned as a Map keyed by user id so a caller rendering a roster does one
 * lookup per row instead of one query per row. The roster is capped at 100
 * members, and 100 round trips to answer "and how many hours each" is exactly
 * the N+1 the event list already avoids with `tagsForEvents`.
 *
 * Includes people who are no longer members — see the note above — so a caller
 * that only wants the current roster should read through it by id rather than
 * iterate it.
 */
export function organizationHoursByUser(db, organizationId) {
  const rows = db.prepare(`
    SELECT a.user_id                          AS userId,
           COALESCE(SUM(a.hours_awarded), 0)  AS hours,
           COUNT(DISTINCT a.event_id)         AS events
    FROM attendance a
    JOIN events e ON e.id = a.event_id
    WHERE e.organization_id = ? AND a.present = 1
    GROUP BY a.user_id
  `).all(organizationId);

  return new Map(rows.map(r => [r.userId, { hours: Number(r.hours), events: Number(r.events) }]));
}

/**
 * What the organization has done altogether.
 *
 * `volunteers` counts distinct people who turned up, which is not the member
 * count: a club with forty members and eight who ever attended has done eight
 * people's worth of volunteering, and reporting forty would flatter it.
 */
export function organizationHoursTotal(db, organizationId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(a.hours_awarded), 0) AS hours,
           COUNT(DISTINCT a.event_id)        AS events,
           COUNT(DISTINCT a.user_id)         AS volunteers
    FROM attendance a
    JOIN events e ON e.id = a.event_id
    WHERE e.organization_id = ? AND a.present = 1
  `).get(organizationId);

  return {
    hours: Number(row?.hours ?? 0),
    events: Number(row?.events ?? 0),
    volunteers: Number(row?.volunteers ?? 0),
  };
}

/**
 * A volunteer's own service history with one organization, event by event.
 *
 * Grouped by EVENT, not by shift, for the same reason the transcript is: two
 * shifts at one food drive is one thing somebody did, and listing it twice
 * makes a short record look padded. `MIN(start_datetime)` dates the event by
 * when it began.
 *
 * Self-scoped by construction — it takes a user id and returns only that user's
 * rows — so no caller can turn it into a report about somebody else.
 */
export function organizationHistoryForUser(db, organizationId, userId, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT e.id                              AS eventId,
           e.title                           AS title,
           e.credits_hours                   AS creditsHours,
           COALESCE(SUM(a.hours_awarded), 0) AS hours,
           COUNT(*)                          AS shifts,
           (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) AS startsAt
    FROM attendance a
    JOIN events e ON e.id = a.event_id
    WHERE e.organization_id = ? AND a.user_id = ? AND a.present = 1
    GROUP BY e.id
    ORDER BY startsAt DESC
    LIMIT ?
  `).all(organizationId, userId, limit)
    .map(r => ({ ...r, hours: Number(r.hours), creditsHours: r.creditsHours !== 0 }));
}
