import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * What an organizer is told about a volunteer's follow-through.
 *
 * ── The unfairness these guard against ──
 *
 * "7 of 9" invites exactly one reading: that somebody missed two shifts. That
 * reading is wrong whenever an organizer simply never confirmed attendance —
 * and the volunteer can neither make that happen nor see it being held against
 * them when they apply somewhere else.
 *
 * So the endpoint publishes the whole decomposition, and never a rate. The
 * repository already argues this in four places; these tests are what keep the
 * argument true.
 */

const ORGANIZER = 'jordan.whitfield@example.org';

describe('applicant reliability figures', () => {
  let srv;
  let organizer;
  let applicants;

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login(ORGANIZER);

    const events = (await srv.call('GET', '/api/events', undefined, organizer)).body;
    const list = Array.isArray(events) ? events : events.events;
    for (const event of list) {
      const res = await srv.call('GET', `/api/events/${event.id}/applications`, undefined, organizer);
      if (res.status === 200 && res.body.length > 0) { applicants = res.body; break; }
    }
    if (!applicants) {
      applicants = (await srv.call('GET', '/api/applications', undefined, organizer)).body;
    }
    expect(applicants?.length, 'the seed has no applicants to review').toBeGreaterThan(0);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('publishes attended, signed up, absent and awaiting-record together', () => {
    const v = applicants[0].volunteer;
    expect(v.eventsSignedUp).toBeTypeOf('number');
    expect(v.eventsAttended).toBeTypeOf('number');
    /* `eventsAbsent` was computed and then dropped, which left an organizer
       unable to tell a missed shift from unfinished paperwork. */
    expect(v.eventsAbsent).toBeTypeOf('number');
    expect(v.eventsAwaitingRecord).toBeTypeOf('number');
  });

  it('keeps the four figures consistent with each other', () => {
    for (const app of applicants) {
      const v = app.volunteer;
      expect(
        v.eventsAttended + v.eventsAbsent + v.eventsAwaitingRecord,
        'signedUp must decompose exactly into attended, absent and awaiting',
      ).toBe(v.eventsSignedUp);
    }
  });

  it('never publishes a rate', () => {
    /* "1 of 2 — 50%" reads as a verdict on a person when the evidence behind
       it is one missed shift, and a reader cannot un-see the number. */
    for (const app of applicants) {
      const keys = Object.keys(app.volunteer);
      expect(keys.filter(k => /rate|percent|score|reliability/i.test(k))).toEqual([]);
    }
  });

  it('never counts an upcoming shift against somebody', () => {
    /* `signedUp` counts only commitments whose shift has ENDED, so a volunteer
       is never marked down for a shift they have not had the chance to attend. */
    for (const app of applicants) {
      const v = app.volunteer;
      expect(v.eventsAttended).toBeLessThanOrEqual(v.eventsSignedUp);
    }
  });

  describe('the badges the row can show', () => {
    /**
     * The seed confers none, so these have to award some.
     *
     * Written after discovering the first draft was vacuous: twelve applicants,
     * zero `user_badges` rows, and every loop below iterating over nothing while
     * reporting a pass. The fixture awards three real catalogue badges to one
     * applicant — a status badge and two tiers of one progression — because that
     * is the shape the selection logic has to get right.
     */
    let subject;
    let awarded;

    beforeAll(async () => {
      const { db } = await import('./db.js');
      subject = applicants[0].volunteer.id;

      const names = ['Reliable Volunteer', '25 Hours', '50 Hours'];
      awarded = [];
      for (const name of names) {
        const badge = await db.prepare('SELECT id FROM badges WHERE name = ? AND active = 1').get(name);
        expect(badge, `the catalogue has no active "${name}" — has it been renamed?`).toBeTruthy();
        await db.prepare(`
          INSERT INTO user_badges (id, user_id, badge_id, earned_at, awarded_by)
          VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT DO NOTHING
        `).run(`ub-fixture-${awarded.length}`, subject, badge.id, new Date().toISOString());
        awarded.push(name);
      }

      applicants = (await srv.call('GET', '/api/applications', undefined, organizer)).body;
      const onPage = applicants.reduce((n, a) => n + a.volunteer.badges.length, 0);
      expect(onPage, 'the fixture awarded nothing the endpoint can see').toBeGreaterThanOrEqual(3);
    }, 60000);

    it('publishes every badge the volunteer holds', () => {
      const v = applicants.find(a => a.volunteer.id === subject).volunteer;
      expect(v.badges.map(b => b.name).sort()).toEqual([...awarded].sort());
    });

    it('leaves the other applicants with an empty list rather than no field', () => {
      /* `organizerBadges` returns `[]` for a non-array, so a missing field would
         not crash — it would silently mean "no badges" for everybody. */
      for (const app of applicants.filter(a => a.volunteer.id !== subject)) {
        expect(app.volunteer.badges).toEqual([]);
      }
    });

    it('omits a retired definition', async () => {
      /**
       * A retired badge keeps its `user_badges` row on purpose — nobody's record
       * is edited when the catalogue changes — but it is not current standing
       * and must not be presented as such.
       */
      const { db } = await import('./db.js');
      const badge = await db.prepare('SELECT id FROM badges WHERE name = ?').get('Reliable Volunteer');
      await db.prepare('UPDATE badges SET active = 0 WHERE id = ?').run(badge.id);

      const refetched = (await srv.call('GET', '/api/applications', undefined, organizer)).body;
      const v = refetched.find(a => a.volunteer.id === subject).volunteer;

      expect(v.badges.map(b => b.name)).not.toContain('Reliable Volunteer');
      expect(v.badges.map(b => b.name).sort(), 'the others must survive').toEqual(['25 Hours', '50 Hours']);

      await db.prepare('UPDATE badges SET active = 1 WHERE id = ?').run(badge.id);
    });

    it('publishes a list for every applicant', () => {
      /* Absent entirely before this: the client had nothing to render, so
         `organizerBadges` existed and was wired to nothing. */
      for (const app of applicants) {
        expect(Array.isArray(app.volunteer.badges), `${app.volunteer.name} has no badges array`).toBe(true);
      }
    });

    it('gives each badge everything the client needs to choose and label it', () => {
      /* `organizerBadges` selects on `category` and `criteria_type`, and the
         chip renders `icon` and `name`. A payload missing any of them silently
         renders an empty or unselectable chip. */
      for (const app of applicants) {
        for (const b of app.volunteer.badges) {
          expect(b).toHaveProperty('name');
          expect(b).toHaveProperty('icon');
          expect(b).toHaveProperty('category');
          expect(b).toHaveProperty('criteria_type');
        }
      }
    });

    it('matches the database row for row', async () => {
      const { db } = await import('./db.js');
      for (const app of applicants) {
        const held = (await db.prepare(`
          SELECT COUNT(*) AS c FROM user_badges ub
          JOIN badges b ON b.id = ub.badge_id
          WHERE ub.user_id = ? AND b.active = 1
        `).get(app.volunteer.id)).c;
        expect(app.volunteer.badges.length).toBe(held);
      }
    });

    it('is one query for the whole page, not one per applicant', async () => {
      /**
       * The reason this is asserted rather than assumed. The two figures above
       * it are batched deliberately — a per-row read would be twenty round
       * trips to draw three chips — and a future edit moving the badge read
       * inside the `map` would pass every other test in this file.
       *
       * Measured as time rather than query count, which is crude but is the
       * only handle available from outside: a per-row implementation on a page
       * of this size is not subtle.
       */
      const started = process.hrtime.bigint();
      const res = await srv.call('GET', '/api/applications', undefined, organizer);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;

      expect(res.status).toBe(200);
      expect(ms, `${applicants.length} applicants took ${ms.toFixed(0)}ms`).toBeLessThan(1500);
    });

    it('never leaks a private field through the badge join', () => {
      /* The join reaches `badges`, not `users`, but a `SELECT b.*` would carry
         whatever that table grows next. Named columns only. */
      for (const app of applicants) {
        for (const b of app.volunteer.badges) {
          expect(Object.keys(b).sort()).toEqual(
            ['category', 'criteria_type', 'criteria_value', 'earnedAt', 'icon', 'name'],
          );
        }
      }
    });
  });
});
