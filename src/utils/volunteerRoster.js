import { gradeLabel } from './helpers';
import { csvCell } from '../../server/csv.js';
import { recordKeptPrivate } from './applicantRecord';

/**
 * The people who have volunteered for an organizer, one row each.
 *
 * Shared by the dashboard's short list and the `/volunteers` page, so the two
 * cannot disagree about who is on it or in what order. Moved out of
 * `OrganizerDashboard.jsx` unchanged.
 */

/** Accepted applications on events this organizer hosts. */
export function acceptedForOrganizer(events, applications, organizerId) {
  const hosted = new Set(events.filter(e => e.organizerId === organizerId).map(e => e.id));
  return applications.filter(a => hosted.has(a.eventId) && a.status === 'accepted');
}

/** One entry per volunteer, with shifts counted, most hours first. */
export function rosterOf(acceptedApps) {
  const byUser = new Map();
  for (const app of acceptedApps) {
    const existing = byUser.get(app.userId);
    if (existing) {
      existing.shifts += 1;
    } else {
      byUser.set(app.userId, {
        id: app.userId,
        name: app.volunteer?.name,
        avatar: app.volunteer?.avatar,
        grade: app.volunteer?.grade,
        /* `null`, not 0, for a volunteer who keeps their record private from
           this reader (a student running the event; see `recordKeptPrivate`).
           Their hours are unknown here, and a zero would say they have none. */
        hours: recordKeptPrivate(app.volunteer) ? null : (app.volunteer?.volunteeredHours || 0),
        shifts: 1,
        volunteer: app.volunteer
      });
    }
  }
  /* Most hours first; an unknown figure is not a small one, so those go last. */
  return [...byUser.values()].sort((a, b) =>
    (a.hours === null) - (b.hours === null) || (b.hours ?? 0) - (a.hours ?? 0));
}

/** The roster as the ledger CSV the dashboard has always produced. */
export function rosterCsv(acceptedApps) {
  const roster = rosterOf(acceptedApps);
  return [
    ['Volunteer Name', 'Grade', 'Email', 'Shifts With You', 'Total Volunteered Hours'].map(csvCell).join(','),
    ...roster.map(r => [
      r.name, gradeLabel(r.grade), r.volunteer?.email || '', r.shifts,
      r.hours === null ? 'Private' : Number(r.hours).toFixed(2),
    ].map(csvCell).join(',')),
  ].join('\n');
}

/** Download `rosterCsv` as a file. */
export function downloadRosterCsv(acceptedApps) {
  const rows = rosterCsv(acceptedApps);
  const blob = new Blob([rows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', 'WeVolunteer_roster_ledger.csv');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
