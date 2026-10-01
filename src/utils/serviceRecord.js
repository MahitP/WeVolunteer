/**
 * Service history, rolled up the way a reader outside the platform reads it.
 *
 * ── Why this exists ──
 *
 * The credited-service payload is one row per SHIFT, because that is the grain
 * attendance is recorded at: `attendance` is keyed `(slot_id, user_id)`. That is
 * the right grain for an organizer confirming who turned up, and the wrong one
 * for a transcript. A college admissions officer reading
 *
 *     Food Drive — Setup — 2h
 *     Food Drive — Distribution — 2h
 *     Food Drive — Cleanup — 2h
 *
 * sees three commitments where there was one. The transcript's own summary
 * already counted events, not shifts, so the document contradicted itself on
 * the page: "3 events completed" above a table with nine rows.
 *
 * ── This is a projection, not a second definition ──
 *
 * Nothing here decides what counts as service. The input is already
 * `attendance WHERE present = 1`, which is the single authority for credited
 * hours (see `server/hoursLedger.js` and `server/volunteerStats.js`). This only
 * changes the grain it is presented at, and the total is preserved exactly —
 * `totalHours` over the output equals the sum over the input, which is the
 * property the tests pin.
 *
 * External hours are not here and must never be. They are self-reported service
 * done elsewhere, deliberately never added to credited hours at any layer.
 */

import { formatHours } from './helpers';

/**
 * What an event that gives no hours says where hours would go (ruling 16).
 *
 * An organizer can post an event that credits no hours (P2-20), and every
 * surface used to print the zero — "+0 hrs" — which reads as a mistake. The
 * owner's wording replaces it. Decided by the event's flag, never by the
 * number: zero at an hours-giving event (the volunteer left at once) is a
 * fact about the volunteer and still reads "+0 hrs".
 */
export const NO_HOURS_LABEL = 'Attended · no hours';

/** `+2 hrs`, or the no-hours wording. `creditsHours` absent means an ordinary event. */
export function creditedLabel({ creditsHours, hours }) {
  return creditsHours === false ? NO_HOURS_LABEL : `+${formatHours(hours)}`;
}

/**
 * One row per event, newest first.
 *
 * @param {Array<{eventId, title, hours, startDatetime, endDatetime, organizerName, location, category}>} completed
 * @returns {Array<{eventId, title, hours, shifts, firstStart, lastEnd, organizerName, location, category}>}
 */
export function aggregateServiceByEvent(completed) {
  if (!Array.isArray(completed)) return [];

  const byEvent = new Map();

  for (const row of completed) {
    if (!row) continue;
    /* An event id is what makes two shifts the same commitment. Without one
       there is nothing to group by, so the row stands alone rather than being
       merged into some other event by accident. */
    const key = row.eventId ?? `__untitled-${byEvent.size}`;
    const hours = Number(row.hours) || 0;

    const existing = byEvent.get(key);
    if (!existing) {
      byEvent.set(key, {
        eventId: row.eventId ?? null,
        title: row.title ?? 'Volunteer service',
        organizerName: row.organizerName ?? '',
        location: row.location ?? '',
        category: row.category ?? '',
        hours,
        /* Carried so the transcript can say "No hours" for an event that
           gives none rather than "0 hrs" (ruling 16). */
        creditsHours: row.creditsHours !== false,
        shifts: 1,
        firstStart: row.startDatetime ?? null,
        lastEnd: row.endDatetime ?? null,
      });
      continue;
    }

    existing.hours += hours;
    existing.shifts += 1;
    /* The span the volunteer actually served across, so a two-day festival
       reads as one commitment with a real date range rather than as whichever
       shift happened to be first in the array. */
    if (row.startDatetime && (!existing.firstStart || row.startDatetime < existing.firstStart)) {
      existing.firstStart = row.startDatetime;
    }
    if (row.endDatetime && (!existing.lastEnd || row.endDatetime > existing.lastEnd)) {
      existing.lastEnd = row.endDatetime;
    }
  }

  return [...byEvent.values()]
    /* Rounded once, at the end. Summing floats then rounding is the version
       that keeps the document total equal to the sum of its rows; rounding
       each shift first is how a transcript ends up off by a tenth. */
    .map(e => ({ ...e, hours: Math.round(e.hours * 100) / 100 }))
    .sort((a, b) => String(b.firstStart ?? '').localeCompare(String(a.firstStart ?? '')));
}

/** Total credited hours across a service history, at shift grain or event grain. */
export function totalServiceHours(rows) {
  if (!Array.isArray(rows)) return 0;
  return Math.round(rows.reduce((sum, r) => sum + (Number(r?.hours) || 0), 0) * 100) / 100;
}
