import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The platform owner's own volunteer profile.
 *
 * ── The product fact this rests on ──
 *
 * The person who runs WeVolunteer is also a student who turns up to shifts.
 * Their PRIVILEGES are the owner's; their PROFILE is a volunteer's — the same
 * hours, the same badges, the same service record any student gets, with the
 * owner distinction added beside it rather than replacing it.
 *
 * ── What was wrong ──
 *
 * `GET /api/users/:id/profile` selected `WHERE role = 'student'`. That was right
 * while only students volunteered, and it meant the owner's own service record —
 * real attendance, real credited hours — answered 404 to everybody, including
 * themselves. The page that exists to show a volunteer record refused to show
 * the one belonging to the account that had earned it.
 *
 * ── Why the rule is about the ledger, not the role ──
 *
 * `role IN ('student', 'super_admin')` would have worked and been wrong in
 * principle: it asserts "the owner is a volunteer" as a fact about a ROLE. What
 * makes somebody a volunteer is that they volunteered. So the route serves every
 * student, plus anybody else with credited attendance — which is the same ledger
 * every figure on the profile is derived from, and which no name, id or email
 * appears anywhere in.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';

describe('a volunteer profile for whoever has volunteered', () => {
  let srv; let db;
  let viewer; let studentId; let organizerId;

  const profileOf = (id, session = viewer) =>
    srv.call('GET', `/api/users/${id}/profile`, undefined, session);

  /** Credited attendance for `userId`, cloned off a real event and slot. */
  const giveAttendance = async (userId, tag) => {
    const ev = await db.prepare('SELECT * FROM events LIMIT 1').get();
    const sl = await db.prepare('SELECT * FROM slots WHERE event_id = ? LIMIT 1').get(ev.id);
    const clone = async (table, tmpl, over) => {
      const row = { ...tmpl, ...over };
      const cols = Object.keys(row);
      await db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map(c => row[c]));
    };
    const past = new Date(Date.now() - 20 * 86400000).toISOString();
    await clone('events', ev, { id: `ovp-ev-${tag}`, title: 'Owner profile fixture', status: 'open' });
    await clone('slots', sl, {
      id: `ovp-sl-${tag}`, event_id: `ovp-ev-${tag}`,
      start_datetime: past, end_datetime: new Date(Date.now() - 20 * 86400000 + 7200000).toISOString(),
    });
    await db.prepare(`INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
                VALUES (?, ?, ?, 1, 2)
      ON CONFLICT (slot_id, user_id) DO UPDATE SET event_id = excluded.event_id, present = excluded.present, hours_awarded = excluded.hours_awarded`).run(`ovp-ev-${tag}`, `ovp-sl-${tag}`, userId);
  };

  const clearAttendance = async (userId) =>
    await db.prepare('DELETE FROM attendance WHERE user_id = ?').run(userId);

  /** A throwaway account promoted after signup, the way the matrix builds its fixtures. */
  const makeAccount = async (role) => {
    const tag = `${role}${Math.random().toString(36).slice(2, 7)}`;
    const signed = await srv.signupConfirmed({
      name: `Owner Fixture ${role}`,
      username: `ovp_${tag}`,
      email: `${tag}@test.local`,
      password: 'Password123',
      grade: 'Adult',
      role: 'student',
    });
    await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, signed.user.id);
    return signed.user.id;
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    viewer = await srv.login(ORGANIZER);
    const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;
    organizerId = await idOf(viewer);
    studentId = await idOf(await srv.login(STUDENT));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('serves a student, as it always did', async () => {
    const res = await profileOf(studentId);
    expect(res.status, JSON.stringify(res.body).slice(0, 150)).toBe(200);
    expect(res.body.volunteer.name).toBeTruthy();
  });

  it('serves the OWNER their own volunteer record', async () => {
    /**
     * The whole point. A super_admin with credited attendance is a volunteer and
     * has a volunteer profile — this used to be a 404 for everybody including
     * themselves.
     */
    const ownerId = await makeAccount('super_admin');
    await giveAttendance(ownerId, 'owner');

    const res = await profileOf(ownerId);
    expect(res.status, 'the owner’s own service record answered 404').toBe(200);
    expect(res.body.stats.hours).toBe(2);
    expect(res.body.stats.eventsCompleted).toBe(1);
  });

  it('gives the owner the same shape a student gets, not a special one', async () => {
    /* "Looks like a normal student's volunteer profile" is the requirement, so
       the payload is compared against a student's rather than merely inspected. */
    const ownerId = await makeAccount('super_admin');
    await giveAttendance(ownerId, 'shape');

    const owner = await profileOf(ownerId);
    const student = await profileOf(studentId);
    expect(Object.keys(owner.body).sort()).toEqual(Object.keys(student.body).sort());
    expect(Object.keys(owner.body.stats).sort()).toEqual(Object.keys(student.body.stats).sort());
    expect(Array.isArray(owner.body.milestones)).toBe(true);
  });

  it('does NOT serve an account that has never volunteered', async () => {
    /**
     * The half that keeps this from being "any account has a profile". An
     * organizer who has never taken a shift has no service record to show, and
     * the route says so — which is what it said before this change too.
     */
    const freshOwner = await makeAccount('super_admin');
    const res = await profileOf(freshOwner);
    expect(res.status, 'an account with no attendance was given a volunteer profile').toBe(404);
  });

  it('stops serving one whose attendance is taken away', async () => {
    /* Derived from the ledger, not remembered: revoking the attendance revokes
       the profile, because the profile IS the attendance. */
    const ownerId = await makeAccount('super_admin');
    await giveAttendance(ownerId, 'revoke');
    expect((await profileOf(ownerId)).status).toBe(200);

    await clearAttendance(ownerId);
    expect((await profileOf(ownerId)).status).toBe(404);
  });

  it('refuses a deleted account whatever its role', async () => {
    /* A tombstone is anonymised in place rather than removed, so without the
       status check it would answer 200 as a live profile. */
    const ownerId = await makeAccount('super_admin');
    await giveAttendance(ownerId, 'tombstone');
    await db.prepare("UPDATE users SET account_status = 'deleted' WHERE id = ?").run(ownerId);
    expect((await profileOf(ownerId)).status).toBe(404);
  });

  it('names nobody in particular — the rule is the ledger', async () => {
    /**
     * A guard against the fix drifting into an identity check. The requirement
     * was explicit that the owner must not be recognised by name, username,
     * email or id, so the route's own source is asserted to contain none.
     */
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./routes/userRoutes.js', import.meta.url), 'utf8');
    const profileRoute = src.slice(src.indexOf("router.get('/api/users/:id/profile'"), src.indexOf('const isSelf'));
    expect(profileRoute).not.toMatch(/mahit|Pulavarthi|@gmail|user-[a-z]+-\d/i);
    expect(profileRoute).toMatch(/attendance/);
  });
});
