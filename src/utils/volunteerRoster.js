import { gradeLabel } from './helpers';
import { csvCell } from '../../server/csv.js';

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
        hours: app.volunteer?.volunteeredHours || 0,
        shifts: 1,
        volunteer: app.volunteer
      });
    }
  }
  return [...byUser.values()].sort((a, b) => b.hours - a.hours);
}

/** Download the roster as the ledger CSV the dashboard has always produced. */
export function downloadRosterCsv(acceptedApps) {
  const roster = rosterOf(acceptedApps);
  const rows = [
    ['Volunteer Name', 'Grade', 'Email', 'Shifts With You', 'Total Volunteered Hours'].map(csvCell).join(','),
    ...roster.map(r => [r.name, gradeLabel(r.grade), r.volunteer?.email || '', r.shifts, Number(r.hours).toFixed(2)].map(csvCell).join(',')),
  ].join('\n');
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
