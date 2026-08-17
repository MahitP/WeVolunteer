import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A login address, a school and a year group are privileged fields, on EVERY
 * route that can reach them.
 *
 * `profileSerializer.js` has always said so — `email` is in `PRIVILEGED_FIELDS`,
 * `grade` and `school` are `PUBLIC_ONLY_FIELDS` withheld unless the subject's
 * `profile_visibility` opens them, and that column defaults to `'private'`. The
 * volunteer profile and the directory implement it. Three other routes reached
 * the same columns by a different path and published them anyway, so the
 * serializer's rule was the intention and these routes were the policy.
 *
 * Each case below is the disclosure a signed-in student could obtain with no
 * privilege at all.
 */
describe('privileged profile fields are gated on every route that can reach them', () => {
  let srv, db;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
  }, 60000);
  afterAll(async () => { await srv?.close(); });

  /**
   * The organizer profile published `row.email` unconditionally.
   *
   * Its subjects are `role IN ('organizer','admin')`, and `GET /api/events`
   * already hands every signed-in caller an `organizerId` for every event — so
   * walking those ids collected the address of every organizer and every
   * administrator, i.e. the accounts holding `user.suspend`, `report.resolve`
   * and `capability.grant`.
   */
  describe('GET /api/organizers/:id/profile', () => {
    it('withholds the organizer email from a student', async () => {
      const student = await srv.login('leo.chen@example.com');
      const res = await srv.call('GET', '/api/organizers/user-org-1/profile', undefined, student);
      expect(res.status).toBe(200);
      expect(res.body.organizer.email).toBeNull();
      /* The hosting record itself stays public-facing — this is a field gate,
         not a new route gate. */
      expect(res.body.organizer.name).toBeTruthy();
      expect(res.body.stats).toBeTruthy();
    });

    it('withholds an ADMINISTRATOR email from a student', async () => {
      const student = await srv.login('leo.chen@example.com');
      const res = await srv.call('GET', '/api/organizers/user-admin/profile', undefined, student);
      /* A deleted admin row answers 404; a live one must answer without the
         address. Either is acceptable — a leak is not. */
      if (res.status === 200) expect(res.body.organizer.email).toBeNull();
      else expect(res.status).toBe(404);
    });

    it('still shows an organizer their own address', async () => {
      const org = await srv.login('jordan.whitfield@example.org');
      const res = await srv.call('GET', '/api/organizers/user-org-1/profile', undefined, org);
      expect(res.status).toBe(200);
      expect(res.body.organizer.email).toBe('jordan.whitfield@example.org');
    });

    it('shows an admin the address, because admin holds user.contact.read', async () => {
      const admin = await srv.login('admin@example.gov');
      const res = await srv.call('GET', '/api/organizers/user-org-1/profile', undefined, admin);
      expect(res.status).toBe(200);
      expect(res.body.organizer.email).toBe('jordan.whitfield@example.org');
    });
  });

  /**
   * The attendee roster gave a co-attendee both of a volunteer's
   * `PUBLIC_ONLY_FIELDS`, which the directory refuses to the same reader.
   */
  describe('GET /api/events/:id/attendees', () => {
    /** Two accepted volunteers on one event, so the caller is a genuine peer. */
    const seedRoster = async () => {
      const ev = (await db.prepare("SELECT id FROM events WHERE status != 'cancelled' LIMIT 1").get()).id;
      const slot = await db.prepare('SELECT id FROM slots WHERE event_id = ? LIMIT 1').get(ev);
      if (!slot) return null;
      await db.prepare("UPDATE events SET attendee_visibility = 'accepted' WHERE id = ?").run(ev);
      await db.prepare("UPDATE users SET profile_visibility = 'private', school = 'PRIVATE-SCHOOL', grade = '11' WHERE id = 'user-student-2'").run();
      for (const uid of ['user-student-1', 'user-student-2']) {
        await db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
          VALUES (?, ?, ?, ?, 'accepted', ?)
      ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, event_id = excluded.event_id, slot_id = excluded.slot_id, status = excluded.status, applied_at = excluded.applied_at`).run(`app-roster-${uid}`, uid, ev, slot.id, new Date().toISOString());
      }
      return ev;
    };

    it('withholds a private peer\'s school and grade from a co-attendee', async () => {
      const ev = await seedRoster();
      if (!ev) return;
      const peer = await srv.login('leo.chen@example.com');
      const res = await srv.call('GET', `/api/events/${ev}/attendees`, undefined, peer);
      expect(res.status).toBe(200);
      expect(res.body.visible).toBe(true);
      const subject = res.body.attendees.find(a => a.id === 'user-student-2');
      expect(subject, 'the peer should still be listed').toBeTruthy();
      expect(subject.name).toBeTruthy();
      expect(subject.school).toBeUndefined();
      expect(subject.grade).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('PRIVATE-SCHOOL');
    });

    it('still gives the hosting organizer school and grade', async () => {
      const ev = await seedRoster();
      if (!ev) return;
      const organizerId = (await db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(ev)).organizer_id;
      const email = (await db.prepare('SELECT email FROM users WHERE id = ?').get(organizerId)).email;
      const host = await srv.login(email);
      const res = await srv.call('GET', `/api/events/${ev}/attendees`, undefined, host);
      expect(res.status).toBe(200);
      const subject = res.body.attendees.find(a => a.id === 'user-student-2');
      expect(subject.school).toBe('PRIVATE-SCHOOL');
      expect(subject.grade).toBe('11');
    });
  });

  /** The same column, published on every conversation payload. */
  describe('conversation payloads', () => {
    it('carry no school for the other participant', async () => {
      const student = await srv.login('leo.chen@example.com');
      const res = await srv.call('GET', '/api/messages/conversations', undefined, student);
      expect(res.status).toBe(200);
      for (const c of (res.body.conversations ?? [])) {
        if (c.otherParticipant) expect(c.otherParticipant.school).toBeUndefined();
      }
    });
  });

  /**
   * The tag vocabulary was registered AFTER `/api/events/:id` on the same
   * router, so Express read `tags` as an event id and answered 404 — while the
   * client called it for the browse filter bar and the event form's suggestions.
   * Its own comment claimed it was declared above. Fails closed, so not a
   * vulnerability; it just did not work.
   */
  describe('GET /api/events/tags', () => {
    it('is reachable rather than shadowed by /api/events/:id', async () => {
      const student = await srv.login('leo.chen@example.com');
      const res = await srv.call('GET', '/api/events/tags', undefined, student);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Array.isArray(res.body.tags)).toBe(true);
    });

    it('does not stop /api/events/:id resolving a real id', async () => {
      const org = await srv.login('jordan.whitfield@example.org');
      const ev = await db.prepare('SELECT id FROM events WHERE organizer_id = ? LIMIT 1').get('user-org-1');
      if (!ev) return;
      const res = await srv.call('GET', `/api/events/${ev.id}`, undefined, org);
      expect(res.status).toBe(200);
      expect(res.body.event.id).toBe(ev.id);
    });
  });
});
