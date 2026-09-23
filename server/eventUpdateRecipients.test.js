import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Who hears that an event's details changed — F-1, closed.
 *
 * ── The question ──
 *
 * `EVENT_UPDATED` is dispatched through `notifyConfirmedVolunteers`, whose
 * recipient query is `applications WHERE status = 'accepted'`. That is the same
 * query owner decision 4B corrected for cancellation, where it was wrong: a
 * volunteer credited at the event who later withdrew was affected — their
 * credited hours stopped counting — and heard nothing.
 *
 * The obvious move is to apply the same correction here. It is the wrong move,
 * and this file is why.
 *
 * ── Why "accepted" is the RIGHT set for this notice ──
 *
 * 1. It is the documented contract. `notifyConfirmedVolunteers` says, twice,
 *    "notify every confirmed volunteer on an event". A withdrawn application is
 *    by definition not a confirmed volunteer.
 * 2. "Confirmed volunteer" means the same thing everywhere else in this
 *    codebase: the close-out precondition counts them, and so do the 24-hour and
 *    2-hour shift reminders. Redefining it here would make one notice disagree
 *    with the rest of the vocabulary.
 * 3. The reason 4B widened the cancellation notice does not transfer. That
 *    widening was about HOURS, which are deliberately independent of application
 *    status — attendance survives a withdrawal. An edit has no hour
 *    consequence: `PUT /api/events/:id` refuses a completed event ("its details
 *    can no longer be changed. Attendance can still be corrected"), and an
 *    existing credit keeps its stored `hours_awarded` however the slot is edited
 *    afterwards. So this notice is about a future shift, and somebody who
 *    withdrew is not going to it. The server goes further, found while writing
 *    the fixture below: an edit that would REMOVE a shift with credited
 *    attendance against it is refused outright, 409 `attendance_exists`.
 *
 * So F-1 is a shared implementation detail, not a shared defect. Pinned here so
 * the next reader who notices the shared query finds the answer beside it
 * rather than re-deriving the finding.
 */

const ORGANIZER = 'jordan.whitfield@example.org';

describe('an event edit tells the confirmed volunteers', () => {
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

  const noticesFor = async (uid, eventId) => db.prepare(`
    SELECT title, body FROM notifications
     WHERE user_id = ? AND kind = 'EVENT' AND link = ?
     ORDER BY created_at DESC
  `).all(uid, `event:${eventId}`);

  it('goes to an accepted volunteer and not to one who withdrew', async () => {
    const eventId = 'evt-update-recipients';
    const accepted = await userId('priya.patel@example.com');
    /* Credited AND withdrawn — the exact person 4B added to the cancellation
       notice, and the reason this case exists. */
    const withdrew = await userId('leo.chen@example.com');

    await db.prepare(`
      INSERT INTO events (id, title, description, category, location,
                          application_deadline, organizer_id, status, created_at)
      VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'open', ?)
    `).run(eventId, 'Recipients Drive', 'Synthetic fixture.', 'Springfield',
      '2027-07-20T00:00:00.000Z', organizerId, '2026-07-01T00:00:00.000Z');
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Afternoon', 'Synthetic fixture.', ?, ?, 20)
    `).run('slot-update-recipients', eventId,
      '2027-07-23T13:00:00.000Z', '2027-07-23T17:00:00.000Z');

    const apply = async (uid, status, n) => db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, 'slot-update-recipients', ?, ?)
    `).run(`app-update-${n}`, uid, eventId, status, '2026-07-02T00:00:00.000Z');

    await apply(accepted, 'accepted', 1);
    await apply(withdrew, 'withdrawn', 2);
    /* Their attendance is real and survives the withdrawal, which is what makes
       them the interesting case rather than an ordinary non-participant. */
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, 'slot-update-recipients', ?, 1, 4)
    `).run(eventId, withdrew);

    const res = await srv.call('PUT', `/api/events/${eventId}`, {
      title: 'Recipients Drive (new time)',
      description: 'Synthetic fixture.',
      category: 'Donation Drive',
      location: 'Springfield',
      applicationDeadline: '2027-07-21T00:00:00.000Z',
      /* Carrying the id, so this edits the shift rather than replacing it.
         Without it the server answers 409 `attendance_exists` — it refuses to
         remove a shift with credited attendance against it, which is a third
         reason an edit cannot reach somebody's hours. */
      slots: [{
        id: 'slot-update-recipients',
        name: 'Afternoon',
        description: 'Synthetic fixture.',
        startDatetime: '2027-07-23T13:00:00.000Z',
        endDatetime: '2027-07-23T17:00:00.000Z',
        maxSpots: 20,
      }],
    }, organizer);
    expect(res.status, 'the edit itself was refused').toBe(200);

    const toAccepted = await noticesFor(accepted, eventId);
    expect(
      toAccepted.some(n => /details changed/i.test(n.title)),
      'the confirmed volunteer was not told their event changed',
    ).toBe(true);

    const toWithdrawn = await noticesFor(withdrew, eventId);
    expect(
      toWithdrawn.some(n => /details changed/i.test(n.title)),
      'somebody who withdrew was told about a shift they are not going to',
    ).toBe(false);
  });

  it('cannot carry an hours consequence, because a completed event refuses edits', async () => {
    /* The other half of why 4B's widening does not transfer. If an edit could
       land on a completed event it could move what a later credit is priced
       from, and the withdrawn-but-credited volunteer would have a stake. It
       cannot. */
    const eventId = 'evt-update-completed';
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location,
                          application_deadline, organizer_id, status, created_at)
      VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'completed', ?)
    `).run(eventId, 'Already Done', 'Synthetic fixture.', 'Springfield',
      '2026-07-20T00:00:00.000Z', organizerId, '2026-07-01T00:00:00.000Z');

    const res = await srv.call('PUT', `/api/events/${eventId}`, {
      title: 'Already Done (edited)',
      description: 'Synthetic fixture.',
      category: 'Donation Drive',
      location: 'Springfield',
      applicationDeadline: '2027-07-21T00:00:00.000Z',
      slots: [{
        name: 'Afternoon',
        description: 'Synthetic fixture.',
        startDatetime: '2027-07-23T13:00:00.000Z',
        endDatetime: '2027-07-23T17:00:00.000Z',
        maxSpots: 20,
      }],
    }, organizer);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('event_completed');
  });
});
