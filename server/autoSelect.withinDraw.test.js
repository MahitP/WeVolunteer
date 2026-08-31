import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shiftsOverlap } from './shiftOverlap.js';

/**
 * One Auto Select execution cannot double-book a volunteer.
 *
 * ── The gap the cross-event check could not reach ──
 *
 * `usersWithClashingAcceptance` reads ACCEPTED rows, and `computeDraw` writes
 * nothing: it is pure with respect to the database so an organizer can review a
 * result before it takes effect. Both properties are deliberate and both are
 * worth keeping, and together they mean the committed-acceptance check is
 * structurally blind to a selection made earlier in the SAME loop.
 *
 * So a volunteer pending on two overlapping shifts of one event was selected for
 * both. `autoSelect.overlappingShifts.test.js` could not see it: every case
 * there puts the clash on a DIFFERENT event, which is exactly the arrangement
 * the committed check does handle. One event with two overlapping slots is the
 * one shape that reaches the gap, and it is not an exotic one — a festival with
 * a 09:00–13:00 setup shift and an 11:00–15:00 stall shift is an ordinary
 * multi-shift event.
 *
 * ── What is asserted ──
 *
 * The INVARIANT, mostly, rather than a particular winner. `noDoubleBooking`
 * re-derives every selected application's user and slot times from the database
 * and checks the whole result set pairwise, so a case passes only if the outcome
 * is actually free of double-bookings — not because it happened to match a
 * string somebody wrote down. The cases that DO pin a specific winner are the
 * ones about the tie-break rule being explainable, and they say so.
 */

let db;
let computeDraw;
let dir;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-withindraw-'));
  process.env.WEV_DB_PATH = path.join(dir, 'withindraw.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  delete process.env.NODE_ENV;

  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  db = dbMod.db;

  ({ computeDraw } = await import('./services/autoSelect.js'));

  await db.prepare(`
    INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
    VALUES ('org-1','org1','org1@example.invalid','x','Org One','Adult','organizer',?)
  `).run(new Date().toISOString());
  for (const id of ['stu-a', 'stu-b', 'stu-c', 'stu-d', 'stu-e']) {
    await db.prepare(`
      INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
      VALUES (?,?,?,'x',?, '11','student',?)
    `).run(id, id, `${id}@example.invalid`, `Student ${id}`, new Date().toISOString());
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.WEV_DB_PATH;
});

/** A fixed future day, so nothing depends on the wall clock. */
const DAY = '2027-06-12';
const at = (hhmm) => `${DAY}T${hhmm}:00.000Z`;

/** One open, auto-select event. Slots are added separately. */
async function event(id) {
  await db.prepare(`
    INSERT INTO events (id, title, description, category, location, organizer_id,
                        application_deadline, status, auto_approve, created_at)
    VALUES (?, ?, 'd', 'Other', 'Hall', 'org-1', ?, 'open', 1, ?)
  `).run(id, `Event ${id}`, at('00:01'), new Date().toISOString());
  return id;
}

/** A slot on `eventId`, running `from`–`to`, with `spots` places. */
async function slot(eventId, id, from, to, spots = 1) {
  await db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, ?, 'd', ?, ?, ?)
  `).run(id, eventId, id, at(from), at(to), spots);
  return id;
}

async function apply(id, userId, eventId, slotId, status = 'pending') {
  await db.prepare(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, eventId, slotId, status, new Date().toISOString());
  return id;
}

/**
 * The invariant, checked against the database rather than against expectations.
 *
 * Resolves each selected application to its volunteer and its slot's times, then
 * compares every pair belonging to the same volunteer. Uses `shiftsOverlap`, so
 * "overlapping" means here exactly what it means at apply time, in the draw's
 * committed-acceptance check and in waitlist promotion.
 */
async function noDoubleBooking(selectedIds) {
  if (selectedIds.length === 0) return;
  const placeholders = selectedIds.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT a.id, a.user_id, s.id AS slot_id, s.start_datetime, s.end_datetime
      FROM applications a JOIN slots s ON s.id = a.slot_id
     WHERE a.id IN (${placeholders})
  `).all(...selectedIds);

  expect(rows.length, 'a selected application id does not exist').toBe(selectedIds.length);

  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rows[i].user_id !== rows[j].user_id) continue;
      const clash = shiftsOverlap(
        rows[i].start_datetime, rows[i].end_datetime,
        rows[j].start_datetime, rows[j].end_datetime,
      );
      expect(
        clash,
        `${rows[i].user_id} was selected into overlapping shifts `
        + `${rows[i].slot_id} (${rows[i].start_datetime}–${rows[i].end_datetime}) and `
        + `${rows[j].slot_id} (${rows[j].start_datetime}–${rows[j].end_datetime}) `
        + 'by a single draw',
      ).toBe(false);
    }
  }
}

/** Every selected application belonging to `userId`, as slot ids. */
async function slotsFor(selectedIds, userId) {
  if (!selectedIds.length) return [];
  const placeholders = selectedIds.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT slot_id FROM applications WHERE id IN (${placeholders}) AND user_id = ?`
  ).all(...selectedIds, userId);
  return rows.map(r => r.slot_id).sort();
}

beforeEach(async () => {
  await db.prepare('DELETE FROM applications').run();
  await db.prepare('DELETE FROM slots').run();
  await db.prepare('DELETE FROM auto_select_runs').run();
  await db.prepare('DELETE FROM events').run();
});

describe('one volunteer, two overlapping slots of one event', () => {
  it('is selected for exactly one of them, and waitlisted on the other', async () => {
    /* THE case. Before the fix both slots selected `stu-a`, because each slot's
       draw only saw committed acceptances and neither had been written. */
    await event('ev');
    await slot('ev', 'am', '09:00', '13:00', 1);
    await slot('ev', 'mid', '11:00', '15:00', 1);
    await apply('app-am', 'stu-a', 'ev', 'am');
    await apply('app-mid', 'stu-a', 'ev', 'mid');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds).toHaveLength(1);
    expect(waitlistIds, 'the losing application was dropped rather than queued')
      .toEqual([selectedIds[0] === 'app-am' ? 'app-mid' : 'app-am']);
  });

  it('keeps the EARLIER shift, which is the rule that can be explained', async () => {
    /**
     * The one place a specific winner is pinned. Slots are drawn in
     * `start_datetime, id` order, so the earlier shift is decided first and the
     * later one sees the volunteer as already seated.
     *
     * Without the ORDER BY this was whatever the storage engine returned, which
     * is not an answer anybody can give the volunteer who asks why.
     */
    await event('ev');
    /* Inserted late-first, so a passing result cannot be insertion order. */
    await slot('ev', 'z-late', '11:00', '15:00', 1);
    await slot('ev', 'a-early', '09:00', '13:00', 1);
    await apply('app-late', 'stu-a', 'ev', 'z-late');
    await apply('app-early', 'stu-a', 'ev', 'a-early');

    const { selectedIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    expect(selectedIds).toEqual(['app-early']);
  });

  it('gives the same answer every time it is run', async () => {
    await event('ev');
    await slot('ev', 'am', '09:00', '13:00', 1);
    await slot('ev', 'mid', '11:00', '15:00', 1);
    await apply('app-am', 'stu-a', 'ev', 'am');
    await apply('app-mid', 'stu-a', 'ev', 'mid');

    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      runs.push((await computeDraw(db, 'ev', { runNumber: 1 })).selectedIds.join(','));
    }
    expect(new Set(runs).size, `a repeated draw disagreed with itself: ${runs}`).toBe(1);
  });

  it('still resolves to one shift on a later run number', async () => {
    /* A re-draw uses a different seed. The invariant is not a property of run 1. */
    await event('ev');
    await slot('ev', 'am', '09:00', '13:00', 1);
    await slot('ev', 'mid', '11:00', '15:00', 1);
    await apply('app-am', 'stu-a', 'ev', 'am');
    await apply('app-mid', 'stu-a', 'ev', 'mid');

    for (const runNumber of [1, 2, 3, 7]) {
      const { selectedIds } = await computeDraw(db, 'ev', { runNumber });
      await noDoubleBooking(selectedIds);
      expect(selectedIds).toHaveLength(1);
    }
  });
});

describe('shifts that do not actually clash', () => {
  it('lets one volunteer take both when they are back-to-back', async () => {
    /* 09:00–11:00 then 11:00–13:00. The boundary rule is the same one apply-time
       uses; refusing here would make the draw stricter than the warning and stop
       a volunteer doing a full day, which the platform wants to encourage. */
    await event('ev');
    await slot('ev', 'first', '09:00', '11:00', 1);
    await slot('ev', 'second', '11:00', '13:00', 1);
    await apply('app-1', 'stu-a', 'ev', 'first');
    await apply('app-2', 'stu-a', 'ev', 'second');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    expect(selectedIds.sort()).toEqual(['app-1', 'app-2']);
    expect(waitlistIds).toEqual([]);
  });

  it('lets one volunteer take three separated shifts in a day', async () => {
    await event('ev');
    await slot('ev', 'morning', '08:00', '09:00', 1);
    await slot('ev', 'noon', '12:00', '13:00', 1);
    await slot('ev', 'evening', '18:00', '19:00', 1);
    await apply('app-m', 'stu-a', 'ev', 'morning');
    await apply('app-n', 'stu-a', 'ev', 'noon');
    await apply('app-e', 'stu-a', 'ev', 'evening');

    const { selectedIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds.sort()).toEqual(['app-e', 'app-m', 'app-n']);
  });

  it('excludes only the shifts that clash, not every later one', async () => {
    /* Overlapping pair plus a clear evening shift. Excluding the volunteer from
       everything after their first selection would be the lazy fix and would
       cost them a shift they are free for. */
    await event('ev');
    await slot('ev', 'a-am', '09:00', '13:00', 1);
    await slot('ev', 'b-mid', '11:00', '15:00', 1);
    await slot('ev', 'c-eve', '18:00', '20:00', 1);
    await apply('app-am', 'stu-a', 'ev', 'a-am');
    await apply('app-mid', 'stu-a', 'ev', 'b-mid');
    await apply('app-eve', 'stu-a', 'ev', 'c-eve');

    const { selectedIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(await slotsFor(selectedIds, 'stu-a')).toEqual(['a-am', 'c-eve']);
  });
});

describe('the spot a clashing volunteer cannot take goes to somebody who can', () => {
  it('fills the later slot from the rest of its pool', async () => {
    /* The fix must not cost the organizer a volunteer. `stu-a` is excluded from
       the second slot; `stu-b` applied to it and is free. */
    await event('ev');
    await slot('ev', 'a-am', '09:00', '13:00', 1);
    await slot('ev', 'b-mid', '11:00', '15:00', 1);
    await apply('app-a-am', 'stu-a', 'ev', 'a-am');
    await apply('app-a-mid', 'stu-a', 'ev', 'b-mid');
    await apply('app-b-mid', 'stu-b', 'ev', 'b-mid');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds.sort()).toEqual(['app-a-am', 'app-b-mid']);
    expect(waitlistIds).toEqual(['app-a-mid']);
  });

  it('fills every place on a multi-spot slot', async () => {
    /* Two places on the later slot, three candidates, one of them already seated
       on the overlapping earlier slot. Both places must still fill. */
    await event('ev');
    await slot('ev', 'a-am', '09:00', '13:00', 1);
    await slot('ev', 'b-mid', '11:00', '15:00', 2);
    await apply('app-a-am', 'stu-a', 'ev', 'a-am');
    await apply('app-a-mid', 'stu-a', 'ev', 'b-mid');
    await apply('app-b-mid', 'stu-b', 'ev', 'b-mid');
    await apply('app-c-mid', 'stu-c', 'ev', 'b-mid');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds.sort()).toEqual(['app-a-am', 'app-b-mid', 'app-c-mid']);
    expect(waitlistIds).toEqual(['app-a-mid']);
  });

  it('leaves the place empty rather than double-booking when nobody else applied', async () => {
    await event('ev');
    await slot('ev', 'a-am', '09:00', '13:00', 1);
    await slot('ev', 'b-mid', '11:00', '15:00', 1);
    await apply('app-a-am', 'stu-a', 'ev', 'a-am');
    await apply('app-a-mid', 'stu-a', 'ev', 'b-mid');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    expect(selectedIds).toEqual(['app-a-am']);
    expect(waitlistIds, 'the clashing application must be queued, never dropped')
      .toEqual(['app-a-mid']);
  });
});

describe('several volunteers across several overlapping slots', () => {
  it('holds the invariant for everybody at once', async () => {
    /**
     * Four overlapping-in-places slots, five volunteers, everyone applying to
     * everything. This is the case where an off-by-one in the bookkeeping shows
     * up, and it asserts the invariant rather than a predicted outcome — the
     * point is that NOBODY is double-booked, whoever wins what.
     */
    await event('ev');
    await slot('ev', 's1', '09:00', '12:00', 2);
    await slot('ev', 's2', '11:00', '14:00', 2);
    await slot('ev', 's3', '13:00', '16:00', 2);
    await slot('ev', 's4', '15:00', '18:00', 2);

    const users = ['stu-a', 'stu-b', 'stu-c', 'stu-d', 'stu-e'];
    for (const u of users) {
      for (const s of ['s1', 's2', 's3', 's4']) await apply(`app-${u}-${s}`, u, 'ev', s);
    }

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);

    /* Nothing is lost: every application is either selected or queued, exactly
       once. A candidate silently vanishing would satisfy the invariant too. */
    const all = [...selectedIds, ...waitlistIds].sort();
    expect(all).toHaveLength(users.length * 4);
    expect(new Set(all).size, 'an application appears twice in the result').toBe(all.length);
  });

  it('still fills each slot to capacity where the pool allows', async () => {
    /* s1 and s3 do not overlap, so with five candidates each both should fill. */
    await event('ev');
    await slot('ev', 's1', '09:00', '11:00', 2);
    await slot('ev', 's3', '13:00', '15:00', 2);
    for (const u of ['stu-a', 'stu-b', 'stu-c', 'stu-d', 'stu-e']) {
      await apply(`app-${u}-s1`, u, 'ev', 's1');
      await apply(`app-${u}-s3`, u, 'ev', 's3');
    }

    const { selectedIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    const bySlot = {};
    for (const id of selectedIds) {
      const row = await db.prepare('SELECT slot_id FROM applications WHERE id = ?').get(id);
      bySlot[row.slot_id] = (bySlot[row.slot_id] || 0) + 1;
    }
    expect(bySlot).toEqual({ s1: 2, s3: 2 });
  });
});

describe('the within-draw rule composes with the rules that were already there', () => {
  it('does not fill a slot past its capacity', async () => {
    await event('ev');
    await slot('ev', 'only', '09:00', '12:00', 2);
    for (const u of ['stu-a', 'stu-b', 'stu-c', 'stu-d']) {
      await apply(`app-${u}`, u, 'ev', 'only');
    }

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    expect(selectedIds).toHaveLength(2);
    expect(waitlistIds).toHaveLength(2);
  });

  it('respects capacity already taken by a hand-accepted volunteer', async () => {
    await event('ev');
    await slot('ev', 'a-am', '09:00', '13:00', 1);
    await slot('ev', 'b-mid', '11:00', '15:00', 2);
    /* One place on the later slot is already held by somebody the organizer
       accepted by hand — and that acceptance also clashes for stu-b. */
    await apply('app-taken', 'stu-b', 'ev', 'b-mid', 'accepted');
    await apply('app-a-am', 'stu-a', 'ev', 'a-am');
    await apply('app-a-mid', 'stu-a', 'ev', 'b-mid');
    await apply('app-c-mid', 'stu-c', 'ev', 'b-mid');

    const { selectedIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    /* One place left on b-mid; stu-a is excluded by their own a-am selection, so
       it goes to stu-c. */
    expect(selectedIds.sort()).toEqual(['app-a-am', 'app-c-mid']);
  });

  it('still excludes somebody accepted to an overlapping shift on ANOTHER event', async () => {
    /* The committed-acceptance check and the within-draw check must both apply;
       neither replaces the other. */
    await event('held');
    await slot('held', 'h1', '10:00', '12:00', 5);
    await apply('app-held', 'stu-a', 'held', 'h1', 'accepted');

    await event('ev');
    await slot('ev', 'a-am', '11:00', '13:00', 1);
    await slot('ev', 'b-eve', '18:00', '20:00', 1);
    await apply('app-a-am', 'stu-a', 'ev', 'a-am');
    await apply('app-a-eve', 'stu-a', 'ev', 'b-eve');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds, 'the evening shift is free and should still be given')
      .toEqual(['app-a-eve']);
    expect(waitlistIds).toEqual(['app-a-am']);
  });

  it('ignores an overlapping acceptance on a cancelled event, as it always did', async () => {
    await event('off');
    await slot('off', 'o1', '10:00', '12:00', 5);
    await apply('app-off', 'stu-a', 'off', 'o1', 'accepted');
    await db.prepare("UPDATE events SET status = 'cancelled' WHERE id = 'off'").run();

    await event('ev');
    await slot('ev', 'a-am', '11:00', '13:00', 1);
    await apply('app-a-am', 'stu-a', 'ev', 'a-am');

    const { selectedIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    expect(selectedIds).toEqual(['app-a-am']);
  });

  /**
   * Weighting is untouched, and this is the assertion that says so.
   *
   * The fix removes candidates from a pool before the draw, exactly as the ban
   * and committed-clash filters already did. It must not disturb WHO the draw
   * picks out of the pool it is given — the curve rewards fewer credited hours,
   * and that has to still be true on a slot where no clash is involved at all.
   */
  it('leaves the hours weighting alone on an unconflicted slot', async () => {
    await event('ev');
    await slot('ev', 'only', '09:00', '12:00', 1);
    await apply('app-low', 'stu-a', 'ev', 'only');
    await apply('app-high', 'stu-b', 'ev', 'only');

    /* A real credited-hours history for stu-b, on a past event of its own.
       `attendance` is keyed (slot_id, user_id) — one row per shift attended — so
       the history needs a shift to hang on rather than forty rows on this one.
       120 hours is comfortably inside the range where the curve still separates
       two volunteers. */
    await event('history');
    await slot('history', 'h-done', '08:00', '09:00', 5);
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES ('history', 'h-done', 'stu-b', 1, 120)
    `).run();

    let lowWins = 0;
    for (let run = 1; run <= 40; run += 1) {
      const { selectedIds } = await computeDraw(db, 'ev', { runNumber: run });
      if (selectedIds[0] === 'app-low') lowWins += 1;
    }

    expect(
      lowWins,
      `the lower-hours volunteer won ${lowWins}/40 — the weighting curve is not being applied`,
    ).toBeGreaterThan(20);
  });
});

describe('adversarial arrangements', () => {
  it('holds when three slots all overlap each other', async () => {
    /* A chain is easy; a clique is where an implementation that only compares
       against the LAST selection instead of all of them comes apart. */
    await event('ev');
    await slot('ev', 's1', '09:00', '15:00', 1);
    await slot('ev', 's2', '10:00', '16:00', 1);
    await slot('ev', 's3', '11:00', '17:00', 1);
    for (const s of ['s1', 's2', 's3']) await apply(`app-${s}`, 'stu-a', 'ev', s);

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds).toEqual(['app-s1']);
    expect(waitlistIds.sort()).toEqual(['app-s2', 'app-s3']);
  });

  it('holds across a chain where the ends do NOT overlap each other', async () => {
    /**
     * 09–11, 10–12, 11–13. The first and last merely touch, so a volunteer may
     * hold both — but neither may be held with the middle one. An implementation
     * that treats "overlaps anything already taken" as transitive would wrongly
     * refuse the third.
     */
    await event('ev');
    await slot('ev', 'a', '09:00', '11:00', 1);
    await slot('ev', 'b', '10:00', '12:00', 1);
    await slot('ev', 'c', '11:00', '13:00', 1);
    for (const s of ['a', 'b', 'c']) await apply(`app-${s}`, 'stu-a', 'ev', s);

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds.sort(), 'the two touching shifts are both takeable')
      .toEqual(['app-a', 'app-c']);
    expect(waitlistIds).toEqual(['app-b']);
  });

  it('is unbothered by a slot with no places at all', async () => {
    /* A zero-capacity slot waitlists its whole pool and must not record anybody
       as seated — otherwise it would exclude them from a later shift they could
       have taken. */
    await event('ev');
    await slot('ev', 'a-zero', '09:00', '13:00', 0);
    await slot('ev', 'b-mid', '11:00', '15:00', 1);
    await apply('app-zero', 'stu-a', 'ev', 'a-zero');
    await apply('app-mid', 'stu-a', 'ev', 'b-mid');

    const { selectedIds, waitlistIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds, 'a place nobody got must not block a place they could get')
      .toEqual(['app-mid']);
    expect(waitlistIds).toEqual(['app-zero']);
  });

  it('is unbothered by a slot whose pool is entirely ineligible', async () => {
    /* Everybody on the earlier slot is already accepted elsewhere at that time,
       so it seats nobody — and must not record a phantom seating. */
    await event('held');
    await slot('held', 'h', '09:00', '13:00', 5);
    await apply('app-held', 'stu-a', 'held', 'h', 'accepted');

    await event('ev');
    await slot('ev', 'a-am', '10:00', '12:00', 1);
    await slot('ev', 'b-eve', '18:00', '20:00', 1);
    await apply('app-am', 'stu-a', 'ev', 'a-am');
    await apply('app-eve', 'stu-a', 'ev', 'b-eve');

    const { selectedIds } = await computeDraw(db, 'ev', { runNumber: 1 });

    await noDoubleBooking(selectedIds);
    expect(selectedIds).toEqual(['app-eve']);
  });
});
