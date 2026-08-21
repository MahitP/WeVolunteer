import { describe, it, expect } from 'vitest';
import { resolveNavigation, DESTINATIONS } from './navigation.js';
import { ask } from './assistant.js';

const student = { id: 's1', role: 'student' };
const organizer = { id: 'o1', role: 'organizer' };
const admin = { id: 'a1', role: 'admin' };

describe('navigation resolution and role gating', () => {
  it('resolves common destination requests to canonical app routes', () => {
    expect(resolveNavigation('take me to my applications', student)?.path).toBe('/discover?find=applications');
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
    expect(res.navigate).toBe('/discover?find=applications');
    expect(res.card?.kind).toBe('navigate');
    expect(res.card?.data?.path).toBe('/discover?find=applications');
  });

  it('refuses navigation to pages the user cannot access', async () => {
    const res = await ask('open moderation center', { user: student });
    expect(res.intent).toBe('not_permitted');
    expect(res.card).toBeNull();
  });
});
