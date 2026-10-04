import { describe, it, expect } from 'vitest';
import { locationRelevantFor } from './App.jsx';

/**
 * The location offer only where sharing a location changes what is shown
 * (owner ruling 25, 2026-10-04).
 *
 * LOCATION_AWARE_TABS listed `dashboard` because "every persona's dashboard
 * shows a next shift with travel time and weather". Only the volunteer's
 * does. An organizer opening their dashboard was offered "See how far away
 * opportunities are", which changes nothing on that page.
 */
describe('locationRelevantFor', () => {
  it('offers it on a volunteer\'s dashboard, Discover and the calendar', () => {
    expect(locationRelevantFor('dashboard', 'volunteer')).toBe(true);
    for (const persona of ['volunteer', 'host', 'staff']) {
      expect(locationRelevantFor('browse', persona)).toBe(true);
      expect(locationRelevantFor('calendar', persona)).toBe(true);
    }
  });

  it('does not offer it on an organizer\'s or an administrator\'s dashboard', () => {
    expect(locationRelevantFor('dashboard', 'host')).toBe(false);
    expect(locationRelevantFor('dashboard', 'staff')).toBe(false);
  });

  it('does not offer it where nothing uses it', () => {
    expect(locationRelevantFor('messages', 'volunteer')).toBe(false);
  });
});
