import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Hours, scoped to one organization.
 *
 * ── What is being asserted, and why these particular things ──
 *
 * The figure is derived — `SUM(attendance.hours_awarded) WHERE present = 1`,
 * joined to `events.organization_id` — so the risks are not "is the arithmetic
 * right" so much as "is it the right set of rows". Three ways it could be the
 * wrong set, each of which gets a test:
 *
 *   · hours from one organization appearing under another (the owner asked for
 *     this one by name: NHS 10, CS Club 4, and neither number moving)
 *   · hours from events belonging to NO organization being swept in
 *   · somebody's platform-wide total leaking to a club that did not earn it
 *
 * And one authorization risk: per-member figures are for managers, because the
 * members of a school club are children and a roster ranked by hours is a
 * leaderboard nobody asked for.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';

describe('organization hours', () => {
  let srv;
  let db;
  let manager;
  let student;
  let other;
  let managerId;
  let studentId;
  let otherId;

  /** An organization with the organizer as its manager. Returns {id, slug}. */
  const makeOrg = async (name) => {
    const id = `org-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
    const slug = id;
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO organizations (id, name, slug, description, tags, created_by,
        created_by_name_snapshot, status, created_at, updated_at)
      VALUES (?, ?, ?, '', '[]', ?, 'Jordan', 'active', ?, ?)
    `).run(id, name, slug, managerId, now, now);
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, 'manager', ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role, joined_at = excluded.joined_at
    `).run(id, managerId, now);
    return { id, slug };
  };

  const join = async (orgId, userId, role = 'member') => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role, joined_at = excluded.joined_at
    `).run(orgId, userId, role, new Date().toISOString());
  };

  /**
   * An event under `orgId` on which `userId` was present for `hours`.
   *
   * Clones the shape of a real event row rather than enumerating every NOT NULL
   * column, and writes the attendance row directly: this suite is about how
   * hours are READ, and driving the whole check-in flow to produce them would
   * put the thing under test behind six other things.
   */
  const credit = async (orgId, userId, hours, { title = 'Event', shifts = 1 } = {}) => {
    const eventId = `evt-${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    const start = '2026-05-01T14:00:00.000Z';
    const template = await db.prepare('SELECT * FROM events LIMIT 1').get();
    const columns = Object.keys(template);
    const values = columns.map(c => {
      if (c === 'id') return eventId;
      if (c === 'title') return title;
      if (c === 'organization_id') return orgId;
      if (c === 'organizer_id') return managerId;
      if (c === 'status') return 'completed';
      if (c === 'created_at' || c === 'updated_at') return now;
      return template[c];
    });
    await db.prepare(
      `INSERT INTO events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    ).run(...values);

    for (let i = 0; i < shifts; i += 1) {
      const slotId = `slot-${Math.random().toString(36).slice(2, 9)}`;
      await db.prepare(`
        INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
        VALUES (?, ?, 'Shift', '', ?, ?, 5)
      `).run(slotId, eventId, start, start);
      await db.prepare(`
        INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
        VALUES (?, ?, ?, 1, ?)
      `).run(eventId, slotId, userId, hours / shifts);
    }
    return eventId;
  };

  const fetchOrg = (slug, session) =>
    srv.call('GET', `/api/organizations/${slug}`, undefined, session);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    student = await srv.login(STUDENT);
    other = await srv.login(OTHER_STUDENT);
    managerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(ORGANIZER)).id;
    studentId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(STUDENT)).id;
    otherId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(OTHER_STUDENT)).id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(() => {
    /* Each test builds its own organizations and events; clearing attendance
       keeps a figure from one test from being counted by the next. */
    db.exec('DELETE FROM attendance');
  });

  /**
   * The owner's scenario, verbatim: NHS 10, CS Club 4, and neither number
   * moving because of the other.
   */
  it('keeps one organization\'s hours out of another\'s', async () => {
    const nhs = await makeOrg('NHS');
    const cs = await makeOrg('CS Club');
    await join(nhs.id, studentId);
    await join(cs.id, studentId);

    await credit(nhs.id, studentId, 10);
    await credit(cs.id, studentId, 4);

    expect((await fetchOrg(nhs.slug, student)).body.viewer.hours).toBe(10);
    expect((await fetchOrg(cs.slug, student)).body.viewer.hours).toBe(4);
  });

  it('ignores hours from events that belong to no organization', async () => {
    const nhs = await makeOrg('NHS');
    await join(nhs.id, studentId);

    await credit(nhs.id, studentId, 6);
    await credit(null, studentId, 20);

    expect((await fetchOrg(nhs.slug, student)).body.viewer.hours).toBe(6);
  });

  it('counts only the volunteer asking, not everybody who attended', async () => {
    const nhs = await makeOrg('NHS');
    await join(nhs.id, studentId);
    await join(nhs.id, otherId);

    await credit(nhs.id, studentId, 5);
    await credit(nhs.id, otherId, 30);

    expect((await fetchOrg(nhs.slug, student)).body.viewer.hours).toBe(5);
    expect((await fetchOrg(nhs.slug, other)).body.viewer.hours).toBe(30);
  });

  it('does not credit an absence', async () => {
    const nhs = await makeOrg('NHS');
    await join(nhs.id, studentId);
    const eventId = await credit(nhs.id, studentId, 8);
    await db.prepare('UPDATE attendance SET present = 0 WHERE event_id = ?').run(eventId);

    expect((await fetchOrg(nhs.slug, student)).body.viewer.hours).toBe(0);
  });

  it('reads zero, not blank, for a member who has not volunteered yet', async () => {
    const nhs = await makeOrg('NHS');
    await join(nhs.id, studentId);

    const res = await fetchOrg(nhs.slug, student);
    expect(res.body.viewer.hours).toBe(0);
    expect(res.body.viewer.events).toBe(0);
  });

  /**
   * Leaving a club does not un-perform the work. The figure is a record of
   * service, not of membership.
   */
  it('keeps the hours of somebody who has since left', async () => {
    const nhs = await makeOrg('NHS');
    await join(nhs.id, studentId);
    await credit(nhs.id, studentId, 12);
    await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
      .run(nhs.id, studentId);

    const res = await fetchOrg(nhs.slug, student);
    expect(res.body.viewer.isMember).toBe(false);
    expect(res.body.viewer.hours).toBe(12);
  });

  /**
   * One event with three shifts is one thing somebody did. Listing it three
   * times makes a short record look padded, which is the failure the transcript
   * was already fixed for.
   */
  it('lists one history row per event, not one per shift', async () => {
    const nhs = await makeOrg('NHS');
    await join(nhs.id, studentId);
    await credit(nhs.id, studentId, 3, { shifts: 3, title: 'Two Shift Day' });

    const res = await fetchOrg(nhs.slug, student);

    expect(res.body.viewer.history).toHaveLength(1);
    expect(res.body.viewer.history[0].title).toBe('Two Shift Day');
    expect(res.body.viewer.history[0].shifts).toBe(3);
    expect(res.body.viewer.history[0].hours).toBe(3);
    expect(res.body.viewer.events).toBe(1);
  });

  /**
   * ── The privacy boundary ──
   *
   * A manager sees what their own organization's events produced, because they
   * are the person who confirmed the attendance that produced it. An ordinary
   * member sees nobody's figure but their own: these are schoolchildren, and a
   * roster carrying everyone's hours is a leaderboard.
   */
  describe('who sees whose figures', () => {
    it('gives a manager each member\'s hours and the organization total', async () => {
      const nhs = await makeOrg('NHS');
      await join(nhs.id, studentId);
      await credit(nhs.id, studentId, 7);

      const res = await fetchOrg(nhs.slug, manager);

      expect(res.body.members.find(m => m.id === studentId).hours).toBe(7);
      expect(res.body.totals.hours).toBe(7);
      expect(res.body.totals.volunteers).toBe(1);
    });

    it('gives an ordinary member no figure for anybody else', async () => {
      const nhs = await makeOrg('NHS');
      await join(nhs.id, studentId);
      await join(nhs.id, otherId);
      await credit(nhs.id, otherId, 30);

      const res = await fetchOrg(nhs.slug, student);

      expect(res.body.totals).toBeNull();
      for (const m of res.body.members) {
        expect(m, `hours leaked for ${m.username}`).not.toHaveProperty('hours');
      }
    });

    it('never hands a club somebody\'s platform-wide total', async () => {
      const nhs = await makeOrg('NHS');
      await join(nhs.id, studentId);
      await credit(nhs.id, studentId, 2);
      /* Forty hours earned elsewhere, for nobody's organization. */
      await credit(null, studentId, 40);

      const res = await fetchOrg(nhs.slug, manager);

      expect(res.body.members.find(m => m.id === studentId).hours).toBe(2);
      expect(res.body.totals.hours).toBe(2);
    });
  });
});
