/**
 * What `GET /api/stats/volunteer` actually returns.
 *
 * ── Why this is a shared file and not a literal in each test ──
 *
 * Welly's `my_hours` tool read `stats.hours` and `stats.events`. The endpoint
 * has never had either: its top level is `{monthlyHours, record, milestones,
 * streak, upcomingCount, serviceHourGoal}` and the figures are inside `record`.
 * So the tool answered "You do not have any verified hours yet" to every
 * student who ever asked, including one whose dashboard read 209 hours on the
 * same screen.
 *
 * Six test files had it stubbed as `{hours: 35.5, events: 7}` — the shape the
 * broken code wanted rather than the shape the server sends. Every one of them
 * passed. A hand-written mock that disagrees with the server does not merely
 * fail to catch a bug; it certifies it, and it does so in whichever direction
 * the author already believed.
 *
 * So the response lives here once, matching `volunteerInsights()` field for
 * field, and `volunteerStatsContract.test.js` on the server side asserts that
 * it still does. A field renamed on the server fails there, loudly, instead of
 * quietly making every client test a fiction.
 */

/**
 * @param over  overrides, merged one level deep into `record` as well as the
 *              top level, so a test that only cares about hours can say so.
 */
export function volunteerStatsResponse(over = {}) {
  /* `...over` LAST at the top level would overwrite the merged `record` with
     the caller's partial one, so a fixture asking only for hours would come
     back missing every other field. Merged explicitly instead. */
  return {
    monthlyHours: [0, 2, 0, 4, 3, 5].map((hours, i) => ({ month: `2026-0${i + 3}`, hours })),
    milestones: [],
    streak: { current: 0, longest: 0 },
    upcomingCount: 0,
    serviceHourGoal: 25,
    ...over,
    record: {
      hoursCredited: 0,
      eventsSignedUp: 0,
      eventsAttended: 0,
      eventsAbsent: 0,
      eventsAwaitingRecord: 0,
      lastVolunteeredAt: null,
      firstVolunteeredAt: null,
      kindsOfService: 0,
      shiftsWorked: 0,
      ...over.record,
    },
  };
}

/** The common case: some hours, some events attended. */
export const withHours = (hoursCredited, eventsAttended = 0) =>
  volunteerStatsResponse({ record: { hoursCredited, eventsAttended } });

/** The field names the client depends on, named once so a rename is findable. */
export const VOLUNTEER_STATS_FIELDS = Object.freeze({
  container: 'record',
  hours: 'hoursCredited',
  events: 'eventsAttended',
});
