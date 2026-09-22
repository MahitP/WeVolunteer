import { buildMilestones, SERVICE_HOUR_GOAL } from './milestones.js';
import { volunteerStats } from './volunteerStats.js';

/**
 * What the dashboard tells a volunteer about their own service.
 *
 * A module rather than a route handler, for the same reason `milestones.js` and
 * `weighting.js` are: these are definitions, and a definition that lives in a
 * handler can only be tested through HTTP and can only be reused by copying.
 *
 * ── The one rule that governs everything here ──
 *
 * Every figure is derived from the attendance ledger on read. Nothing is
 * stored, nothing is cached, and no number in this file is computed a second
 * way anywhere else. Where a definition already exists — credited hours,
 * participation counts, milestone thresholds — this imports it rather than
 * restating it.
 */

/* ── Month arithmetic ─────────────────────────────────────────────────────── */

/**
 * A month key, `YYYY-MM`, in UTC.
 *
 * UTC throughout, and anchored to day 1, because the obvious implementation is
 * a real bug: `d.setMonth(d.getMonth() - 1)` on the 31st of March gives the 3rd
 * of March, because February has no 31st and the overflow rolls forward. Every
 * month calculation here builds a fresh Date from (year, month, 1) instead.
 */
function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month `offset` months from `date`, as a key. Negative offsets go back. */
function shiftMonth(date, offset) {
  return monthKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)));
}

/** The `count` month keys ending in `now`'s month, oldest first. */
export function monthKeys(now, count) {
  const d = new Date(now);
  const keys = [];
  for (let i = count - 1; i >= 0; i--) keys.push(shiftMonth(d, -i));
  return keys;
}

/* ── Streak ───────────────────────────────────────────────────────────────── */

/**
 * Consecutive calendar months containing at least one credited attendance.
 *
 * ── Why months, and not weeks ──
 *
 * A weekly streak punishes a student for exam week, for half term, for being
 * ill, and for a term where their school simply ran nothing — none of which is
 * a statement about their commitment. A month is long enough to absorb all of
 * those. This is also the definition the platform plan settled on before any of
 * it was built, for the same reasons.
 *
 * ── Why the current month cannot break it ──
 *
 * On the 2nd of the month a volunteer has not yet failed to do anything. If the
 * current month is empty but the previous one is not, the streak is still
 * running and still counted — they have the rest of the month. A streak that
 * resets at midnight on the 1st would be a countdown, and a countdown is the
 * mechanic that turns continuity into pressure.
 *
 * ── Why an organizer cannot break it either ──
 *
 * Cancelled events are excluded upstream, in the query. If an organizer cancels
 * the only event a volunteer had that month, that month is not held against
 * them.
 *
 * @param {string[]} months `YYYY-MM` keys, in any order, duplicates fine
 * @param {Date|string|number} now
 * @returns {{current: number, longest: number}}
 */
export function buildStreak(months, now) {
  const present = new Set(months.filter(Boolean));
  if (present.size === 0) return { current: 0, longest: 0 };

  const today = new Date(now);

  /* Anchor on this month if it has activity, otherwise on last month if it
     does — the grace period described above. Neither, and the streak is over. */
  let anchorOffset = null;
  if (present.has(shiftMonth(today, 0))) anchorOffset = 0;
  else if (present.has(shiftMonth(today, -1))) anchorOffset = -1;

  let current = 0;
  if (anchorOffset !== null) {
    for (let i = anchorOffset; present.has(shiftMonth(today, i)); i--) current++;
  }

  /* Longest is over the whole history, so a broken streak is not erased — the
     record of having once done six months running is worth keeping.

     Comparing against the key the PREVIOUS month's successor would have is what
     makes December-to-January continue the run rather than break it. */
  const sorted = [...present].sort();
  let longest = 0;
  let run = 0;
  let expectedNext = null;
  for (const key of sorted) {
    run = key === expectedNext ? run + 1 : 1;
    longest = Math.max(longest, run);
    const [year, month] = key.split('-').map(Number);
    expectedNext = monthKey(new Date(Date.UTC(year, month, 1)));
  }

  return { current, longest };
}

/**
 * The months in which this volunteer has credited attendance.
 *
 * `slots.end_datetime` is the only honest source of when service happened:
 * `attendance` carries no timestamp of its own, and `hours_ledger.created_at`
 * records when an organizer pressed a button, which can be weeks later.
 *
 * Driven by `idx_attendance_user(user_id, present)` with primary-key lookups
 * into `slots` and `events` — no new index, no scan.
 */
export async function attendanceMonths(db, userId) {
  return (await db.prepare(`
    SELECT DISTINCT substr(s.end_datetime, 1, 7) AS month
    FROM attendance at
    JOIN slots  s ON s.id = at.slot_id
    JOIN events e ON e.id = at.event_id
    WHERE at.user_id = ? AND at.present = 1 AND e.status <> 'cancelled'
  `).all(userId)).map(r => r.month).filter(Boolean);
}

/* ── The figures ──────────────────────────────────────────────────────────── */

/**
 * The inputs `buildMilestones` needs, derived in ONE place.
 *
 * ── Why this is extracted rather than reusing `volunteerStats` ──
 *
 * `volunteerStats().eventsAttended` excludes cancelled events and only counts
 * shifts that have ended. `buildMilestones` wants distinct events with credited
 * attendance, full stop — which is what the profile route has always passed it.
 * The two numbers differ, and feeding the wrong one in would let the dashboard
 * say a tier is unearned while the profile says it is earned, for the same
 * student, on the same afternoon.
 *
 * So both callers now derive it here. `routes.volunteerInsights.test.js` asserts
 * the two agree, because that is the failure this exists to prevent.
 *
 * ── Why this one does NOT exclude a cancelled event ──
 *
 * Every figure the product presents as credited service does exclude it —
 * `creditedHoursFor` is the canonical definition and b8cfb09 states the scope
 * as "everywhere hours are presented as credited service". A milestone TIER is
 * deliberately outside that scope, and the decision is recorded in
 * `volunteerInsights.test.js` as "counts a cancelled event, because the service
 * still happened", explicitly "deliberately different from
 * `volunteerStats().eventsAttended`".
 *
 * That is an owner decision about recognition rather than about a total, so it
 * is left exactly as it was. It is NOT a licence for the totals beside it: use
 * `creditedTotalsFor` below for anything presented as an hours figure, which is
 * what the profile's `stats.hours` should have been using all along.
 */
export async function milestoneInputs(db, userId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(hours_awarded), 0) AS hours,
           COUNT(DISTINCT event_id) AS events,
           COUNT(*) AS shifts
    FROM attendance WHERE user_id = ? AND present = 1
  `).get(userId) ?? {};
  return { hours: row.hours ?? 0, events: row.events ?? 0, shifts: row.shifts ?? 0 };
}

/**
 * The same three counts, as CREDITED SERVICE — cancelled events excluded.
 *
 * ── Why this is a second function and not a flag ──
 *
 * The two numbers answer different questions and the difference is invisible at
 * the call site, which is how the defect happened. `GET /api/users/:id/profile`
 * published `milestoneInputs().hours` as `stats.hours`, beside a `completed[]`
 * list that carries `AND e.status <> 'cancelled'` and a comment saying "Same
 * rule as volunteerStats.hoursCredited". So one response could show hours next
 * to an empty list of the events that produced them, and `record.hoursCredited`
 * in the neighbouring endpoint reported a different total for the same student.
 *
 * `git show 93756e4` settles that this was never intended: the profile's query
 * was already unfiltered before the milestone extraction moved it here. The
 * extraction shared an existing derivation; it did not choose one for the
 * totals.
 *
 * A boolean argument would have put the decision back at the call site under a
 * name that does not say which answer is correct. Two names do.
 */
export async function creditedTotalsFor(db, userId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(a.hours_awarded), 0) AS hours,
           COUNT(DISTINCT a.event_id) AS events,
           COUNT(*) AS shifts
    FROM attendance a
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id = ? AND a.present = 1 AND e.status <> 'cancelled'
  `).get(userId) ?? {};
  return { hours: row.hours ?? 0, events: row.events ?? 0, shifts: row.shifts ?? 0 };
}

/**
 * Credited hours per month, zero-filled, oldest first, always `months` long.
 *
 * ── Why the zero-filling matters ──
 *
 * The query returns only months that have hours, so a quiet month vanished from
 * the series entirely and the chart drew the remaining months side by side. A
 * volunteer who did nothing in June saw a chart implying they had — the axis
 * was not a timeline, it was a list of months that happened to qualify.
 *
 * Screen-reader users could not perceive it at all: the accompanying data table
 * simply had fewer rows, with nothing to say a month was missing.
 *
 * It also makes `highlightLast` mean what it says. It highlighted "the most
 * recent month with any activity"; now the last column is always this month.
 */
export async function monthlyHours(db, userId, { now = new Date(), months = 6 } = {}) {
  const keys = monthKeys(now, months);

  /* The chart sits directly under the credited total, so it carries the same
     exclusion; a column the total does not account for reads as a discrepancy
     in the one place a student is most likely to check the arithmetic. */
  const rows = await db.prepare(`
    SELECT substr(s.end_datetime, 1, 7) AS month,
           SUM(a.hours_awarded) AS hours
    FROM attendance a
    JOIN slots s ON a.slot_id = s.id
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id = ? AND a.present = 1 AND e.status <> 'cancelled'
      AND substr(s.end_datetime, 1, 7) >= ?
    GROUP BY month
  `).all(userId, keys[0]);

  const byMonth = new Map(rows.map(r => [r.month, Number(r.hours) || 0]));
  return keys.map(month => ({ month, hours: byMonth.get(month) ?? 0 }));
}

/**
 * The first credited shift's end, the mirror of `lastVolunteeredAt`.
 *
 * Cancelled events excluded, as in that mirror: "volunteering since March" is a
 * claim about service, and a called-off event is not service the platform will
 * stand behind anywhere else.
 */
export async function firstVolunteeredAt(db, userId) {
  return (await db.prepare(`
    SELECT MIN(s.end_datetime) AS t
    FROM attendance at
    JOIN slots s ON s.id = at.slot_id
    JOIN events e ON e.id = at.event_id
    WHERE at.user_id = ? AND at.present = 1 AND e.status <> 'cancelled'
  `).get(userId))?.t ?? null;
}

/**
 * How many of the category enum's values this volunteer has served in.
 *
 * The join was already here for `e.category`; only the predicate was missing,
 * which is the easiest form of this defect to introduce and the hardest to see.
 */
export async function kindsOfService(db, userId) {
  return (await db.prepare(`
    SELECT COUNT(DISTINCT e.category) AS n
    FROM attendance a
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id = ? AND a.present = 1 AND e.status <> 'cancelled'
  `).get(userId))?.n ?? 0;
}

/**
 * Accepted commitments that have not happened yet.
 *
 * The old form used `slot_id IN (SELECT id FROM slots WHERE end_datetime > ?)`,
 * which cannot use an index on either side and scanned every slot in the
 * database to answer a question about one student. It also counted accepted
 * applications on cancelled events as upcoming, which is a commitment to
 * something that is not happening.
 */
export async function upcomingCount(db, userId, { now = new Date().toISOString() } = {}) {
  return (await db.prepare(`
    SELECT COUNT(*) AS c
    FROM applications a
    JOIN slots  s ON s.id = a.slot_id
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id = ? AND a.status = 'accepted'
      AND s.end_datetime > ? AND e.status <> 'cancelled'
  `).get(userId, now))?.c ?? 0;
}

/**
 * Everything the volunteer dashboard's insight section needs, in one call.
 *
 * Eight indexed single-user queries, no scans, no new indexes.
 */
export async function volunteerInsights(db, userId, { now = new Date(), months = 6 } = {}) {
  const nowIso = new Date(now).toISOString();
  const stats = await volunteerStats(db, userId, { now: nowIso });
  const inputs = await milestoneInputs(db, userId);
  /* `record` is the totals block — it carries `hoursCredited`, which excludes
     cancelled events — so `shiftsWorked` beside it must too. `milestones` below
     keeps the other derivation, deliberately; see `milestoneInputs`. */
  const credited = await creditedTotalsFor(db, userId);

  return {
    monthlyHours: await monthlyHours(db, userId, { now, months }),
    record: {
      hoursCredited: stats.hoursCredited,
      eventsSignedUp: stats.eventsSignedUp,
      eventsAttended: stats.eventsAttended,
      eventsAbsent: stats.eventsAbsent,
      eventsAwaitingRecord: stats.eventsAwaitingRecord,
      lastVolunteeredAt: stats.lastVolunteeredAt,
      firstVolunteeredAt: await firstVolunteeredAt(db, userId),
      kindsOfService: await kindsOfService(db, userId),
      shiftsWorked: credited.shifts,
    },
    milestones: buildMilestones(inputs.hours, inputs.events),
    streak: buildStreak(await attendanceMonths(db, userId), now),
    upcomingCount: await upcomingCount(db, userId, { now: nowIso }),
    serviceHourGoal: SERVICE_HOUR_GOAL,
  };
}
