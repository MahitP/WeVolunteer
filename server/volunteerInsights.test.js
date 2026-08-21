import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  buildStreak, monthKeys, monthlyHours, milestoneInputs,
  firstVolunteeredAt, kindsOfService, upcomingCount, volunteerInsights,
} from './volunteerInsights.js';

/**
 * The dashboard's figures, as definitions rather than as HTTP.
 *
 * In-memory schema mirroring the real one for the tables these touch. Nothing
 * here can reach a real database.
 */

const NOW = new Date('2026-08-11T12:00:00.000Z');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, category TEXT, status TEXT DEFAULT 'open'
    );
    CREATE TABLE slots (
      id TEXT PRIMARY KEY, event_id TEXT, start_datetime TEXT, end_datetime TEXT
    );
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, user_id TEXT, event_id TEXT, slot_id TEXT, status TEXT
    );
    CREATE TABLE attendance (
      event_id TEXT, slot_id TEXT, user_id TEXT, present INTEGER, hours_awarded REAL,
      PRIMARY KEY (slot_id, user_id)
    );
  `);
  return db;
}

let db;
let n = 0;

/** A credited shift that ended on `endIso`. */
function credit(userId, endIso, { hours = 3, category = 'School', status = 'open', present = 1 } = {}) {
  n += 1;
  const eventId = `e${n}`;
  const slotId = `s${n}`;
  db.prepare('INSERT INTO events (id, category, status) VALUES (?, ?, ?)').run(eventId, category, status);
  db.prepare('INSERT INTO slots (id, event_id, start_datetime, end_datetime) VALUES (?, ?, ?, ?)')
    .run(slotId, eventId, endIso, endIso);
  db.prepare('INSERT INTO applications (id, user_id, event_id, slot_id, status) VALUES (?, ?, ?, ?, ?)')
    .run(`a${n}`, userId, eventId, slotId, 'accepted');
  db.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, slotId, userId, present, hours);
  return { eventId, slotId };
}

beforeEach(() => { db = makeDb(); n = 0; });

describe('monthKeys', () => {
  it('returns the six months ending in the current one', () => {
    expect(monthKeys(NOW, 6)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
  });

  it('crosses a year boundary correctly', () => {
    expect(monthKeys(new Date('2026-02-15T00:00:00Z'), 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('does not skip February when today is the 31st', () => {
    /**
     * The classic month-arithmetic bug. `d.setMonth(d.getMonth() - 1)` on the
     * 31st of March produces the 3rd of March, because February has no 31st and
     * the overflow rolls forward — so the series would contain March twice and
     * no February at all.
     */
    expect(monthKeys(new Date('2026-03-31T23:00:00Z'), 3)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

describe('buildStreak', () => {
  it('counts consecutive months back from the current one', () => {
    expect(buildStreak(['2026-06', '2026-07', '2026-08'], NOW).current).toBe(3);
  });

  it('does not break mid-month when this month is still empty', () => {
    /**
     * On the 11th nobody has failed to do anything yet. A streak that reset at
     * midnight on the 1st would be a countdown, and a countdown is the mechanic
     * that turns continuity into pressure.
     */
    expect(buildStreak(['2026-06', '2026-07'], NOW).current).toBe(2);
  });

  it('ends the streak once a whole month has been missed', () => {
    expect(buildStreak(['2026-05', '2026-06'], NOW).current).toBe(0);
  });

  it('ignores gaps further back', () => {
    expect(buildStreak(['2026-01', '2026-07', '2026-08'], NOW).current).toBe(2);
  });

  it('counts December into January as consecutive', () => {
    expect(buildStreak(['2025-12', '2026-01'], new Date('2026-01-20T00:00:00Z')).current).toBe(2);
  });

  it('remembers the longest run even after it is broken', () => {
    /* A record of having once done four months running is worth keeping. */
    const streak = buildStreak(['2025-01', '2025-02', '2025-03', '2025-04', '2026-08'], NOW);
    expect(streak.longest).toBe(4);
    expect(streak.current).toBe(1);
  });

  it('is zero for a volunteer with no credited attendance', () => {
    expect(buildStreak([], NOW)).toEqual({ current: 0, longest: 0 });
  });

  it('tolerates duplicate and unsorted months', () => {
    expect(buildStreak(['2026-08', '2026-07', '2026-08', '2026-06'], NOW).current).toBe(3);
  });
});

describe('monthlyHours', () => {
  it('always returns exactly six entries, oldest first', async () => {
    credit('u1', '2026-08-02T15:00:00.000Z');
    const series = await monthlyHours(db, 'u1', { now: NOW });
    expect(series).toHaveLength(6);
    expect(series.map(r => r.month)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
  });

  it('fills a quiet month with zero rather than dropping it', async () => {
    /**
     * The query returns only months with hours, so a quiet month used to vanish
     * from the series and the chart drew the remaining months side by side —
     * an axis that was a list of qualifying months rather than a timeline.
     */
    credit('u1', '2026-06-02T15:00:00.000Z', { hours: 4 });
    credit('u1', '2026-08-02T15:00:00.000Z', { hours: 2 });

    const series = await monthlyHours(db, 'u1', { now: NOW });
    expect(series.find(r => r.month === '2026-07').hours).toBe(0);
    expect(series.find(r => r.month === '2026-06').hours).toBe(4);
    expect(series.find(r => r.month === '2026-08').hours).toBe(2);
  });

  it('makes the last entry always the current month', async () => {
    /* This is what makes `highlightLast` mean "this month" rather than "the
       most recent month that happened to have activity". */
    credit('u1', '2026-05-02T15:00:00.000Z');
    expect((await monthlyHours(db, 'u1', { now: NOW })).at(-1)).toEqual({ month: '2026-08', hours: 0 });
  });

  it('counts nothing for an absent shift', async () => {
    credit('u1', '2026-08-02T15:00:00.000Z', { present: 0, hours: 3 });
    expect((await monthlyHours(db, 'u1', { now: NOW })).at(-1).hours).toBe(0);
  });

  it('is scoped to one volunteer', async () => {
    credit('u1', '2026-08-02T15:00:00.000Z', { hours: 5 });
    credit('u2', '2026-08-03T15:00:00.000Z', { hours: 9 });
    expect((await monthlyHours(db, 'u1', { now: NOW })).at(-1).hours).toBe(5);
  });

  it('returns six zeroes for a volunteer who has done nothing', async () => {
    expect((await monthlyHours(db, 'u1', { now: NOW })).every(r => r.hours === 0)).toBe(true);
  });
});

describe('record figures', () => {
  it('counts distinct kinds of service, not shifts', async () => {
    credit('u1', '2026-07-02T15:00:00.000Z', { category: 'School' });
    credit('u1', '2026-07-09T15:00:00.000Z', { category: 'School' });
    credit('u1', '2026-08-02T15:00:00.000Z', { category: 'Food Pantry' });
    expect(await kindsOfService(db, 'u1')).toBe(2);
  });

  it('reports the first credited shift, and never after the last', async () => {
    credit('u1', '2026-05-02T15:00:00.000Z');
    credit('u1', '2026-08-02T15:00:00.000Z');
    expect(await firstVolunteeredAt(db, 'u1')).toBe('2026-05-02T15:00:00.000Z');
  });

  it('has no first shift for a new account', async () => {
    expect(await firstVolunteeredAt(db, 'u1')).toBeNull();
  });

  it('excludes a cancelled event from upcoming commitments', async () => {
    /* A commitment to something that is not happening is not a commitment. */
    credit('u1', '2027-01-02T15:00:00.000Z', { status: 'cancelled' });
    credit('u1', '2027-01-09T15:00:00.000Z', { status: 'open' });
    expect(await upcomingCount(db, 'u1', { now: NOW.toISOString() })).toBe(1);
  });
});

describe('milestoneInputs', () => {
  it('counts distinct events, not shifts', async () => {
    const { eventId } = credit('u1', '2026-07-02T15:00:00.000Z', { hours: 2 });
    /* A second shift at the same event. */
    db.prepare('INSERT INTO slots (id, event_id, start_datetime, end_datetime) VALUES (?, ?, ?, ?)')
      .run('s-extra', eventId, '2026-07-03T09:00:00.000Z', '2026-07-03T12:00:00.000Z');
    db.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, 's-extra', 'u1', 1, 3);

    const inputs = await milestoneInputs(db, 'u1');
    expect(inputs.events).toBe(1);
    expect(inputs.shifts).toBe(2);
    expect(inputs.hours).toBe(5);
  });

  it('counts a cancelled event, because the service still happened', async () => {
    /**
     * Deliberately different from `volunteerStats().eventsAttended`, which
     * excludes cancelled events. The profile route has always derived milestone
     * inputs this way, and the two surfaces must not disagree about whether a
     * tier is earned. This test is the reason the derivation is shared.
     */
    credit('u1', '2026-07-02T15:00:00.000Z', { status: 'cancelled' });
    expect((await milestoneInputs(db, 'u1')).events).toBe(1);
  });

  it('is zero, not null, for an untouched account', async () => {
    /* `null >= 0` is true, so a null here would earn the first milestone at
       zero events. */
    expect(await milestoneInputs(db, 'u1')).toEqual({ hours: 0, events: 0, shifts: 0 });
  });
});

describe('volunteerInsights', () => {
  it('composes the whole payload', async () => {
    credit('u1', '2026-07-02T15:00:00.000Z', { hours: 4, category: 'School' });
    credit('u1', '2026-08-02T15:00:00.000Z', { hours: 6, category: 'Food Pantry' });

    const out = await volunteerInsights(db, 'u1', { now: NOW });

    expect(out.monthlyHours).toHaveLength(6);
    expect(out.record.hoursCredited).toBe(10);
    expect(out.record.kindsOfService).toBe(2);
    expect(out.streak.current).toBe(2);
    expect(out.milestones.find(m => m.id === 'first-shift').earned).toBe(true);
    expect(out.serviceHourGoal).toBeGreaterThan(0);
  });

  it('answers for a volunteer who has done nothing without throwing', async () => {
    const out = await volunteerInsights(db, 'u1', { now: NOW });
    expect(out.record.hoursCredited).toBe(0);
    expect(out.streak).toEqual({ current: 0, longest: 0 });
    expect(out.milestones.every(m => m.earned === false)).toBe(true);
  });
});
