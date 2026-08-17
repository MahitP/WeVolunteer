import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-impact-'));
process.env.WEV_DB_PATH = path.join(dir, 'impact.db');

let db, buildImpact, MIN_BUCKET;

/**
 * The community impact figures.
 *
 * ── The two things this file is really testing ──
 *
 * That the numbers are DEFENSIBLE, and that they cannot identify a child.
 *
 * The first matters because these figures go on college applications and into
 * grant reports. A total that counts a signup as a volunteer is worse than no
 * total: the first person who checks it stops believing the rest of the page.
 *
 * The second matters because the population is mostly minors, and an aggregate
 * over a small group is not anonymous. "One volunteer, Healthcare, March" is a
 * specific child to anybody who knows the school.
 */
beforeAll(async () => {
  const mod = await import('./db.js');
  mod.initDatabase();
  db = mod.db;
  ({ buildImpact, MIN_BUCKET } = await import('./impact.js'));
});

const wipe = () => {
  db.exec('DELETE FROM attendance');
  db.exec("DELETE FROM slots WHERE id LIKE 'i-%'");
  /* Explicitly, not via ON DELETE CASCADE: `PRAGMA foreign_keys` is per-connection
     and this harness does not assert it is on, so a leaked tag row would make the
     next test's breakdown non-empty for no visible reason. */
  db.exec("DELETE FROM event_tags WHERE event_id LIKE 'i-%'");
  db.exec("DELETE FROM events WHERE id LIKE 'i-%'");
  db.exec("DELETE FROM users WHERE id LIKE 'iv-%'");
  db.exec("DELETE FROM users WHERE id LIKE 'org-%'");
};

const NOW = '2026-03-01T10:00:00.000Z';

/**
 * The categories are the ones `events.category` actually permits.
 *
 * `VALID_CATEGORIES` is `School | 5K | Food Pantry | Fundraiser | Other` and the
 * column carries a CHECK constraint enforcing it, so the taxonomy in the impact
 * brief — Education, Food Security, Environment, Healthcare — does not exist yet
 * and cannot be inserted. Widening it is a product decision with a migration
 * behind it, recorded in docs/questions-for-owner.md; this module reports
 * whatever categories are real, so it needs no change when they change.
 */

/** Organizers are real rows: `events.organizer_id` is a foreign key. */
const addOrganizer = (id) => {
  db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role, verified,
                       email_verified, account_status, created_at, token_version)
    VALUES (?, ?, ?, ?, 'x', 'N/A', 'organizer', 1, 1, 'active', ?, 0)
    ON CONFLICT DO NOTHING
  `).run(id, `Org ${id}`, `${id}@example.invalid`, id, NOW);
};

const addEvent = (id, category, organizerId, location = 'Community Hall') => {
  addOrganizer(organizerId);
  db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, status, created_at)
    VALUES (?, ?, 'd', ?, ?, ?, ?, 'open', ?)
  `).run(id, `Event ${id}`, category, location, NOW, organizerId, NOW);
  db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, 'Shift', '', ?, ?, 50)
  `).run(`i-slot-${id}`, id, NOW, NOW);
};

const addVolunteer = (id) => {
  db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role, verified,
                       email_verified, account_status, created_at, token_version)
    VALUES (?, ?, ?, ?, 'x', '11', 'student', 1, 1, 'active', ?, 0)
    ON CONFLICT DO NOTHING
  `).run(id, `Volunteer ${id}`, `${id}@example.invalid`, id, NOW);
};

/**
 * A second shift on the same event needs a second SLOT: `attendance` is unique
 * on (slot_id, user_id), which is correct — one person cannot attend one shift
 * twice — and is why "two shifts, one event" has to be modelled properly rather
 * than by inserting the same row again.
 */
const addSlot = (eventId, suffix) => {
  db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, 'Shift', '', ?, ?, 50)
  `).run(`i-slot-${eventId}-${suffix}`, eventId, NOW, NOW);
  return `i-slot-${eventId}-${suffix}`;
};

/**
 * `n` distinct volunteers, each credited an hour on `eventId`.
 *
 * At module scope rather than inside one describe: the tag breakdown needs the
 * same "put a bucket either side of the threshold" fixture the category
 * suppression test does, and a second copy is how two fixtures drift apart.
 */
const fill = (n, eventId) => {
  for (let i = 1; i <= n; i += 1) {
    addVolunteer(`iv-${eventId}-${i}`);
    attend(`iv-${eventId}-${i}`, eventId, 1);
  }
};

const addTag = (eventId, label) => {
  db.prepare('INSERT INTO event_tags (event_id, tag, label) VALUES (?, ?, ?)')
    .run(eventId, label.toLowerCase(), label);
};

const attend = (userId, eventId, hours, present = 1, slotId = null) => {
  db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, ?, ?)
  `).run(eventId, slotId ?? `i-slot-${eventId}`, userId, present, hours);
};

beforeEach(() => wipe());

describe('community totals', () => {
  /**
   * The distinction the credibility of the whole page rests on.
   *
   * Registrations are a marketing figure; attendance is an impact figure.
   * Conflating them is the most common way a dashboard like this stops being
   * believed, and it is invisible until somebody checks.
   */
  it('counts people who turned up, not people who signed up', async () => {
    addEvent('i-e1', 'Food Pantry', 'org-1');
    addVolunteer('iv-1');
    addVolunteer('iv-2');
    attend('iv-1', 'i-e1', 3);
    attend('iv-2', 'i-e1', 0, /* present */ 0);

    const { community } = await buildImpact(db);
    expect(community.totalVolunteers).toBe(1);
    expect(community.totalHours).toBe(3);
  });

  it('counts an event as completed only once somebody attended it', async () => {
    addEvent('i-e1', 'School', 'org-1');
    addEvent('i-e2', 'School', 'org-1');
    addVolunteer('iv-1');
    attend('iv-1', 'i-e1', 2);

    const { community } = await buildImpact(db);
    expect(community.eventsCompleted).toBe(1);
  });

  it('counts an organization once however many events it ran', async () => {
    addEvent('i-e1', 'School', 'org-1');
    addEvent('i-e2', 'School', 'org-1');
    addEvent('i-e3', '5K', 'org-2');
    addVolunteer('iv-1');
    attend('iv-1', 'i-e1', 1);
    attend('iv-1', 'i-e2', 1);
    attend('iv-1', 'i-e3', 1);

    expect((await buildImpact(db)).community.organizationsSupported).toBe(2);
  });

  it('reports zeros rather than nulls for an empty platform', async () => {
    const { community } = await buildImpact(db);
    expect(community).toEqual({
      totalVolunteers: 0, totalHours: 0, eventsCompleted: 0, organizationsSupported: 0,
    });
  });
});

describe('volunteer insights', () => {
  /**
   * Two shifts at one event is one commitment, not two. Counting it as two
   * turns a retention metric into an attendance metric — and retention is the
   * figure a grant reader weighs most heavily.
   */
  it('counts a returning volunteer by distinct events, not by shifts', async () => {
    addEvent('i-e1', 'School', 'org-1');
    addEvent('i-e2', 'School', 'org-1');
    addVolunteer('iv-1');
    addVolunteer('iv-2');
    // iv-1 twice at the SAME event (two shifts); iv-2 at two different events.
    attend('iv-1', 'i-e1', 2);
    attend('iv-1', 'i-e1', 2, 1, addSlot('i-e1', 'b'));
    attend('iv-2', 'i-e1', 1);
    attend('iv-2', 'i-e2', 1);

    expect((await buildImpact(db)).volunteers.returningRate).toBe(50);
  });

  /**
   * The median sits beside the mean so a reader can tell a broad programme from
   * a narrow one with a star. One volunteer with 200 hours drags an average
   * nobody in the room would recognise.
   */
  it('reports a median alongside the average', async () => {
    addEvent('i-e1', 'School', 'org-1');
    ['iv-1', 'iv-2', 'iv-3'].forEach(addVolunteer);
    attend('iv-1', 'i-e1', 1);
    attend('iv-2', 'i-e1', 2);
    attend('iv-3', 'i-e1', 60);

    const { volunteers } = await buildImpact(db);
    expect(volunteers.averageHours).toBe(21);
    expect(volunteers.medianHours).toBe(2);
  });

  /** Zero is a claim — "nobody came back". An empty programme has not made it. */
  it('is null rather than zero when there is nobody to average', async () => {
    const { volunteers } = await buildImpact(db);
    expect(volunteers.averageHours).toBeNull();
    expect(volunteers.returningRate).toBeNull();
  });
});

describe('the privacy threshold', () => {

  /**
   * The assertion this whole module is shaped around.
   *
   * A category with two volunteers is two identifiable students, and "who did
   * the Healthcare shifts" is answerable by anybody at a small school.
   */
  it('suppresses a category smaller than the threshold', async () => {
    addEvent('i-big', 'Food Pantry', 'org-1');
    addEvent('i-small', 'Fundraiser', 'org-2');
    fill(MIN_BUCKET, 'i-big');
    fill(MIN_BUCKET - 1, 'i-small');

    const { categories } = await buildImpact(db);
    const big = categories.find(c => c.label === 'Food Pantry');
    const small = categories.find(c => c.label === 'Fundraiser');

    expect(big.suppressed).toBe(false);
    expect(big.count).toBe(MIN_BUCKET);

    expect(small.suppressed).toBe(true);
    expect(small.count).toBeNull();
  });

  /**
   * Suppressed, not dropped.
   *
   * A reader who sees eleven categories and four figures knows something was
   * withheld. A reader who sees four categories believes that is all there is,
   * which is a quieter kind of lie — and it would let somebody infer the missing
   * categories by comparing the total against the visible parts.
   */
  it('still lists a suppressed bucket, so nothing looks like it never happened', async () => {
    addEvent('i-small', 'Fundraiser', 'org-1');
    fill(2, 'i-small');

    const { categories } = await buildImpact(db);
    expect(categories.map(c => c.label)).toContain('Fundraiser');
    expect(categories[0].count).toBeNull();
  });

  it('suppresses a thin month the same way', async () => {
    addEvent('i-e1', 'School', 'org-1');
    fill(2, 'i-e1');

    const { growth } = await buildImpact(db);
    expect(growth).toHaveLength(1);
    expect(growth[0].suppressed).toBe(true);
    expect(growth[0].count).toBeNull();
  });

  /**
   * The platform-wide totals are NOT suppressed. A total over the whole
   * population identifies nobody, and suppressing it would make the page
   * useless for the smallest programmes — which are the ones that most need to
   * show they exist.
   */
  it('never suppresses the platform-wide totals', async () => {
    addEvent('i-e1', 'School', 'org-1');
    fill(1, 'i-e1');

    const { community } = await buildImpact(db);
    expect(community.totalVolunteers).toBe(1);
    expect(community.totalHours).toBe(1);
  });

  /**
   * No names, no ids, no coordinates, anywhere in the payload.
   *
   * Asserted over the serialised whole rather than field by field, because the
   * risk is a field somebody ADDS later — a "top volunteer", an organizer name,
   * a location label — and a per-field test would not be looking at it.
   */
  it('leaks no identifier anywhere in the payload', async () => {
    addEvent('i-e1', 'School', 'org-1', '221B Baker Street');
    addVolunteer('iv-1');
    attend('iv-1', 'i-e1', 4);

    const json = JSON.stringify(await buildImpact(db));
    expect(json).not.toContain('iv-1');
    expect(json).not.toContain('Volunteer iv-1');
    expect(json).not.toContain('@example.invalid');
    expect(json).not.toContain('org-1');
    expect(json).not.toContain('221B Baker Street');
    expect(json).not.toContain('i-e1');
  });

  /** Geography is a count and nothing else until there is a real region model. */
  it('publishes a count of places and never the places themselves', async () => {
    addEvent('i-e1', 'School', 'org-1', 'Lincoln High School');
    addEvent('i-e2', 'School', 'org-1', 'Riverside Park');
    addVolunteer('iv-1');
    attend('iv-1', 'i-e1', 1);
    attend('iv-1', 'i-e2', 1);

    const { geography } = await buildImpact(db);
    expect(geography.distinctLocations).toBe(2);
    expect(geography.breakdown).toEqual([]);
    expect(JSON.stringify(geography)).not.toContain('Lincoln');
  });
});

describe('the tag breakdown', () => {
  /**
   * The section that answers what `events.category` cannot.
   *
   * `5K` is a format and `Fundraiser` is a mechanism; neither says what the effort
   * was FOR. Tags are the organizer's own words, so they carry that — which is the
   * whole reason Q-2 asked for them.
   */
  it('reports hours and events under each tag an organizer used', async () => {
    addEvent('i-a', 'School', 'org-1');
    addTag('i-a', 'Environment');
    addTag('i-a', 'Education');
    fill(MIN_BUCKET, 'i-a');

    const { tags } = await buildImpact(db);
    const env = tags.breakdown.find(t => t.tag === 'environment');

    expect(env.label).toBe('Environment');
    expect(env.suppressed).toBe(false);
    expect(env.count).toBe(MIN_BUCKET);
    expect(env.events).toBe(1);
    expect(env.hours).toBeGreaterThan(0);
  });

  /**
   * The same floor as every other breakdown, and it matters MORE here.
   *
   * A category is one of five broad words. An organizer-typed tag can name a room
   * or a person — `#MrsAlvarezTutoring` — so a bucket of two is far more
   * identifying than a category of two. This is the privacy hazard Q-2 flagged
   * before tags existed, which is why the floor is not optional on this section.
   */
  it('suppresses a tag used by fewer volunteers than the threshold', async () => {
    addEvent('i-big', 'School', 'org-1');
    addEvent('i-small', 'School', 'org-2');
    addTag('i-big', 'Popular');
    addTag('i-small', 'Specific');
    fill(MIN_BUCKET, 'i-big');
    fill(MIN_BUCKET - 1, 'i-small');

    const { tags } = await buildImpact(db);
    const big = tags.breakdown.find(t => t.tag === 'popular');
    const small = tags.breakdown.find(t => t.tag === 'specific');

    expect(big.suppressed).toBe(false);
    expect(small.suppressed).toBe(true);
    expect(small.count).toBeNull();
    /* Present rather than dropped: a reader who sees a withheld row knows
       something was held back, which is the whole argument in bucket(). */
    expect(small).toBeTruthy();
  });

  /**
   * The overlap, declared.
   *
   * An event's hours count under EVERY tag it carries, so the column sums to more
   * than the platform total. That is inherent to many-to-many tagging and is the
   * one way this section can badly mislead — so the flag travels in the payload
   * for the screen to say it beside the numbers.
   */
  it('declares that its hours overlap, and they really do', async () => {
    addEvent('i-multi', 'School', 'org-1');
    addTag('i-multi', 'One');
    addTag('i-multi', 'Two');
    fill(MIN_BUCKET, 'i-multi');

    const out = await buildImpact(db);
    expect(out.tags.overlapping).toBe(true);

    const summed = out.tags.breakdown.reduce((total, t) => total + t.hours, 0);
    /* Two tags on one event, so the tag column is exactly twice the real total.
       If this ever stops being true the flag is the thing to re-examine. */
    expect(summed).toBeCloseTo(out.community.totalHours * 2, 5);
  });

  it('counts nothing for a tag on an event nobody attended', async () => {
    addEvent('i-empty', 'School', 'org-1');
    addTag('i-empty', 'Ghost');

    expect((await buildImpact(db)).tags.breakdown).toEqual([]);
  });

  /** Absence is not zero: an untagged programme gets an empty section, not a gap. */
  it('returns an empty breakdown when nobody tags anything', async () => {
    addEvent('i-plain', 'School', 'org-1');
    fill(MIN_BUCKET, 'i-plain');

    const { tags, categories } = await buildImpact(db);
    expect(tags.breakdown).toEqual([]);
    /* And the category section still reports it — which is why both sections
       exist: a tag-only breakdown would silently omit every untagged event. */
    expect(categories.find(c => c.label === 'School')).toBeTruthy();
  });
});

describe('shape', () => {
  /** Sections are always present, so a client never distinguishes missing from none. */
  it('returns every section even with no data at all', async () => {
    const out = await buildImpact(db);
    expect(Object.keys(out).sort()).toEqual(
      ['categories', 'community', 'generatedAt', 'geography', 'growth', 'minBucket', 'tags', 'volunteers']
    );
    expect(out.growth).toEqual([]);
    expect(out.categories).toEqual([]);
    /* The tag section is an OBJECT, not an array: it carries the
       `overlapping` flag alongside its buckets, because an event's hours are
       counted under every tag it has and summing the column exceeds the
       platform total. A reader must be told that beside the numbers. */
    expect(out.tags).toEqual({ overlapping: true, breakdown: [] });
  });

  /** The client renders the threshold in its own footnote; it should not hardcode it. */
  it('tells the client what the threshold is', async () => {
    expect((await buildImpact(db)).minBucket).toBe(MIN_BUCKET);
  });
});
