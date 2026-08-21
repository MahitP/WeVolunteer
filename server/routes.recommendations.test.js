import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Regression cover for expired events appearing in "Suggested for you".
 *
 * `GET /api/recommendations` selected `WHERE e.status = 'open'` and nothing else
 * — no deadline check, no shift-end check, no capacity check. `status` stays
 * 'open' for the whole life of an event (it only becomes 'completed' when an
 * organizer finalises attendance, which many never do), so an event whose shifts
 * ended weeks ago kept being recommended to students on the Opportunities page.
 * Reproduced against a live server: an event with a deadline 5 days past and a
 * shift that ended 3 days ago was excluded from `?openOnly=true` — correctly —
 * and still came back from `/api/recommendations`.
 *
 * The rest of the app defines "open" as three conditions together (see
 * `openOnly` in eventQuery.js): posted open, deadline not passed, and a free
 * spot. Recommendations checked one of the three, so it could also suggest an
 * event that was already full.
 */

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const STUDENT = 'leo.chen@example.com';

/** Inserts an event directly, so it can be placed in the past. */
async function insertEvent({ id, title, deadlineDaysAgo, shiftEndedDaysAgo, status = 'open', maxSpots = 10, category = 'Other', description = 'Litter cleanup work.' }) {
  const { db } = await import('./db.js');
  const org = (await db.prepare("SELECT id FROM users WHERE role='organizer' LIMIT 1").get()).id;
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  const ahead = (d) => new Date(Date.now() + d * 864e5).toISOString();
  await db.prepare(`INSERT INTO events (id,title,description,category,location,application_deadline,organizer_id,status,created_at)
              VALUES (?,?,?,?,'Hall',?,?,?,?)`).run(
    id, title, description, category,
    deadlineDaysAgo > 0 ? ago(deadlineDaysAgo) : ahead(-deadlineDaysAgo),
    org, status, ago(60)
  );
  await db.prepare(`INSERT INTO slots (id,event_id,name,description,start_datetime,end_datetime,max_spots)
              VALUES (?,?,'Shift','work',?,?,?)`).run(
    `slot-${id}`, id,
    shiftEndedDaysAgo > 0 ? ago(shiftEndedDaysAgo) : ahead(-shiftEndedDaysAgo),
    shiftEndedDaysAgo > 0 ? ago(shiftEndedDaysAgo) : ahead(-shiftEndedDaysAgo + 0.1),
    maxSpots
  );
}

const ids = (body) => (Array.isArray(body) ? body : body?.events || body?.items || [])
  .map(e => e.event?.id || e.id);

describe('recommendations exclude events that can no longer be applied to', () => {
  let student;

  beforeAll(async () => {
    student = await srv.login(STUDENT);
    // Give the student a skill the probe events match, so scoring picks them up.
    await srv.call('PATCH', '/api/auth/profile', { skills: ['Litter'] }, student);

    await insertEvent({ id: 'rec-past', title: 'Past Litter Cleanup', deadlineDaysAgo: 5, shiftEndedDaysAgo: 3 });
    await insertEvent({ id: 'rec-future', title: 'Future Litter Cleanup', deadlineDaysAgo: -10, shiftEndedDaysAgo: -12 });
  });

  it('recommends an event that is still open', async () => {
    const res = await srv.call('GET', '/api/recommendations', undefined, student);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toContain('rec-future');
  });

  // The reported bug.
  it('does NOT recommend an event whose shifts have already ended', async () => {
    const res = await srv.call('GET', '/api/recommendations', undefined, student);
    expect(ids(res.body)).not.toContain('rec-past');
  });

  it('does NOT recommend a cancelled event', async () => {
    await insertEvent({ id: 'rec-cancelled', title: 'Cancelled Litter Cleanup', deadlineDaysAgo: -10, shiftEndedDaysAgo: -12, status: 'cancelled' });
    const res = await srv.call('GET', '/api/recommendations', undefined, student);
    expect(ids(res.body)).not.toContain('rec-cancelled');
  });

  it('does NOT recommend an event whose deadline has passed even if the shift is still ahead', async () => {
    // Possible in migrated or seeded data: the deadline is the gate students hit.
    await insertEvent({ id: 'rec-closed', title: 'Closed Litter Cleanup', deadlineDaysAgo: 2, shiftEndedDaysAgo: -20 });
    const res = await srv.call('GET', '/api/recommendations', undefined, student);
    expect(ids(res.body)).not.toContain('rec-closed');
  });

  it('does NOT recommend an event that is already full', async () => {
    const { db } = await import('./db.js');
    await insertEvent({ id: 'rec-full', title: 'Full Litter Cleanup', deadlineDaysAgo: -10, shiftEndedDaysAgo: -12, maxSpots: 1 });
    // Fill its only spot with somebody else.
    const other = (await db.prepare("SELECT id FROM users WHERE role='student' AND id != (SELECT id FROM users WHERE email = ?) LIMIT 1").get(STUDENT)).id;
    await db.prepare(`INSERT INTO applications (id,user_id,event_id,slot_id,status,applied_at)
                VALUES ('app-rec-full',?,'rec-full','slot-rec-full','accepted',?)`).run(other, new Date().toISOString());
    const res = await srv.call('GET', '/api/recommendations', undefined, student);
    expect(ids(res.body)).not.toContain('rec-full');
  });
});

describe('the paged event list agrees with recommendations about what is open', () => {
  it('openOnly already excludes the past event (unchanged behaviour)', async () => {
    const student = await srv.login(STUDENT);
    const res = await srv.call('GET', '/api/events?openOnly=true&limit=60', undefined, student);
    expect(ids(res.body)).not.toContain('rec-past');
  });

  // Kept deliberately: an unfiltered list is how dashboards render history.
  it('an unfiltered list still returns past events, for history views', async () => {
    const student = await srv.login(STUDENT);
    const res = await srv.call('GET', '/api/events', undefined, student);
    expect(ids(res.body)).toContain('rec-past');
  });
});
