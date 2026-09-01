import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shiftsOverlap } from './shiftOverlap.js';

/**
 * Auto Select does not seat somebody who is already somewhere else.
 *
 * ── The gap ──
 *
 * The apply-time check refuses an application that overlaps a live one (409,
 * `conflict.level` 1 or 2) and a student may override it. Overriding writes a
 * row to `application_conflicts`, and the organizer's applicant list carries
 * `hasConflict`, which `ApplicantReview` renders as a red "Conflict" tag. So for
 * a HAND-PICKING organizer the situation is already handled: a human sees the
 * clash and decides.
 *
 * Auto Select has no human. `computeDraw` read `pending` rows on one slot and
 * never looked at what else the applicant had been accepted to, so two draws on
 * two overlapping events could both select the same student — and nothing
 * detected it afterwards. The organizer plans staffing around an accepted
 * volunteer who cannot come, and finds out when they do not arrive.
 *
 * ── Why waitlisted, and not rejected or blocked ──
 *
 * This is deliberately the SAME treatment, in the same place, as an applicant
 * who has been banned or dropped out of the organization since applying. The
 * reasoning `computeDraw` already records for that case transfers word for word:
 * a pending application is a request, not a place; the draw is where the place
 * is actually given and can run weeks later; selecting them anyway would seat
 * somebody who cannot come "with no human deciding anything".
 *
 * Waitlisting rather than rejecting is what makes it self-healing, and that is
 * the whole point. `promoteFromWaitlist` re-asks on every freed place and skips
 * rows without dropping them, so if the clashing acceptance is withdrawn the
 * student comes back into line **at the position they held**. Rejecting them
 * would make an automated draw permanently destroy an application over a clash
 * the student might resolve five minutes later.
 *
 * ── Fairness, since excluding a candidate changes probabilities ──
 *
 * It changes them in the direction the draw exists to serve. The excluded
 * student already holds a place for that time, so the spot they would have taken
 * is one they could not have used; passing it to the next applicant is strictly
 * better for everyone else and neutral for them. They still end with exactly one
 * of the two shifts, which is the correct outcome — two is a double-booking and
 * zero would be a penalty for applying.
 *
 * Which of the two they keep depends on which event's draw ran first. That is
 * arbitrary but unbiased, and the student chose it by overriding a warning that
 * named the clash.
 *
 * A manual acceptance is deliberately NOT blocked. The organizer can see the
 * Conflict tag; taking the decision away from a human who has the fact in front
 * of them would be worse than the problem.
 */

let db;
let computeDraw;
let promoteFromWaitlist;
let dir;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-overlap-'));
  process.env.WEV_DB_PATH = path.join(dir, 'overlap.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  delete process.env.NODE_ENV;

  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  db = dbMod.db;

  ({ computeDraw } = await import('./services/autoSelect.js'));
  ({ promoteFromWaitlist } = await import('./utils.js'));

  await db.prepare(`
    INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
    VALUES ('org-1','org1','org1@example.org','x','Org One','Adult','organizer',?)
  `).run(new Date().toISOString());
  for (const id of ['stu-clash', 'stu-free', 'stu-other']) {
    await db.prepare(`
      INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
      VALUES (?,?,?,'x',?, '11','student',?)
    `).run(id, id, `${id}@example.org`, `Student ${id}`, new Date().toISOString());
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.WEV_DB_PATH;
});

/** A fixed day well in the future, so nothing here depends on the wall clock. */
const DAY = '2027-05-04';
const at = (hhmm) => `${DAY}T${hhmm}:00.000Z`;

/**
 * An open, auto-select event with one slot running `from`–`to` on DAY.
 * `spots` places. Returns the slot id.
 */
async function eventWithSlot(id, from, to, spots = 1) {
  await db.prepare(`
    INSERT INTO events (id, title, description, category, location, organizer_id,
                        application_deadline, status, auto_approve, created_at)
    VALUES (?, ?, 'd', 'Other', 'Hall', 'org-1', ?, 'open', 1, ?)
  `).run(id, `Event ${id}`, at('00:01'), new Date().toISOString());
  await db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, 'Shift', 'd', ?, ?, ?)
  `).run(`${id}-slot`, id, at(from), at(to), spots);
  return `${id}-slot`;
}

async function application(id, userId, eventId, slotId, status) {
  await db.prepare(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, eventId, slotId, status, new Date().toISOString());
}

const statusOf = async (id) =>
  (await db.prepare('SELECT status FROM applications WHERE id = ?').get(id))?.status;

beforeEach(async () => {
  await db.prepare('DELETE FROM applications').run();
  await db.prepare('DELETE FROM slots').run();
  await db.prepare('DELETE FROM auto_select_runs').run();
  await db.prepare('DELETE FROM events').run();
});

describe('a draw does not select somebody already accepted to an overlapping shift', () => {
  it('waitlists the clashing applicant and gives the place to somebody who can take it', async () => {
    /* Held: 10:00–12:00. Drawn: 11:00–13:00 — overlapping. */
    const heldSlot = await eventWithSlot('ev-held', '10:00', '12:00', 5);
    const drawSlot = await eventWithSlot('ev-draw', '11:00', '13:00', 1);

    await application('app-held', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    await application('app-clash', 'stu-clash', 'ev-draw', drawSlot, 'pending');
    await application('app-free', 'stu-free', 'ev-draw', drawSlot, 'pending');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev-draw', { runNumber: 1 });

    expect(selectedIds, 'the one place went to the applicant who can attend').toEqual(['app-free']);
    expect(waitlistIds, 'the clashing applicant is queued, not dropped').toContain('app-clash');
  });

  it('still selects an applicant whose other acceptance does not overlap', async () => {
    /* Held: 08:00–09:00. Drawn: 11:00–13:00 — no overlap. The guard must not
       refuse a volunteer doing two shifts in one day, which is the behaviour the
       platform wants. */
    const heldSlot = await eventWithSlot('ev-early', '08:00', '09:00', 5);
    const drawSlot = await eventWithSlot('ev-draw', '11:00', '13:00', 1);

    await application('app-early', 'stu-clash', 'ev-early', heldSlot, 'accepted');
    await application('app-ok', 'stu-clash', 'ev-draw', drawSlot, 'pending');

    const { selectedIds } = await computeDraw(db, 'ev-draw', { runNumber: 1 });
    expect(selectedIds).toEqual(['app-ok']);
  });

  it('treats a shift that merely touches at the boundary as not overlapping', async () => {
    /* 09:00–11:00 then 11:00–13:00 is back-to-back, not a clash. The apply-time
       check uses strict inequality for the same reason; this has to agree with it
       or the two disagree about the same pair of shifts. */
    const heldSlot = await eventWithSlot('ev-before', '09:00', '11:00', 5);
    const drawSlot = await eventWithSlot('ev-draw', '11:00', '13:00', 1);

    await application('app-before', 'stu-clash', 'ev-before', heldSlot, 'accepted');
    await application('app-touch', 'stu-clash', 'ev-draw', drawSlot, 'pending');

    const { selectedIds } = await computeDraw(db, 'ev-draw', { runNumber: 1 });
    expect(selectedIds).toEqual(['app-touch']);
  });

  it('ignores a clashing application that is not accepted', async () => {
    /* A pending or waitlisted row elsewhere is a request, not a commitment. Only
       an ACCEPTED place means the student is actually spoken for. */
    const otherSlot = await eventWithSlot('ev-other', '10:00', '12:00', 5);
    const drawSlot = await eventWithSlot('ev-draw', '11:00', '13:00', 1);

    await application('app-pending-elsewhere', 'stu-clash', 'ev-other', otherSlot, 'pending');
    await application('app-cand', 'stu-clash', 'ev-draw', drawSlot, 'pending');

    const { selectedIds } = await computeDraw(db, 'ev-draw', { runNumber: 1 });
    expect(selectedIds).toEqual(['app-cand']);
  });

  it('ignores a clashing acceptance on a cancelled event', async () => {
    /* A called-off event holds nobody's time. Counting it would keep a student
       out of a shift they are free for. */
    const heldSlot = await eventWithSlot('ev-off', '10:00', '12:00', 5);
    await db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run('ev-off');
    const drawSlot = await eventWithSlot('ev-draw', '11:00', '13:00', 1);

    await application('app-off', 'stu-clash', 'ev-off', heldSlot, 'accepted');
    await application('app-avail', 'stu-clash', 'ev-draw', drawSlot, 'pending');

    const { selectedIds } = await computeDraw(db, 'ev-draw', { runNumber: 1 });
    expect(selectedIds).toEqual(['app-avail']);
  });
});

describe('waitlist promotion applies the same rule', () => {
  it('skips a waitlisted student who is now accepted to an overlapping shift', async () => {
    const heldSlot = await eventWithSlot('ev-held', '10:00', '12:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-held', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    /* One place, nobody in it, two waiting — the clashing student first in the
       queue so the test fails if the queue simply takes the head. */
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
      VALUES ('app-w-clash','stu-clash','ev-free',?, 'waitlisted', ?, 1)
    `).run(freeSlot, new Date().toISOString());
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
      VALUES ('app-w-other','stu-other','ev-free',?, 'waitlisted', ?, 2)
    `).run(freeSlot, new Date().toISOString());

    await promoteFromWaitlist(freeSlot);

    expect(await statusOf('app-w-clash'), 'promoted into a clash').toBe('waitlisted');
    expect(await statusOf('app-w-other'), 'the queue did not move past the clash').toBe('accepted');
  });

  it('promotes them once the clashing place is given up', async () => {
    /* The self-healing property, and the reason this waitlists rather than
       rejects. */
    const heldSlot = await eventWithSlot('ev-held', '10:00', '12:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-held', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
      VALUES ('app-w-clash','stu-clash','ev-free',?, 'waitlisted', ?, 1)
    `).run(freeSlot, new Date().toISOString());

    await promoteFromWaitlist(freeSlot);
    expect(await statusOf('app-w-clash')).toBe('waitlisted');

    await db.prepare("UPDATE applications SET status = 'withdrawn' WHERE id = 'app-held'").run();
    await promoteFromWaitlist(freeSlot);

    expect(
      await statusOf('app-w-clash'),
      'the clash was released and they were still passed over'
    ).toBe('accepted');
  });
});

/**
 * The cases the two blocks above do not actually pin down.
 *
 * ── Why these exist ──
 *
 * Before the rule was implemented, FIVE of the seven tests above passed. Four
 * of them put a single applicant against a single spot and expect them to be
 * selected, which an implementation with no rule at all also does. The fifth —
 * the very first one — passed because the seeded draw happened to pick the
 * non-clashing applicant out of two, and would have flipped the day somebody
 * changed the seed, the ordering, or the weighting curve. So the block asserting
 * the draw-time rule was, in fact, green against a draw that had no such rule
 * and would happily seat a double-booked student.
 *
 * The first test below is the one that could not have passed by accident, and
 * the rest give the promotion path the same coverage the draw path has, plus the
 * queue mechanics that only promotion has.
 */

const orderOf = async (id) =>
  (await db.prepare('SELECT waitlist_order FROM applications WHERE id = ?').get(id))?.waitlist_order;

/** A waitlisted row at a known position in the queue. */
async function waiting(id, userId, eventId, slotId, position) {
  await db.prepare(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
    VALUES (?, ?, ?, ?, 'waitlisted', ?, ?)
  `).run(id, userId, eventId, slotId, new Date().toISOString(), position);
}

describe('the draw-time rule, where a single-candidate test cannot see it', () => {
  it('waitlists a clashing applicant even when they are the only one', async () => {
    /* One spot, one applicant, and they are already accepted to an overlapping
       shift. A draw with no rule selects them; a draw with the rule leaves the
       spot empty rather than filling it with somebody who cannot come. No second
       applicant, so no random draw is involved and nothing here can pass by
       luck. */
    const heldSlot = await eventWithSlot('ev-held', '10:00', '12:00', 5);
    const drawSlot = await eventWithSlot('ev-draw', '11:00', '13:00', 1);

    await application('app-held', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    await application('app-only', 'stu-clash', 'ev-draw', drawSlot, 'pending');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev-draw', { runNumber: 1 });

    expect(selectedIds, 'the draw seated somebody who is already elsewhere').toEqual([]);
    expect(waitlistIds).toEqual(['app-only']);
  });

  it('counts only the clashing one of several held shifts', async () => {
    /* Three acceptances across the day, one of which overlaps. Checking "do they
       hold anything" instead of "do they hold anything AT THIS TIME" would refuse
       the volunteer doing a full day of shifts, which is the behaviour the
       platform wants to encourage. */
    const morning = await eventWithSlot('ev-morning', '08:00', '09:00', 5);
    const noon = await eventWithSlot('ev-noon', '11:30', '12:30', 5);
    const evening = await eventWithSlot('ev-evening', '18:00', '19:00', 5);
    const drawSlot = await eventWithSlot('ev-draw', '11:00', '13:00', 1);

    await application('app-m', 'stu-clash', 'ev-morning', morning, 'accepted');
    await application('app-n', 'stu-clash', 'ev-noon', noon, 'accepted');
    await application('app-e', 'stu-clash', 'ev-evening', evening, 'accepted');
    await application('app-cand', 'stu-clash', 'ev-draw', drawSlot, 'pending');

    const { selectedIds } = await computeDraw(db, 'ev-draw', { runNumber: 1 });
    expect(selectedIds, 'the 11:30–12:30 acceptance should have excluded them').toEqual([]);
  });

  it('is decided by the times and not by which event a shift belongs to', async () => {
    /* Two shifts of the SAME event that do not overlap. An implementation that
       shortcut to "already accepted to this event" would refuse the second, and
       multi-shift events are ordinary here. */
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, organizer_id,
                          application_deadline, status, auto_approve, created_at)
      VALUES ('ev-two','Two shifts','d','Other','Hall','org-1',?,'open',1,?)
    `).run(at('00:01'), new Date().toISOString());
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES ('ev-two-am','ev-two','AM','d',?,?,5), ('ev-two-pm','ev-two','PM','d',?,?,1)
    `).run(at('08:00'), at('10:00'), at('14:00'), at('16:00'));

    await application('app-am', 'stu-clash', 'ev-two', 'ev-two-am', 'accepted');
    await application('app-pm', 'stu-clash', 'ev-two', 'ev-two-pm', 'pending');

    const { selectedIds } = await computeDraw(db, 'ev-two', { runNumber: 1 });
    expect(selectedIds).toEqual(['app-pm']);
  });
});

describe('waitlist promotion, given the same cases the draw is given', () => {
  it('promotes somebody whose other acceptance does not overlap', async () => {
    const heldSlot = await eventWithSlot('ev-early', '08:00', '09:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-early', 'stu-clash', 'ev-early', heldSlot, 'accepted');
    await waiting('app-w', 'stu-clash', 'ev-free', freeSlot, 1);

    await promoteFromWaitlist(freeSlot);
    expect(await statusOf('app-w')).toBe('accepted');
  });

  it('promotes across a boundary that merely touches', async () => {
    const heldSlot = await eventWithSlot('ev-before', '09:00', '11:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-before', 'stu-clash', 'ev-before', heldSlot, 'accepted');
    await waiting('app-w', 'stu-clash', 'ev-free', freeSlot, 1);

    await promoteFromWaitlist(freeSlot);
    expect(await statusOf('app-w'), 'back-to-back shifts were treated as a clash').toBe('accepted');
  });

  it('skips on the one clashing shift among several held', async () => {
    const morning = await eventWithSlot('ev-morning', '08:00', '09:00', 5);
    const noon = await eventWithSlot('ev-noon', '12:30', '14:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-m', 'stu-clash', 'ev-morning', morning, 'accepted');
    await application('app-n', 'stu-clash', 'ev-noon', noon, 'accepted');
    await waiting('app-w', 'stu-clash', 'ev-free', freeSlot, 1);

    await promoteFromWaitlist(freeSlot);
    expect(await statusOf('app-w')).toBe('waitlisted');
  });

  it('ignores a clashing acceptance on a cancelled event', async () => {
    const heldSlot = await eventWithSlot('ev-off', '10:00', '12:00', 5);
    await db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run('ev-off');
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-off', 'stu-clash', 'ev-off', heldSlot, 'accepted');
    await waiting('app-w', 'stu-clash', 'ev-free', freeSlot, 1);

    await promoteFromWaitlist(freeSlot);
    expect(await statusOf('app-w')).toBe('accepted');
  });

  it('ignores a clashing row that is not accepted', async () => {
    const otherSlot = await eventWithSlot('ev-other', '10:00', '12:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-pending-elsewhere', 'stu-clash', 'ev-other', otherSlot, 'pending');
    await waiting('app-w', 'stu-clash', 'ev-free', freeSlot, 1);

    await promoteFromWaitlist(freeSlot);
    expect(await statusOf('app-w')).toBe('accepted');
  });
});

describe('the queue, when promotion passes somebody over', () => {
  it('fills every free place, taking them from further down the queue', async () => {
    /* Two places free and three waiting, the head of the queue clashing. The
       skip must not cost the slot a volunteer: both places still fill. */
    const heldSlot = await eventWithSlot('ev-held', '10:00', '12:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 2);

    await application('app-held', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    await waiting('app-w1', 'stu-clash', 'ev-free', freeSlot, 1);
    await waiting('app-w2', 'stu-free', 'ev-free', freeSlot, 2);
    await waiting('app-w3', 'stu-other', 'ev-free', freeSlot, 3);

    const promoted = await promoteFromWaitlist(freeSlot);

    expect(promoted.map(p => p.applicationId)).toEqual(['app-w2', 'app-w3']);
    expect(await statusOf('app-w1')).toBe('waitlisted');
  });

  it('leaves the skipped volunteer at the head of the queue', async () => {
    /* Being passed over is not losing your place. The person skipped must come
       out of this ahead of everyone who was behind them, or a clash they resolve
       tomorrow costs them the queue. */
    const heldSlot = await eventWithSlot('ev-held', '10:00', '12:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-held', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    await waiting('app-w1', 'stu-clash', 'ev-free', freeSlot, 1);
    await waiting('app-w2', 'stu-free', 'ev-free', freeSlot, 2);
    await waiting('app-w3', 'stu-other', 'ev-free', freeSlot, 3);

    await promoteFromWaitlist(freeSlot);

    expect(await statusOf('app-w2')).toBe('accepted');
    expect(await orderOf('app-w1'), 'the skipped volunteer lost their place').toBe(1);
    expect(await orderOf('app-w3')).toBe(2);
  });

  it('does not overfill the slot or promote anybody twice', async () => {
    /* Called speculatively, twice, which every caller is allowed to do. One
       place, one eligible candidate: exactly one acceptance, and the second call
       returns nobody rather than seating the clashing volunteer as a second. */
    const heldSlot = await eventWithSlot('ev-held', '10:00', '12:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-held', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    await waiting('app-w1', 'stu-clash', 'ev-free', freeSlot, 1);
    await waiting('app-w2', 'stu-free', 'ev-free', freeSlot, 2);

    const first = await promoteFromWaitlist(freeSlot);
    const second = await promoteFromWaitlist(freeSlot);

    expect(first.map(p => p.applicationId)).toEqual(['app-w2']);
    expect(second, 'a second speculative call promoted somebody as well').toEqual([]);

    const accepted = await db.prepare(
      "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
    ).get(freeSlot);
    expect(accepted.c).toBe(1);
  });

  it('promotes nobody, and drops nobody, when the whole queue clashes', async () => {
    const heldSlot = await eventWithSlot('ev-held', '10:00', '12:00', 5);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 2);

    await application('app-h1', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    await application('app-h2', 'stu-free', 'ev-held', heldSlot, 'accepted');
    await waiting('app-w1', 'stu-clash', 'ev-free', freeSlot, 1);
    await waiting('app-w2', 'stu-free', 'ev-free', freeSlot, 2);

    expect(await promoteFromWaitlist(freeSlot)).toEqual([]);
    expect(await statusOf('app-w1')).toBe('waitlisted');
    expect(await statusOf('app-w2')).toBe('waitlisted');
    expect(await orderOf('app-w1')).toBe(1);
    expect(await orderOf('app-w2')).toBe(2);
  });
});

describe('the draw and promotion agree, because they ask the same function', () => {
  /**
   * `[held-from, held-to, overlaps?]` against a candidate shift of 11:00–13:00.
   * Chosen to cover every arrangement two intervals can be in, including both
   * touching boundaries and full containment in both directions.
   */
  const CASES = [
    ['08:00', '09:00', false], // entirely before
    ['09:00', '11:00', false], // ends exactly as the candidate begins
    ['09:00', '11:30', true],  // straddles the start
    ['11:30', '12:30', true],  // inside the candidate
    ['10:00', '14:00', true],  // contains the candidate
    ['12:30', '15:00', true],  // straddles the end
    ['13:00', '15:00', false], // begins exactly as the candidate ends
    ['14:00', '15:00', false], // entirely after
  ];

  it.each(CASES)('%s–%s → overlaps 11:00–13:00: %s', async (from, to, expected) => {
    const heldSlot = await eventWithSlot('ev-held', from, to, 5);
    const drawSlot = await eventWithSlot('ev-draw', '11:00', '13:00', 1);
    const freeSlot = await eventWithSlot('ev-free', '11:00', '13:00', 1);

    await application('app-held', 'stu-clash', 'ev-held', heldSlot, 'accepted');
    await application('app-draw', 'stu-clash', 'ev-draw', drawSlot, 'pending');
    await waiting('app-w', 'stu-clash', 'ev-free', freeSlot, 1);

    const { selectedIds } = await computeDraw(db, 'ev-draw', { runNumber: 1 });
    await promoteFromWaitlist(freeSlot);

    /* The draw refuses and promotion refuses, or neither does. A disagreement
       here is the platform giving one answer about a pair of times at the draw
       and the opposite answer when a place frees up. */
    expect(selectedIds.length === 0, 'the draw').toBe(expected);
    expect(await statusOf('app-w') === 'waitlisted', 'promotion').toBe(expected);

    /* And the JS form of the rule, which exists for callers holding both pairs
       of times, has to give that same answer. */
    expect(shiftsOverlap(at(from), at(to), at('11:00'), at('13:00'))).toBe(expected);
  });
});
