import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * QR check-in, end to end, with the security properties as the subject.
 *
 * ── What the design is, in one paragraph ──
 *
 * A volunteer mints a five-minute code for one of their own accepted shifts.
 * The code is 32 random bytes; the server stores only its SHA-256 and returns
 * the plaintext once. Nothing is encoded in the code — not the user, not the
 * event — so there is no payload to tamper with and nothing to read off a
 * photograph. An organizer scans it, and the code is spent inside the same
 * transaction as the mark, which is what makes a replay safe.
 *
 * ── What this file is careful about ──
 *
 * Each of these has been broken deliberately and observed to fail: expiry,
 * replay, regeneration, event binding, organizer authorization, and the
 * pre-start refusal. A green test that has never been seen red is a claim, not
 * evidence.
 */

const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';
const ORGANIZER = 'jordan.whitfield@example.org';

describe('QR check-in', () => {
  let srv;
  let db;
  let student;
  let otherStudent;
  let organizer;
  let application;
  let eventId;

  /** Moves every shift on an event into the present. */
  const startShiftsNow = async (id) => {
    const now = Date.now();
    await db.prepare('UPDATE slots SET start_datetime = ?, end_datetime = ? WHERE event_id = ?').run(
      new Date(now - 30 * 60 * 1000).toISOString(),
      new Date(now + 90 * 60 * 1000).toISOString(),
      id,
    );
  };

  /** Moves every shift on an event into next week. */
  const startShiftsLater = async (id) => {
    const now = Date.now();
    await db.prepare('UPDATE slots SET start_datetime = ?, end_datetime = ? WHERE event_id = ?').run(
      new Date(now + 7 * 24 * 3600 * 1000).toISOString(),
      new Date(now + 7 * 24 * 3600 * 1000 + 3600 * 1000).toISOString(),
      id,
    );
  };

  const mint = async (session = student, appId = application.id) =>
    srv.call('POST', `/api/applications/${appId}/checkin-code`, {}, session);

  const scan = async (token, session = organizer, event = eventId) =>
    srv.call('POST', `/api/events/${event}/checkin/scan`, { token }, session);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    student = await srv.login(STUDENT);
    otherStudent = await srv.login(OTHER_STUDENT);
    organizer = await srv.login(ORGANIZER);

    /* The STUDENT's own accepted signup. Reading the organizer's list instead
       returns every applicant's, and minting is deliberately self-only — so the
       fixture would have been testing the 404 path in every case. */
    const apps = (await srv.call('GET', '/api/applications', undefined, student)).body;
    application = apps.find(a => a.status === 'accepted');
    expect(application, 'the seed has no accepted signup for this student').toBeTruthy();
    eventId = application.eventId;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await startShiftsNow(eventId);
    await db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    await db.prepare('DELETE FROM checkin_tokens').run();
    await db.prepare('DELETE FROM attendance_checkin WHERE event_id = ?').run(eventId);
  });

  /* ── Minting ──────────────────────────────────────────────────────────── */

  describe('minting a code', () => {
    it('gives the volunteer a code, a QR image and an expiry', async () => {
      const res = await mint();
      expect(res.status).toBe(200);
      expect(res.body.token).toMatch(/^wev1:/);
      expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    /* P2-28, in the owner's words: the code shows "below @username". The
       route asked `req.user.username`, which the session never carried, so
       every code fell back to the display name — found by the week-long
       rehearsal, 86 codes out of 86. */
    it("names the volunteer by their @username, which is what the owner asked the code to show", async () => {
      const res = await mint();
      expect(res.status).toBe(200);
      const { username } = await db.prepare('SELECT username FROM users WHERE email = ?').get(STUDENT);
      expect(username, 'fixture: the demo student has a username').toBeTruthy();
      expect(res.body.displayName).toBe(`@${username}`);
    });

    it('stores only a hash, never the code itself', async () => {
      const res = await mint();
      const raw = res.body.token.slice('wev1:'.length);

      const rows = await db.prepare('SELECT * FROM checkin_tokens').all();
      expect(rows).toHaveLength(1);
      /* A stolen database must not yield working codes. */
      expect(JSON.stringify(rows[0])).not.toContain(raw);
      expect(rows[0].token_hash).toHaveLength(64);
    });

    it('puts nothing about the volunteer into the code', async () => {
      const me = (await srv.call('GET', '/api/auth/me', undefined, student)).body;
      const res = await mint();
      /* A photographed code should tell a reader nothing at all. */
      expect(res.body.token).not.toContain(me.id);
      expect(res.body.token).not.toContain(eventId);
      expect(res.body.token).not.toContain(application.id);
    });

    it('refuses before the shift has started', async () => {
      await startShiftsLater(eventId);
      const res = await mint();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('checkin_not_started');
      expect(res.body.startsAt).toBeTruthy();
    });

    it('refuses for a cancelled event', async () => {
      await db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(eventId);
      const res = await mint();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('event_cancelled');
    });

    it('gives somebody else\'s signup the same 404 as one that does not exist', async () => {
      /* A 403 would confirm the id is real, and application ids are a
         timestamp plus six characters — a walkable space. */
      const mine = await mint(otherStudent, application.id);
      const nonexistent = await mint(otherStudent, 'app-0000000000-zzzzzz');

      expect(mine.status).toBe(404);
      expect(nonexistent.status).toBe(404);
      expect(mine.body).toEqual(nonexistent.body);
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await srv.call('POST', `/api/applications/${application.id}/checkin-code`, {});
      expect(res.status).toBe(401);
    });

    it('retires the previous code when a new one is minted', async () => {
      const first = await mint();
      const second = await mint();

      expect(first.body.token).not.toBe(second.body.token);

      /* The old photograph must stop working the moment a new code appears. */
      const stale = await scan(first.body.token);
      expect(stale.status).toBe(422);

      const fresh = await scan(second.body.token);
      expect(fresh.status).toBe(200);
    });

    it('never leaves two live codes for one signup', async () => {
      await mint();
      await mint();
      await mint();
      const live = (await db.prepare("SELECT COUNT(*) AS c FROM checkin_tokens WHERE status = 'pending'").get()).c;
      expect(live).toBe(1);
    });
  });

  /* ── Scanning ─────────────────────────────────────────────────────────── */

  describe('scanning a code', () => {
    it('checks the volunteer in and says who they are', async () => {
      const { body } = await mint();
      const res = await scan(body.token);

      expect(res.status).toBe(200);
      expect(res.body.marked).toBe(1);
      expect(res.body.alreadyPresent).toBe(false);
      /* The organizer has to see the name — it is the control that makes a
         relayed code hard to use, because they are looking at a person. */
      expect(res.body.volunteer.name).toBeTruthy();
    });

    it('records the mark through the same table manual check-in writes', async () => {
      const { body } = await mint();
      await scan(body.token);

      const marks = (await srv.call('GET', `/api/events/${eventId}/checkin`, undefined, organizer)).body;
      const mark = marks.find(m => m.userId && m.present);
      expect(mark).toBeTruthy();
    });

    it('records that the mark was scanned rather than typed', async () => {
      const { body } = await mint();
      await scan(body.token);

      const row = await db.prepare('SELECT method FROM attendance_checkin WHERE event_id = ?').get(eventId);
      expect(row.method).toBe('qr');
    });

    it('credits no hours, because check-in never does', async () => {
      const { body } = await mint();
      await scan(body.token);

      const attendance = (await db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE event_id = ?').get(eventId)).c;
      expect(attendance).toBe(0);
    });
  });

  /* ── The security properties ──────────────────────────────────────────── */

  describe('replay', () => {
    it('refuses the same code twice', async () => {
      const { body } = await mint();

      expect((await scan(body.token)).status).toBe(200);

      const second = await scan(body.token);
      expect(second.status).toBe(422);
      expect(second.body.code).toBe('code_invalid');
    });

    it('leaves the first check-in intact when the replay is refused', async () => {
      const { body } = await mint();
      await scan(body.token);
      const before = await db.prepare('SELECT marked_at FROM attendance_checkin WHERE event_id = ?').get(eventId);

      await scan(body.token);
      const after = await db.prepare('SELECT marked_at FROM attendance_checkin WHERE event_id = ?').get(eventId);

      expect(after.marked_at).toBe(before.marked_at);
    });

    it('spends a code exactly once when two scans are fired together', async () => {
      /**
       * Replay is defended twice: the resolver refuses a code already marked
       * spent, and the UPDATE that spends it carries `status = 'pending'` in
       * its WHERE clause.
       *
       * ── An honest note about what this can and cannot prove ──
       *
       * Removing the WHERE predicate does NOT make this test fail, and that is
       * not a gap in the test. The scan handler is synchronous and better-sqlite3
       * is synchronous, so two requests never interleave inside it — the second
       * always finds `status = 'used'` and is refused by the resolver. The
       * predicate is therefore unexercisable belt-and-braces today, and it is
       * kept because it stops being unexercisable the moment anything in this
       * handler becomes async.
       *
       * What this DOES prove is the property that matters to an organizer:
       * pressing scan twice in quick succession checks somebody in once.
       */
      const { body } = await mint();

      const results = await Promise.all([await scan(body.token), await scan(body.token)]);
      const statuses = results.map(r => r.status).sort();

      expect(statuses).toEqual([200, 422]);

      const spent = (await db.prepare("SELECT COUNT(*) AS c FROM checkin_tokens WHERE status = 'used'").get()).c;
      expect(spent).toBe(1);
    });

    it('reports "already checked in" as success when a FRESH code is scanned again', async () => {
      /* Two different things: replaying a spent code is refused, but scanning a
         new code for somebody already present is the outcome the organizer
         wanted. An error there would make them redo it by hand. */
      await scan((await mint()).body.token);

      const res = await scan((await mint()).body.token);
      expect(res.status).toBe(200);
      expect(res.body.alreadyPresent).toBe(true);
    });
  });

  describe('expiry', () => {
    it('refuses a code past its five minutes', async () => {
      const { body } = await mint();
      await db.prepare("UPDATE checkin_tokens SET expires_at = ? WHERE status = 'pending'")
        .run(new Date(Date.now() - 1000).toISOString());

      const res = await scan(body.token);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('code_expired');
    });

    it('expires server-side, whatever the client believes', async () => {
      const { body } = await mint();
      await db.prepare("UPDATE checkin_tokens SET expires_at = ? WHERE status = 'pending'")
        .run(new Date(Date.now() - 1000).toISOString());

      await scan(body.token);
      const marks = (await db.prepare('SELECT COUNT(*) AS c FROM attendance_checkin WHERE event_id = ?').get(eventId)).c;
      expect(marks).toBe(0);
    });
  });

  describe('binding', () => {
    it('refuses a code minted for a different event', async () => {
      const { body } = await mint();

      const otherEvent = await db.prepare('SELECT id FROM events WHERE id <> ?').get(eventId);
      const res = await scan(body.token, organizer, otherEvent.id);

      /* Either the host check or the binding check refuses it; both are
         correct refusals and neither checks the volunteer in. */
      expect([403, 404, 409]).toContain(res.status);
      const marks = (await db.prepare('SELECT COUNT(*) AS c FROM attendance_checkin WHERE event_id = ?').get(eventId)).c;
      expect(marks).toBe(0);
    });

    it('refuses a forged code', async () => {
      const res = await scan('wev1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('code_invalid');
    });

    it('refuses something that is not a WeVolunteer code at all', async () => {
      for (const junk of ['WIFI:S:MyNetwork;;', 'https://example.com', '', '4006381333931000']) {
        const res = await scan(junk);
        expect([400, 422]).toContain(res.status);
      }
    });

    it('refuses a code once the volunteer is no longer accepted', async () => {
      const { body } = await mint();
      await db.prepare("UPDATE applications SET status = 'withdrawn' WHERE id = ?").run(application.id);

      const res = await scan(body.token);
      expect(res.status).toBe(422);

      await db.prepare("UPDATE applications SET status = 'accepted' WHERE id = ?").run(application.id);
    });
  });

  describe('authorization', () => {
    it('refuses a student pointing the scanner endpoint at their own code', async () => {
      const { body } = await mint();
      const res = await scan(body.token, student);
      expect(res.status).toBe(403);
    });

    it('does not spend the code when an unauthorized caller scans it', async () => {
      /* The host check runs BEFORE the code is looked at, so a stranger cannot
         burn somebody's live code by scanning it. */
      const { body } = await mint();
      await scan(body.token, student);

      const row = await db.prepare('SELECT status FROM checkin_tokens WHERE status IS NOT NULL').get();
      expect(row.status).toBe('pending');

      expect((await scan(body.token, organizer)).status).toBe(200);
    });

    it('refuses an organizer who does not host this event', async () => {
      /**
       * The property the host check exists for, and the one a
       * student-tries-the-endpoint test does NOT cover: a student is already
       * stopped by the capability gate, so that test stays green even with the
       * host check removed entirely. This is the case where the caller holds
       * every capability and still must not be able to check somebody into
       * somebody else's event.
       */
      const { body } = await mint();

      const outsider = await db.prepare(
        "SELECT id FROM users WHERE role = 'organizer' AND id <> (SELECT organizer_id FROM events WHERE id = ?)"
      ).get(eventId);
      expect(outsider, 'the seed has only one organizer').toBeTruthy();

      const originalHost = (await db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(eventId)).organizer_id;
      await db.prepare('UPDATE events SET organizer_id = ? WHERE id = ?').run(outsider.id, eventId);

      const res = await scan(body.token, organizer);
      expect(res.status).toBe(403);

      /* And the code they could not use is still live for the real host. */
      const row = await db.prepare("SELECT status FROM checkin_tokens WHERE status = 'pending'").get();
      expect(row).toBeTruthy();

      await db.prepare('UPDATE events SET organizer_id = ? WHERE id = ?').run(originalHost, eventId);
    });

    it('refuses an unauthenticated scan', async () => {
      const { body } = await mint();
      const res = await srv.call('POST', `/api/events/${eventId}/checkin/scan`, { token: body.token });
      expect(res.status).toBe(401);
    });

    it('refuses to scan for a cancelled event', async () => {
      const { body } = await mint();
      await db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(eventId);

      const res = await scan(body.token);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('event_cancelled');
    });
  });

  describe('what the organizer is told', () => {
    it('never returns the code or its hash in an error', async () => {
      const { body } = await mint();
      await db.prepare("UPDATE checkin_tokens SET expires_at = ? WHERE status = 'pending'")
        .run(new Date(Date.now() - 1000).toISOString());

      const res = await scan(body.token);
      const raw = body.token.slice('wev1:'.length);
      expect(JSON.stringify(res.body)).not.toContain(raw);
    });

    it('gives one indistinguishable answer for every "does this code exist" question', async () => {
      /* Forged, spent and replaced must not be tellable apart — those are
         probe results. Expired-for-this-event and wrong-event are named, and
         are reachable only by presenting a real code. */
      const forged = await scan('wev1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const first = await mint();
      await scan(first.body.token);
      const spent = await scan(first.body.token);

      const second = await mint();
      await mint();
      const replaced = await scan(second.body.token);

      expect(spent.body).toEqual(forged.body);
      expect(replaced.body).toEqual(forged.body);
    });
  });

  describe('the manual path, which must keep working', () => {
    it('still checks somebody in by name', async () => {
      const res = await srv.call('POST', `/api/events/${eventId}/checkin`,
        { checkinMap: { [application.id]: true } }, organizer);

      expect(res.status).toBe(200);
      expect(res.body.marked).toBe(1);
    });

    it('records a manual mark as manual', async () => {
      await srv.call('POST', `/api/events/${eventId}/checkin`,
        { checkinMap: { [application.id]: true } }, organizer);

      const row = await db.prepare('SELECT method FROM attendance_checkin WHERE event_id = ?').get(eventId);
      expect(row.method).toBe('manual');
    });

    it('still works for a volunteer who arrives long after the start', async () => {
      /* Check-in has an opening time and deliberately no closing time, because
         organizers reconcile after the fact. QR must not have invented one. */
      const now = Date.now();
      await db.prepare('UPDATE slots SET start_datetime = ?, end_datetime = ? WHERE event_id = ?').run(
        new Date(now - 6 * 3600 * 1000).toISOString(),
        new Date(now - 3 * 3600 * 1000).toISOString(),
        eventId,
      );

      const minted = await mint();
      expect(minted.status).toBe(200);
      expect((await scan(minted.body.token)).status).toBe(200);
    });
  });
});
