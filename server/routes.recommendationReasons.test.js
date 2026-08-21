import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Why an opportunity is suggested, and how far away it is.
 *
 * `GET /api/recommendations` returned a bare `score` — a number with no account
 * of what produced it. A student could not tell whether a suggestion came from
 * something they had chosen or from a word that happened to appear in a
 * description, and neither could anyone maintaining the ranking.
 *
 * It also had no notion of distance at all, while the browse list beside it had
 * offered distance filtering and sorting for months.
 *
 * These cover the added surface: coordinate validation, the tag and distance
 * terms, and the property that every reason returned corresponds to a term that
 * actually fired.
 */

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const STUDENT = 'leo.chen@example.com';

/** Somewhere fixed to measure from, and a point a known distance away. */
const HOME = { lat: 40.0000, lng: -74.0000 };
const NEAR = { lat: 40.0100, lng: -74.0000 };   // ~0.7 mi north
const FAR = { lat: 40.5000, lng: -74.0000 };    // ~34 mi north

async function insertEvent({ id, title, tags = [], lat = null, lng = null, category = 'Other', description = 'General help.' }) {
  const { db } = await import('./db.js');
  const org = (await db.prepare("SELECT id FROM users WHERE role='organizer' LIMIT 1").get()).id;
  const ahead = d => new Date(Date.now() + d * 864e5).toISOString();

  await db.prepare(`INSERT INTO events (id,title,description,category,location,application_deadline,organizer_id,status,created_at,latitude,longitude)
              VALUES (?,?,?,?,'Hall',?,?, 'open', ?, ?, ?)`)
    .run(id, title, description, category, ahead(10), org, ahead(-30), lat, lng);

  await db.prepare(`INSERT INTO slots (id,event_id,name,description,start_datetime,end_datetime,max_spots)
              VALUES (?,?,'Shift','work',?,?,20)`)
    .run(`slot-${id}`, id, ahead(12), ahead(12.2));

  for (const label of tags) {
    const { normaliseTag } = await import('./eventTags.js');
    const n = normaliseTag(label);
    await db.prepare('INSERT INTO event_tags (event_id, tag, label) VALUES (?,?,?)')
      .run(id, n.tag, n.label);
  }
}

const find = (body, id) => (Array.isArray(body) ? body : []).find(e => e.id === id);

describe('coordinate validation', () => {
  let student;
  beforeAll(async () => { student = await srv.login(STUDENT); });

  it('refuses one coordinate without the other', async () => {
    /**
     * Rejecting rather than ignoring matters because the failure would
     * otherwise be silent: distances would stop appearing with nothing to say
     * why. Same rule the browse list applies.
     */
    const res = await srv.call('GET', '/api/recommendations?lat=40', undefined, student);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/together/i);

    const other = await srv.call('GET', '/api/recommendations?lng=-74', undefined, student);
    expect(other.status).toBe(400);
  });

  it('refuses coordinates outside the possible range', async () => {
    const lat = await srv.call('GET', '/api/recommendations?lat=91&lng=0', undefined, student);
    expect(lat.status).toBe(400);
    expect(lat.body.error).toMatch(/-90 and 90/);

    const lng = await srv.call('GET', '/api/recommendations?lat=0&lng=181', undefined, student);
    expect(lng.status).toBe(400);
    expect(lng.body.error).toMatch(/-180 and 180/);
  });

  it('refuses coordinates that are not numbers', async () => {
    const res = await srv.call('GET', '/api/recommendations?lat=north&lng=west', undefined, student);
    expect(res.status).toBe(400);
  });

  it('works with no coordinates at all', async () => {
    /* Location is optional and always has been. A student who has not shared
       one still gets recommendations, just without distance. */
    const res = await srv.call('GET', '/api/recommendations', undefined, student);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('authorization is unchanged', () => {
  it('gives a non-student an empty list rather than a 403', async () => {
    /* Existing deliberate behaviour, recorded in the handler. Adding params
       must not have turned it into a refusal. The account is read from the
       seed rather than named, so this does not break when the demo data
       changes. */
    const { db } = await import('./db.js');
    const row = await db.prepare(
      "SELECT email FROM users WHERE role='organizer' AND account_status='active' LIMIT 1",
    ).get();
    expect(row, 'the demo seed should contain an organizer').toBeTruthy();

    const organizer = await srv.login(row.email);
    const res = await srv.call('GET', '/api/recommendations', undefined, organizer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await srv.call('GET', '/api/recommendations');
    expect(res.status).toBe(401);
  });
});

describe('reasons explain the ranking', () => {
  let student;

  beforeAll(async () => {
    student = await srv.login(STUDENT);
    await srv.call('PATCH', '/api/auth/profile', {
      skills: ['Gardening'], hobbies: ['Environment'],
    }, student);

    await insertEvent({ id: 'rr-tagged', title: 'Native Plant Restoration', tags: ['Environment'], lat: NEAR.lat, lng: NEAR.lng });
    await insertEvent({ id: 'rr-far', title: 'Distant Environment Day', tags: ['Environment'], lat: FAR.lat, lng: FAR.lng });
    await insertEvent({ id: 'rr-plain', title: 'Unrelated Bake Sale', description: 'Sell cakes.' });
  });

  it('names the interest tag that matched', async () => {
    const res = await srv.call('GET', '/api/recommendations', undefined, student);
    const tagged = find(res.body, 'rr-tagged');

    expect(tagged).toBeTruthy();
    expect(tagged.reasons).toEqual(
      expect.arrayContaining([{ kind: 'tag', value: 'Environment' }]),
    );
  });

  it('reports the distance only when coordinates were supplied', async () => {
    const without = await srv.call('GET', '/api/recommendations', undefined, student);
    expect(find(without.body, 'rr-tagged').distance).toBeNull();

    const with_ = await srv.call(
      'GET', `/api/recommendations?lat=${HOME.lat}&lng=${HOME.lng}`, undefined, student,
    );
    expect(find(with_.body, 'rr-tagged').distance).toBeGreaterThan(0);
    expect(find(with_.body, 'rr-tagged').distance).toBeLessThan(2);
  });

  it('gives a nearby reason only to what is actually nearby', async () => {
    const res = await srv.call(
      'GET', `/api/recommendations?lat=${HOME.lat}&lng=${HOME.lng}`, undefined, student,
    );

    const near = find(res.body, 'rr-tagged');
    const far = find(res.body, 'rr-far');

    expect(near.reasons.some(r => r.kind === 'distance')).toBe(true);
    /* Roughly 34 miles away — well outside the nearby threshold, so no
       proximity claim is made about it. */
    if (far) expect(far.reasons.some(r => r.kind === 'distance')).toBe(false);
  });

  it('ranks the near match above the far one when both match equally', async () => {
    const res = await srv.call(
      'GET', `/api/recommendations?lat=${HOME.lat}&lng=${HOME.lng}`, undefined, student,
    );
    const order = res.body.map(e => e.id);
    if (order.includes('rr-tagged') && order.includes('rr-far')) {
      expect(order.indexOf('rr-tagged')).toBeLessThan(order.indexOf('rr-far'));
    }
  });

  it('never states a reason for a term that did not fire', async () => {
    /**
     * The property that makes an explanation worth showing. Every reason has
     * to correspond to something that actually contributed, or the explanation
     * is a plausible-sounding restatement rather than the real basis.
     */
    const res = await srv.call(
      'GET', `/api/recommendations?lat=${HOME.lat}&lng=${HOME.lng}`, undefined, student,
    );

    for (const rec of res.body) {
      for (const reason of rec.reasons) {
        expect(['tag', 'skill', 'category', 'distance']).toContain(reason.kind);
        if (reason.kind === 'tag') {
          expect(rec.tags.map(t => t.label)).toContain(reason.value);
        }
        if (reason.kind === 'distance') {
          expect(rec.distance).not.toBeNull();
          expect(reason.miles).toBeLessThanOrEqual(5);
        }
        if (reason.kind === 'category') {
          expect(reason.value).toBe(rec.category);
        }
      }
      /* A scored recommendation must be able to account for itself. */
      if (rec.score > 0) expect(rec.reasons.length).toBeGreaterThan(0);
    }
  });

});

describe('an interest is not counted twice', () => {
  it('does not list a tag and a keyword for the same word', async () => {
    /**
     * "Gardening" as both a skill and an event tag would otherwise score twice
     * and appear twice in the explanation, making one interest look like two
     * independent reasons.
     */
    const student = await srv.login(STUDENT);
    await srv.call('PATCH', '/api/auth/profile', { skills: ['Gardening'], hobbies: [] }, student);

    await insertEvent({
      id: 'rr-double', title: 'Gardening Morning',
      description: 'Gardening in the community plot.', tags: ['Gardening'],
    });

    const res = await srv.call('GET', '/api/recommendations', undefined, student);
    const rec = find(res.body, 'rr-double');
    if (!rec) return;

    const values = rec.reasons.map(r => String(r.value).toLowerCase());
    expect(values.filter(v => v === 'gardening')).toHaveLength(1);
  });
});
