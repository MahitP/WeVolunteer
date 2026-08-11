import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * An organizer editing their own event cannot touch anybody else's shifts.
 *
 * ── The defect ──
 *
 * `PUT /api/events/:id` checked that the caller owns the event named in the PATH,
 * then wrote every slot in the BODY with `UPDATE slots … WHERE id = ?` — no event
 * scope. So an organizer could send their own event id with a slot id belonging to
 * somebody else's event, and the write landed.
 *
 * Slot ids are not secret. `GET /api/events` returns every event's slots to every
 * signed-in user, so there was nothing to guess.
 *
 * ── Why it mattered more than a normal IDOR ──
 *
 * Credited hours are `end_datetime - start_datetime`, read at the moment an
 * organizer confirms attendance. Moving a foreign slot's times therefore changes
 * what ANOTHER organizer's volunteers get credited — service hours that students
 * put on college applications. `hours_ledger` cannot warn about it either: the
 * ledger faithfully records whatever duration the slot had, so the tampering
 * arrives as a correct-looking entry.
 *
 * Two other reachable effects: pushing `end_datetime` into the future makes that
 * event's attendance impossible to finalise (`shift_not_ended`), and lowering
 * `max_spots` below the accepted count breaks waitlist promotion permanently.
 *
 * ── What is asserted ──
 *
 * The refusal, and — more importantly — that the victim's row is BYTE-IDENTICAL
 * afterwards. A 400 that still wrote would satisfy a status assertion and lose the
 * hours anyway, which is the failure mode this whole file exists for.
 */
/* Far enough out that the route's own "deadline before first shift" rule can be
   satisfied, and long enough that the hours inflation is unmistakable: 96 hours. */
/**
 * Twenty hours rather than four days.
 *
 * This was a four-day span, chosen to make the damage vivid — and a single
 * shift may no longer be longer than twenty-four hours (`MAX_SLOT_HOURS`), so
 * that payload is now refused by the DURATION rule before it ever reaches the
 * ownership check this file is about. Twenty hours is still a gross rewrite of
 * a two-hour shift and still credits ten times what the victim's volunteers
 * signed up for; it just fails for the reason under test.
 */
const HIJACK_START = '2030-01-01T00:00:00.000Z';
const HIJACK_END = '2030-01-01T20:00:00.000Z';

describe('PUT /api/events/:id cannot reach another event\'s shifts', () => {
  let srv, db, organizer;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    organizer = await srv.login('jkatzenback@vikings.org');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /**
   * A deadline the route will accept for a payload whose first shift starts at
   * `startIso`.
   *
   * `PUT /api/events/:id` validates "deadline on or before the first shift"
   * BEFORE it looks at slot ownership, so a request with a stale deadline never
   * reaches the check under test — which is how the first version of this file
   * failed three times with an error about dates.
   */
  const deadlineBefore = (startIso) =>
    new Date(new Date(startIso).getTime() - 86_400_000).toISOString();

  /** An event this organizer owns, and a slot on a DIFFERENT event. */
  const fixture = () => {
    const mine = db.prepare(
      'SELECT id FROM events WHERE organizer_id = (SELECT id FROM users WHERE email = ?) LIMIT 1'
    ).get('jkatzenback@vikings.org');

    const foreignSlot = db.prepare(
      'SELECT * FROM slots WHERE event_id != ? LIMIT 1'
    ).get(mine.id);

    return { mine, foreignSlot };
  };

  it('refuses an edit naming a slot from another event, and changes nothing', async () => {
    const { mine, foreignSlot } = fixture();
    expect(mine, 'fixture: this organizer owns no event').toBeTruthy();
    expect(foreignSlot, 'fixture: no slot exists on another event').toBeTruthy();

    const before = db.prepare('SELECT * FROM slots WHERE id = ?').get(foreignSlot.id);
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(mine.id);

    const res = await srv.call('PUT', `/api/events/${mine.id}`, {
      title: event.title,
      description: event.description,
      category: event.category,
      location: event.location,
      applicationDeadline: deadlineBefore(HIJACK_START),
      slots: [{
        /* The victim's slot, with times that would credit twenty hours instead
           of a few, and a spot count that would break their waitlist. */
        id: foreignSlot.id,
        name: 'Hijacked',
        description: 'x',
        startDatetime: HIJACK_START,
        endDatetime: HIJACK_END,
        maxSpots: 1,
      }],
    }, organizer);

    expect(res.status).toBe(400);
    expect(res.body?.code).toBe('slot_not_on_event');

    const after = db.prepare('SELECT * FROM slots WHERE id = ?').get(foreignSlot.id);
    expect(after, 'the other organizer\'s shift was modified').toEqual(before);
  });

  /**
   * The same probe against a slot id that exists nowhere.
   *
   * A caller cannot tell from the response whether the id belongs to another
   * event or to nothing at all — which is right, and also means a client bug and
   * an attack produce the same honest error rather than an oracle.
   */
  it('refuses an edit naming a slot that does not exist', async () => {
    const { mine } = fixture();
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(mine.id);

    const res = await srv.call('PUT', `/api/events/${mine.id}`, {
      title: event.title,
      description: event.description,
      category: event.category,
      location: event.location,
      applicationDeadline: deadlineBefore('2030-09-01T14:00:00.000Z'),
      slots: [{
        id: 'slot-does-not-exist',
        name: 'Nowhere', description: '',
        startDatetime: '2030-09-01T14:00:00.000Z',
        endDatetime: '2030-09-01T16:00:00.000Z',
        maxSpots: 4,
      }],
    }, organizer);

    expect(res.status).toBe(400);
    expect(res.body?.code).toBe('slot_not_on_event');
  });

  /**
   * The legitimate path still works.
   *
   * Without this the fix could be "refuse every edit", which would pass both
   * cases above and break the feature entirely.
   */
  it('still lets an organizer edit their own shifts', async () => {
    const { mine } = fixture();
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(mine.id);
    const ownSlot = db.prepare('SELECT * FROM slots WHERE event_id = ? LIMIT 1').get(mine.id);
    expect(ownSlot, 'fixture: this event has no slots').toBeTruthy();

    const res = await srv.call('PUT', `/api/events/${mine.id}`, {
      title: event.title,
      description: event.description,
      category: event.category,
      location: event.location,
      applicationDeadline: deadlineBefore(ownSlot.start_datetime),
      slots: [{
        id: ownSlot.id,
        name: 'Renamed by its own organizer',
        description: ownSlot.description,
        startDatetime: ownSlot.start_datetime,
        endDatetime: ownSlot.end_datetime,
        maxSpots: ownSlot.max_spots,
      }],
    }, organizer);

    expect(res.status).toBeLessThan(400);
    expect(db.prepare('SELECT name FROM slots WHERE id = ?').get(ownSlot.id).name)
      .toBe('Renamed by its own organizer');
  });
});
