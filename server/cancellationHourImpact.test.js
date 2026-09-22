import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { getInAppContent } from './services/notificationContent.js';

/**
 * Telling the people whose credited service actually changed.
 *
 * ── What the cancellation notice said, and to whom ──
 *
 * One sentence — "The organizer has cancelled this event." — to every holder of
 * an `accepted` application, whether or not they turned up and whether or not
 * they were credited an hour. Meanwhile the platform stops counting that
 * event's hours in every total it presents, which for a student is the part
 * that can matter at the end of the year, and nothing said so anywhere except
 * on the certificate, which only a reader who opens one ever sees.
 *
 * ── Why the extra sentence goes only to the credited ──
 *
 * Because that is already this product's rule about hour-impact messages.
 * `HOURS_ADJUSTED` is dispatched from the attendance route only after a
 * `wasCredited` guard, with the reason written beside it: "Somebody who was
 * never credited has had nothing taken from them and should not be told their
 * hours changed." A cancellation takes credit away from exactly the same people
 * by exactly the same measure, so it follows the same rule.
 *
 * ── Why one kind and two dispatches, not two kinds ──
 *
 * `dispatchMany` renders content ONCE for a fan-out — "every recipient of a
 * fan-out shares the event, the payload and the rendered content" — so a
 * per-recipient clause is not expressible inside one dispatch. `HOURS_APPROVED`
 * already solves this shape: one kind, two bodies, chosen by a payload flag,
 * with the reasoning recorded. This follows it. The two recipient sets are
 * disjoint by construction and share the dedupe namespace, so nobody is told
 * twice.
 *
 * Decided during the 2026-09-21 audit (owner decision 4B).
 */

const ORGANIZER = 'jordan.whitfield@example.org';

describe('the sentence itself', () => {
  const payload = { eventId: 'e1', eventTitle: 'Winter Coat Drive' };

  it('is the plain notice when no hours were credited', () => {
    const content = getInAppContent('EVENT_CANCELLED', payload);
    expect(content.title).toBe('Winter Coat Drive was cancelled');
    expect(content.body).toBe('The organizer has cancelled this event.');
  });

  it('names the hour impact when the reader had credited hours', () => {
    const content = getInAppContent('EVENT_CANCELLED', { ...payload, hadCreditedHours: true });
    expect(content.title).toBe('Winter Coat Drive was cancelled');
    expect(content.body).toMatch(/^The organizer has cancelled this event\./);
    /* The two facts a student needs: the record is intact, the total is not. */
    expect(content.body).toMatch(/no longer count/i);
    expect(content.body).toMatch(/attendance record/i);
  });

  it('does not claim the hours were deleted', () => {
    /* They are not. The attendance row, the ledger entry and any certificate
       all survive — the Volunteer Record Policy now says so in those words, and
       a notice that said otherwise would contradict it. */
    const body = getInAppContent('EVENT_CANCELLED', { ...payload, hadCreditedHours: true }).body;
    expect(body).not.toMatch(/removed|deleted|taken away|lost/i);
  });

  it('keeps the same kind, priority and link either way', () => {
    const plain = getInAppContent('EVENT_CANCELLED', payload);
    const credited = getInAppContent('EVENT_CANCELLED', { ...payload, hadCreditedHours: true });
    expect(credited.kind).toBe(plain.kind);
    expect(credited.priority).toBe(plain.priority);
    expect(credited.link).toBe(plain.link);
  });
});

describe('who is told what when an event is cancelled', () => {
  let srv, db, organizer, organizerId;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    organizer = await srv.login(ORGANIZER);
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(ORGANIZER)).id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const userId = async (email) =>
    (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;

  const notice = async (uid, eventId) => db.prepare(
    "SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'EVENT' AND dedupe_key = ?"
  ).get(uid, `cancelled:${eventId}:${uid}`);

  /**
   * One event, four people, four different relationships to it — which is the
   * whole point: the recipient set and the content set are not the same set.
   */
  it('names the hour impact only for the people who had credited hours', async () => {
    const eventId = 'evt-cancel-impact';
    const credited = await userId('leo.chen@example.com');
    const noShow = await userId('priya.patel@example.com');
    const withdrawn = await userId('ethan.miller@example.com');

    await db.prepare(`
      INSERT INTO events (id, title, description, category, location,
                          application_deadline, organizer_id, status, created_at)
      VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'open', ?)
    `).run(eventId, 'Impact Drive', 'Synthetic fixture.', 'Springfield',
      '2026-07-20T00:00:00.000Z', organizerId, '2026-07-01T00:00:00.000Z');
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Afternoon', 'Synthetic fixture.', ?, ?, 20)
    `).run('slot-cancel-impact', eventId, '2026-07-23T13:00:00.000Z', '2026-07-23T17:00:00.000Z');

    const apply = async (uid, status, n) => db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, 'slot-cancel-impact', ?, ?)
    `).run(`app-cancel-${n}`, uid, eventId, status, '2026-07-02T00:00:00.000Z');

    await apply(credited, 'accepted', 1);
    await apply(noShow, 'accepted', 2);
    /* Credited, then withdrew the application afterwards. Attendance is
       deliberately independent of application status, so their hours are real
       and their credited total is about to move — and the old recipient query,
       which reads `status = 'accepted'`, would never have told them. */
    await apply(withdrawn, 'withdrawn', 3);

    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, 'slot-cancel-impact', ?, 1, 4)
    `).run(eventId, credited);
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, 'slot-cancel-impact', ?, 0, 0)
    `).run(eventId, noShow);
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, 'slot-cancel-impact', ?, 1, 4)
    `).run(eventId, withdrawn);

    const res = await srv.call('PATCH', `/api/events/${eventId}/status`, { status: 'cancelled' }, organizer);
    expect(res.status).toBe(200);

    const toCredited = await notice(credited, eventId);
    expect(toCredited, 'the volunteer who earned hours was not told at all').toBeTruthy();
    expect(toCredited.body).toMatch(/no longer count/i);

    const toNoShow = await notice(noShow, eventId);
    expect(toNoShow, 'an accepted volunteer was not told the event was off').toBeTruthy();
    expect(
      toNoShow.body,
      'somebody who was never credited was told their hours changed'
    ).not.toMatch(/no longer count/i);

    const toWithdrawn = await notice(withdrawn, eventId);
    expect(
      toWithdrawn,
      'a volunteer whose credited hours just stopped counting was told nothing, because they had withdrawn'
    ).toBeTruthy();
    expect(toWithdrawn.body).toMatch(/no longer count/i);
  });

  it('counts everybody it told', async () => {
    const eventId = 'evt-cancel-count';
    const credited = await userId('leo.chen@example.com');

    await db.prepare(`
      INSERT INTO events (id, title, description, category, location,
                          application_deadline, organizer_id, status, created_at)
      VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'open', ?)
    `).run(eventId, 'Count Drive', 'Synthetic fixture.', 'Springfield',
      '2026-07-20T00:00:00.000Z', organizerId, '2026-07-01T00:00:00.000Z');
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Afternoon', 'Synthetic fixture.', ?, ?, 20)
    `).run('slot-cancel-count', eventId, '2026-07-23T13:00:00.000Z', '2026-07-23T17:00:00.000Z');
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES ('app-cancel-count', ?, ?, 'slot-cancel-count', 'accepted', ?)
    `).run(credited, eventId, '2026-07-02T00:00:00.000Z');
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, 'slot-cancel-count', ?, 1, 3)
    `).run(eventId, credited);

    const res = await srv.call('PATCH', `/api/events/${eventId}/status`, { status: 'cancelled' }, organizer);
    /* One person, told once — not once per dispatch. */
    expect(res.body.notified).toBe(1);
    const rows = await db.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND dedupe_key = ?'
    ).get(credited, `cancelled:${eventId}:${credited}`);
    expect(rows.n).toBe(1);
  });

  /**
   * An event that credits no hours at all.
   *
   * `credits_hours = 0` — a donation drive, a supply sort — records attendance
   * and awards nothing, writing `hours_awarded = 0`. Those volunteers turned up
   * and are affected by the cancellation, but they have no credited hours to
   * lose, so the hour-impact sentence would be false for them.
   *
   * The predicate is `present = 1 AND hours_awarded > 0`, which handles it for
   * the same reason `HOURS_APPROVED` prints no number on such an event: "You
   * earned 0 hours" "reads as a refusal to somebody who turned up and did the
   * work", and "your hours no longer count" is the same sentence one step on.
   *
   * Found by the post-implementation audit of owner decision 4B.
   */
  it('does not claim an hour impact on an event that credits no hours', async () => {
    const eventId = 'evt-cancel-zero-hours';
    const attended = await userId('leo.chen@example.com');

    await db.prepare(`
      INSERT INTO events (id, title, description, category, location,
                          application_deadline, organizer_id, status, credits_hours, created_at)
      VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'open', 0, ?)
    `).run(eventId, 'Coat Sort', 'Synthetic fixture.', 'Springfield',
      '2026-07-20T00:00:00.000Z', organizerId, '2026-07-01T00:00:00.000Z');
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Afternoon', 'Synthetic fixture.', ?, ?, 20)
    `).run('slot-cancel-zero', eventId, '2026-07-23T13:00:00.000Z', '2026-07-23T17:00:00.000Z');
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES ('app-cancel-zero', ?, ?, 'slot-cancel-zero', 'accepted', ?)
    `).run(attended, eventId, '2026-07-02T00:00:00.000Z');
    /* Present, and credited nothing — which is what such an event does. */
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, 'slot-cancel-zero', ?, 1, 0)
    `).run(eventId, attended);

    await srv.call('PATCH', `/api/events/${eventId}/status`, { status: 'cancelled' }, organizer);

    const told = await notice(attended, eventId);
    expect(told, 'somebody who turned up was not told the event was off').toBeTruthy();
    expect(
      told.body,
      'a volunteer with no credited hours was told their hours stopped counting'
    ).not.toMatch(/no longer count/i);
  });
});
