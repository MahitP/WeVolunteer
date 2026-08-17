import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * What counts as service for an organization, and what must never.
 *
 * ── The property under test ──
 *
 * Organization hours are not a second hours system. They are the SAME sum —
 * `SUM(attendance.hours_awarded) WHERE present = 1` — restricted by
 * `events.organization_id`. So the interesting cases are all about the
 * boundary: what gets in that should not, and what stays out that should.
 *
 * Two of the brief's hardest questions turn out to be answered by the schema
 * rather than by code, and these pin that so a later migration cannot quietly
 * unanswer them:
 *
 *   • An event has ONE owning organization (`events.organization_id` is a single
 *     nullable FK), so the "two clubs jointly host, do we double-count" case
 *     cannot arise.
 *   • `external_hours.organization_name` is FREE TEXT with no foreign key, so a
 *     self-logged "4 hours at a food bank" is structurally incapable of becoming
 *     4 hours for NHS.
 */

let srv, db;
let student, studentId;
let managerCookie, managerId;
let outsider;
let orgA, orgB;

/** Creates an organization directly, returning its id. */
async function makeOrg(name, slug, status = 'active') {
  const id = `org-test-${slug}`;
  await db.prepare(`
    INSERT INTO organizations (id, name, slug, description, created_by, status, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, ?, ?, ?)
  `).run(id, name, slug, managerId, status, new Date().toISOString(), new Date().toISOString());
  return id;
}

const join = async (orgId, userId, role = 'member') =>
  await db.prepare(`
    INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
    VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role, joined_at = excluded.joined_at
  `).run(orgId, userId, role, new Date().toISOString());

/** An event owned by `orgId` (or by nobody), with one shift somebody attended. */
async function attendedEvent({ orgId, title, hours, userId, creditsHours = 1, status = 'completed' }) {
  const eventId = `ev-${title.replace(/\W/g, '')}-${Math.abs(hours * 100)}`;
  const slotId = `slot-${eventId}`;
  const past = '2026-01-01T10:00:00.000Z';
  await db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, status, created_at, organization_id, credits_hours)
    VALUES (?, ?, '', 'Other', 'Somewhere', ?, ?, ?, ?, ?, ?)
  `).run(eventId, title, past, managerId, status, past, orgId, creditsHours);
  await db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, 'Shift', '', ?, ?, 5)
  `).run(slotId, eventId, past, past);
  await db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, 1, ?)
  `).run(eventId, slotId, userId, hours);
  return eventId;
}

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;

  const mk = async (n, role = 'student') => {
    const { cookie, user } = await srv.signupConfirmed({
      name: `Org Service ${n}`,
      email: `org.service.${n}@example.org`,
      username: `orgservice${n}`,
      password: 'Password123',
      role,
      grade: '11',
    });
    return { cookie, id: user.id };
  };

  /* A STUDENT who manages the club. Organization management is `member_role`
     in `organization_members`, not the platform role — and an organizer signup
     starts pending approval, which is not what this file is about. */
  const m = await mk('mgr'); managerCookie = m.cookie; managerId = m.id;
  const s = await mk('stu'); student = s.cookie; studentId = s.id;
  const o = await mk('out'); outsider = o.cookie;

  orgA = await makeOrg('Alpha Club', 'alpha-club');
  orgB = await makeOrg('Beta Club', 'beta-club');
  await join(orgA, managerId, 'manager');
  await join(orgA, studentId);
  await join(orgB, studentId);

  /* 3 + 2 = 5 hours for A, 7 for B. */
  await attendedEvent({ orgId: orgA, title: 'A One', hours: 3, userId: studentId });
  await attendedEvent({ orgId: orgA, title: 'A Two', hours: 2, userId: studentId });
  await attendedEvent({ orgId: orgB, title: 'B One', hours: 7, userId: studentId });

  /* Owned by nobody: counts platform-wide, toward no organization. */
  await attendedEvent({ orgId: null, title: 'Independent', hours: 11, userId: studentId });

  /* Cancelled after attendance was confirmed — see the note in
     organizationHours.js on why the hours survive and the COUNT does not. */
  await attendedEvent({ orgId: orgA, title: 'A Cancelled', hours: 4, userId: studentId, status: 'cancelled' });

  /* Self-logged, and therefore never anybody's organization hours. */
  await db.prepare(`
    INSERT INTO external_hours (id, user_id, organization_name, activity_name, description,
                                occurred_on, hours, created_at, updated_at)
    VALUES ('ext-1', ?, 'Alpha Club', 'Food bank', '', '2026-01-02', 40, ?, ?)
  `).run(studentId, new Date().toISOString(), new Date().toISOString());
});

afterAll(async () => { await srv?.close?.(); });

const orgPage = (cookie, slug) => srv.call('GET', `/api/organizations/${slug}`, undefined, cookie);

describe('hours are scoped to the organization that ran the event', () => {
  it('counts only that organization’s events', async () => {
    const res = await orgPage(student, 'alpha-club');
    expect(res.status).toBe(200);
    /* 3 + 2 = 5. The cancelled event's 4 hours count for nothing, and neither
       does the event itself. */
    expect(res.body.viewer.hours).toBe(5);
    expect(res.body.viewer.events).toBe(2);
  });

  it('does not leak another organization’s hours in', async () => {
    /* B's 7 hours must not appear under A, and vice versa. */
    const a = await orgPage(student, 'alpha-club');
    const b = await orgPage(student, 'beta-club');
    expect(a.body.viewer.hours).toBe(5);
    expect(b.body.viewer.hours).toBe(7);
  });

  it('excludes events no organization owns', async () => {
    /**
     * The 11-hour independent event counts toward the platform total and toward
     * no club. Worth pinning because the natural expectation is that the club
     * figures sum to the total — they do not, and should not.
     */
    const a = await orgPage(student, 'alpha-club');
    const b = await orgPage(student, 'beta-club');
    expect(a.body.viewer.hours + b.body.viewer.hours).toBe(12);

    const profile = await srv.call('GET', `/api/users/${studentId}/public-profile`, undefined, student);
    expect(profile.body.profile.stats.hours).toBe(23); // 5 + 7 + 11, the cancelled 4 excluded
  });

  it('never counts self-logged external hours', async () => {
    /**
     * THE case from §8 of the brief. The external row above names "Alpha Club"
     * as free text and carries 40 hours; if organization attribution ever went
     * through that string instead of the foreign key, Alpha would read 45.
     */
    const res = await orgPage(student, 'alpha-club');
    expect(res.body.viewer.hours, 'external hours were attributed to an organization').toBe(5);
  });

  it('cannot double-count, because an event has one owning organization', async () => {
    /**
     * Asked of the DATA rather than of the catalogue.
     *
     * This used `PRAGMA table_info` and `sqlite_master`, neither of which
     * PostgreSQL has, so the whole assertion errored there — and what it is
     * really claiming is engine-independent: an event carries exactly one
     * owning organization, so there is nothing to double-count.
     *
     * `SELECT organization_id … LIMIT 0` proves the column exists on either
     * engine (it raises if it does not) without depending on how the engine
     * spells its catalogue.
     */
    await db.prepare('SELECT organization_id FROM events LIMIT 0').all();

    /* And no join table, so there is no second owner to attribute to. A missing
       relation raises on both engines, so the absence is the passing case. */
    let joinTableExists = true;
    try {
      await db.prepare('SELECT 1 FROM event_organizations LIMIT 0').all();
    } catch {
      joinTableExists = false;
    }
    expect(joinTableExists, 'events gained multiple owners — attribution now needs a rule').toBe(false);
  });
});

describe('the history behind the number', () => {
  it('lists only that organization’s events, newest first', async () => {
    const res = await orgPage(student, 'alpha-club');
    const titles = res.body.viewer.history.map(h => h.title);
    expect(titles).toHaveLength(2);
    expect(titles).toContain('A One');
    expect(titles).toContain('A Two');
    expect(titles).not.toContain('B One');
    expect(titles).not.toContain('Independent');
  });

  it('sums to the headline figure', async () => {
    /* The list and the total must be the same arithmetic, or the page argues
       with itself. */
    const res = await orgPage(student, 'alpha-club');
    const summed = res.body.viewer.history.reduce((n, h) => n + h.hours, 0);
    expect(summed).toBe(res.body.viewer.hours);
  });
});

describe('who may see per-member figures', () => {
  it('a manager sees them for their own organization', async () => {
    const res = await orgPage(managerCookie, 'alpha-club');
    expect(res.status).toBe(200);
    const row = res.body.members.find(m => m.id === studentId);
    expect(row.hours).toBe(5);
  });

  it('an ordinary member sees nobody else’s', async () => {
    /* A roster ranked by hours is a leaderboard nobody asked for. */
    const res = await orgPage(student, 'alpha-club');
    expect(res.body.members.every(m => !('hours' in m))).toBe(true);
    expect(res.body.totals).toBeNull();
  });

  it('a manager of one organization learns nothing about another', async () => {
    /**
     * The organization boundary from §7. The Alpha manager is not a member of
     * Beta, so Beta's page gives them no per-member figures and no totals — and
     * the derivation is scoped by `organization_id`, so there is no query that
     * could return Alpha's student's Beta hours to them.
     */
    const res = await orgPage(managerCookie, 'beta-club');
    expect(res.body.members.every(m => !('hours' in m))).toBe(true);
    expect(res.body.totals).toBeNull();
  });

  it('a manager never sees the platform-wide total', async () => {
    const res = await orgPage(managerCookie, 'alpha-club');
    const serialised = JSON.stringify(res.body);
    /* 23 is the student's platform total; 11 is the independent event that is
       none of this club's business. Neither may appear. */
    expect(res.body.members.find(m => m.id === studentId).hours).toBe(5);
    expect(serialised).not.toContain('"hours":23');
    expect(serialised).not.toContain('"hours":11');
  });

  it('somebody who is not a member gets no figures at all', async () => {
    const res = await orgPage(outsider, 'alpha-club');
    expect(res.body.viewer.hours).toBe(0);
    expect(res.body.members.every(m => !('hours' in m))).toBe(true);
    expect(res.body.totals).toBeNull();
  });
});

describe('the profile’s organization list', () => {
  it('carries per-organization hours for a viewer who may see them', async () => {
    const res = await srv.call('GET', `/api/users/${studentId}/public-profile`, undefined, student);
    const orgs = res.body.profile.organizations;
    const alpha = orgs.find(o => o.slug === 'alpha-club');
    const beta = orgs.find(o => o.slug === 'beta-club');
    expect(alpha.hours).toBe(5);
    expect(beta.hours).toBe(7);
    expect(alpha.events).toBe(2);
  });

  it('withholds the hours when the subject keeps their service private', async () => {
    /**
     * The privacy rule this feature had to respect rather than reinvent:
     * organization hours ARE service hours, so `hours_visibility` governs them.
     * Publishing twelve per-club numbers while withholding the total would make
     * the setting decorative.
     */
    await srv.call('PATCH', '/api/auth/profile', { hoursVisibility: 'private' }, student);

    const res = await srv.call('GET', `/api/users/${studentId}/public-profile`, undefined, outsider);
    const orgs = res.body.profile.organizations;

    expect(orgs.length, 'membership itself is still listed').toBeGreaterThan(0);
    for (const o of orgs) {
      expect(o, `hours leaked for ${o.slug}`).not.toHaveProperty('hours');
      expect(o).not.toHaveProperty('events');
    }
    expect(JSON.stringify(res.body)).not.toContain('"hours":5');

    await srv.call('PATCH', '/api/auth/profile', { hoursVisibility: 'public' }, student);
  });

  it('still shows the subject their own figures when private', async () => {
    await srv.call('PATCH', '/api/auth/profile', { hoursVisibility: 'private' }, student);
    const res = await srv.call('GET', `/api/users/${studentId}/public-profile`, undefined, student);
    expect(res.body.profile.organizations.find(o => o.slug === 'alpha-club').hours).toBe(5);
    await srv.call('PATCH', '/api/auth/profile', { hoursVisibility: 'public' }, student);
  });
});

describe('an archived organization', () => {
  it('stays on the profile, marked, with its hours intact', async () => {
    /**
     * The regression this fixes: `organizationsFor` filtered on
     * `status = 'active'`, so a club winding up at the end of the year erased
     * every member's history with it. `organizationHours.js` deliberately keeps
     * a volunteer's hours after they LEAVE a club — an organization closing is
     * even less their doing.
     */
    await db.prepare("UPDATE organizations SET status = 'archived' WHERE id = ?").run(orgA);

    const res = await srv.call('GET', `/api/users/${studentId}/public-profile`, undefined, student);
    const alpha = res.body.profile.organizations.find(o => o.slug === 'alpha-club');

    expect(alpha, 'an archived organization vanished from the profile').toBeTruthy();
    expect(alpha.archived).toBe(true);
    expect(alpha.hours).toBe(5);

    await db.prepare("UPDATE organizations SET status = 'active' WHERE id = ?").run(orgA);
  });

  it('marks only the archived one', async () => {
    const res = await srv.call('GET', `/api/users/${studentId}/public-profile`, undefined, student);
    expect(res.body.profile.organizations.every(o => o.archived === false)).toBe(true);
  });
});

describe('the transcript payload', () => {
  it('names the organization on each completed row, so it can be filtered', async () => {
    const res = await srv.call('GET', `/api/users/${studentId}/profile`, undefined, student);
    const rows = res.body.completed;

    const alphaRows = rows.filter(r => r.organizationSlug === 'alpha-club');
    expect(alphaRows.reduce((n, r) => n + r.hours, 0)).toBe(5);

    /* The independent event carries null rather than being dropped — it belongs
       in the full transcript and in no club's. */
    const independent = rows.find(r => r.title === 'Independent');
    expect(independent.organizationSlug).toBeNull();
    expect(independent.organizationName).toBeNull();
  });
});

describe('a cancelled event is not completed service', () => {
  /**
   * The transcript is a record of what somebody DID. An event that was called
   * off is not that, and printing it as a verified row under a student's name —
   * where a college or a scholarship committee will read it — is a claim this
   * platform cannot support.
   *
   * `PUT /api/events/:id` deliberately refuses to delete attendance rows, so the
   * confirmation survives the cancellation and every query has to exclude it
   * explicitly. These cases cover the four places that must agree.
   */
  it('does not appear as a transcript row', async () => {
    const res = await srv.call('GET', `/api/users/${studentId}/profile`, undefined, student);
    const titles = res.body.completed.map(r => r.title);

    expect(titles, 'a cancelled event was printed as verified service').not.toContain('A Cancelled');
    /* The control: the non-cancelled service is untouched. */
    expect(titles).toContain('A One');
    expect(titles).toContain('A Two');
    expect(titles).toContain('Independent');
  });

  it('contributes no hours anywhere', async () => {
    /* 4 hours were awarded on it and none of them may show up. */
    const profile = await srv.call('GET', `/api/users/${studentId}/public-profile`, undefined, student);
    const org = await orgPage(student, 'alpha-club');

    expect(profile.body.profile.stats.hours).toBe(23);   // not 27
    expect(org.body.viewer.hours).toBe(5);               // not 9
    expect(org.body.viewer.history.reduce((n, h) => n + h.hours, 0)).toBe(5);
  });

  it('is absent from the organization history behind the number', async () => {
    const res = await orgPage(student, 'alpha-club');
    expect(res.body.viewer.history.map(h => h.title)).not.toContain('A Cancelled');
  });

  it('leaves the organization count and the transcript rows agreeing', async () => {
    /**
     * THE property this change exists for. The organization page said 3 events
     * and the transcript one click away printed 4 rows, because one query
     * excluded cancelled events and the other did not.
     */
    const org = await orgPage(student, 'alpha-club');
    const profile = await srv.call('GET', `/api/users/${studentId}/profile`, undefined, student);
    const transcriptRows = profile.body.completed.filter(r => r.organizationSlug === 'alpha-club');
    const distinctEvents = new Set(transcriptRows.map(r => r.eventId)).size;

    expect(distinctEvents, 'the org event count and the transcript disagree').toBe(org.body.viewer.events);
  });
});
