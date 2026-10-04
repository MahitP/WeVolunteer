import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { googleCalendarUrl } from './googleCalendar';

/**
 * Calendar integration (P2-04).
 *
 * A shift could be added to a calendar as a downloaded .ics file, which a phone
 * hands to its own calendar app and which carries the location and a reminder.
 * Students who live in Google Calendar had no one-tap way in: on a Chromebook
 * — the device a school hands out — a downloaded .ics just sits in Downloads.
 */
describe('googleCalendarUrl', () => {
  const event = { id: 'e1', title: 'River Cleanup', location: 'Reichler Park (east gate)' };
  const slot = { name: 'Morning', startDatetime: '2026-10-11T13:00:00.000Z', endDatetime: '2026-10-11T15:30:00.000Z' };

  it('opens Google Calendar\'s new-event form with the shift filled in', () => {
    const url = new URL(googleCalendarUrl(event, slot, 'https://app.wevolunteers.org'));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('River Cleanup — Morning');
    expect(url.searchParams.get('dates')).toBe('20261011T130000Z/20261011T153000Z');
    expect(url.searchParams.get('location')).toBe('Reichler Park (east gate)');
    expect(url.searchParams.get('details')).toMatch(/https:\/\/app\.wevolunteers\.org\/discover\?event=e1/);
  });

  it('is offered beside the .ics download for an accepted shift', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/components/EventShiftsTab.jsx'), 'utf8');
    expect(src).toMatch(/googleCalendarUrl\(/);
    expect(src).toMatch(/Add .* to Google Calendar/);
  });
});
