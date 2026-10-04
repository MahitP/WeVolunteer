import { publicUrl } from '../config';

/** `20261011T130000Z` — the UTC form Google Calendar's template takes. */
const compactUtc = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * A link that opens Google Calendar's new-event form with a shift filled in
 * (P2-04).
 *
 * The .ics download stays — a phone hands it to its own calendar, with the
 * location and a reminder. This is for students who live in Google Calendar,
 * and for a school Chromebook, where a downloaded .ics just sits in Downloads.
 * Nothing is sent anywhere until the student presses Save in Google; the link
 * carries only what the event page already shows to them.
 *
 * @param {{ id: string, title: string, location?: string }} event
 * @param {{ name?: string, startDatetime: string, endDatetime: string }} slot
 * @param {string} [origin]  injectable for tests; defaults to the public origin
 */
export function googleCalendarUrl(event, slot, origin) {
  const link = origin ? `${origin.replace(/\/+$/, '')}/discover?event=${encodeURIComponent(event.id)}` : publicUrl(`/discover?event=${encodeURIComponent(event.id)}`);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: slot?.name ? `${event.title} — ${slot.name}` : event.title,
    dates: `${compactUtc(slot.startDatetime)}/${compactUtc(slot.endDatetime)}`,
    details: `Your WeVolunteer shift. Details and check-in: ${link}`,
  });
  if (event.location) params.set('location', event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
