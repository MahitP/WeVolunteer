import { describe, it, expect } from 'vitest';
import { resolveNavigation, DESTINATIONS } from './navigation.js';
import { ask } from './assistant.js';

const student = { id: 's1', role: 'student' };
const organizer = { id: 'o1', role: 'organizer' };
const admin = { id: 'a1', role: 'admin' };

describe('navigation resolution and role gating', () => {
  it('resolves common destination requests to canonical app routes', () => {
    /**
     * The dashboard, and this pin was updated deliberately rather than relaxed.
     *
     * It read `/discover?find=applications`, under the name "canonical app
     * routes" — and that is the one thing the path was not. `find` is a scope,
     * `BrowseEvents` accepts `all | events | people | organizations`, and
     * anything else falls back to `all` in silence. So Welly announced
     * "Navigating to Your Applications" and delivered generic Discover.
     *
     * There is no applications page to name instead: a student's pending and
     * confirmed applications are sections of the volunteer dashboard. See the
     * note on the destination, and `navigationDestinations.test.js`, which
     * refuses any `find` value Discover does not accept.
     */
    expect(resolveNavigation('take me to my applications', student)?.path).toBe('/');
    expect(resolveNavigation('open settings', student)?.path).toBe('/settings');
    expect(resolveNavigation('go to calendar', student)?.path).toBe('/calendar');
    expect(resolveNavigation('take me to my profile', student)?.path).toBe('/profile');
    expect(resolveNavigation('go to notifications', student)?.path).toBe('/notifications');
    expect(resolveNavigation('open certificates', student)?.path).toBe('/certificates');
    expect(resolveNavigation('go to messages', student)?.path).toBe('/messages');
    expect(resolveNavigation('take me to member directory', student)?.path).toBe('/discover?find=people');
  });

  it('checks capabilities on privileged destinations', () => {
    const studentModeration = resolveNavigation('open moderation center', student);
    expect(studentModeration?.allowed).toBe(false);

    const adminModeration = resolveNavigation('open moderation center', admin);
    expect(adminModeration?.allowed).toBe(true);

    const studentEventNew = resolveNavigation('go to create event page', student);
    expect(studentEventNew?.allowed).toBe(false);

    const organizerEventNew = resolveNavigation('go to create event page', organizer);
    expect(organizerEventNew?.allowed).toBe(true);
  });

  it('returns structured navigation cards from ask()', async () => {
    const res = await ask('take me to my applications', { user: student });
    expect(res.intent).toBe('navigate');
    expect(res.navigate).toBe('/');
    expect(res.card?.kind).toBe('navigate');
    expect(res.card?.data?.path).toBe('/');
  });

  it('refuses navigation to pages the user cannot access', async () => {
    const res = await ask('open moderation center', { user: student });
    expect(res.intent).toBe('not_permitted');
    expect(res.card).toBeNull();
  });
});

/**
 * The dashboard, added after an audit found "take me to my dashboard"
 * resolving to nothing and falling through to `unknown`.
 */
describe('the dashboard destination', () => {
  const student = { id: 's1', role: 'student', withheld: [] };
  const partner = { id: 'p1', role: 'partner', withheld: [] };

  it('resolves the phrasings people actually use', () => {
    for (const text of ['take me to my dashboard', 'go to the dashboard', 'open my dashboard', 'take me to the home page']) {
      const nav = resolveNavigation(text, student);
      expect(nav, text).not.toBeNull();
      expect(nav.path).toBe('/');
      expect(nav.allowed).toBe(true);
    }
  });

  it('refuses the reader who has no dashboard', () => {
    /* A partner gets an explicit no-dashboard state in the shell; sending them
       to `/` would be sending them nowhere. */
    expect(resolveNavigation('take me to my dashboard', partner).allowed).toBe(false);
  });

  it('does not fire on a sentence that merely mentions being at home', () => {
    expect(resolveNavigation('I volunteered near my home last week', student)).toBeNull();
  });
});
