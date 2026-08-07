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
    INSERT OR IGNORE INTO users (id, name, email, username, password_hash, grade, role, verified,
                       email_verified, account_status, created_at, token_version)
    VALUES (?, ?, ?, ?, 'x', 'N/A', 'organizer', 1, 1, 'active', ?, 0)
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
  it('counts people who turned up, not people who signed up', () => {
    addEvent('i-e1', 'Food Pantry', 'org-1');
    addVolunteer('iv-1');
    addVolunteer('iv-2');
    attend('iv-1', 'i-e1', 3);
    attend('iv-2', 'i-e1', 0, /* present */ 0);

    const { community } = buildImpact(db);
    expect(community.totalVolunteers).toBe(1);
    expect(community.totalHours).toBe(3);
  });

  it('counts an event as completed only once somebody attended it', () => {
    addEvent('i-e1', 'School', 'org-1');
    addEvent('i-e2', 'School', 'org-1');
    addVolunteer('iv-1');
    attend('iv-1', 'i-e1', 2);

    const { community } = buildImpact(db);
    expect(community.eventsCompleted).toBe(1);
  });

  it('counts an organization once however many events it ran', () => {
    addEvent('i-e1', 'School', 'org-1');
    addEvent('i-e2', 'School', 'org-1');
    addEvent('i-e3', '5K', 'org-2');
    addVolunteer('iv-1');
    attend('iv-1', 'i-e1', 1);
    attend('iv-1', 'i-e2', 1);
    attend('iv-1', 'i-e3', 1);

    expect(buildImpact(db).community.organizationsSupported).toBe(2);
  });

  it('reports zeros rather than nulls for an empty platform', () => {
    const { community } = buildImpact(db);
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
  it('counts a returning volunteer by distinct events, not by shifts', () => {
    addEvent('i-e1', 'School', 'org-1');
    addEvent('i-e2', 'School', 'org-1');
    addVolunteer('iv-1');
    addVolunteer('iv-2');
    // iv-1 twice at the SAME event (two shifts); iv-2 at two different events.
    attend('iv-1', 'i-e1', 2);
    attend('iv-1', 'i-e1', 2, 1, addSlot('i-e1', 'b'));
    attend('iv-2', 'i-e1', 1);
    attend('iv-2', 'i-e2', 1);

    expect(buildImpact(db).volunteers.returningRate).toBe(50);
  });

  /**
   * The median sits beside the mean so a reader can tell a broad programme from
   * a narrow one with a star. One volunteer with 200 hours drags an average
   * nobody in the room would recognise.
   */
  it('reports a median alongside the average', () => {
    addEvent('i-e1', 'School', 'org-1');
    ['iv-1', 'iv-2', 'iv-3'].forEach(addVolunteer);
    attend('iv-1', 'i-e1', 1);
    attend('iv-2', 'i-e1', 2);
    attend('iv-3', 'i-e1', 60);

    const { volunteers } = buildImpact(db);
    expect(volunteers.averageHours).toBe(21);
    expect(volunteers.medianHours).toBe(2);
  });

  /** Zero is a claim — "nobody came back". An empty programme has not made it. */
  it('is null rather than zero when there is nobody to average', () => {
    const { volunteers } = buildImpact(db);
    expect(volunteers.averageHours).toBeNull();
    expect(volunteers.returningRate).toBeNull();
  });
});

describe('the privacy threshold', () => {
  const fill = (n, eventId) => {
    for (let i = 1; i <= n; i += 1) {
      addVolunteer(`iv-${eventId}-${i}`);
      attend(`iv-${eventId}-${i}`, eventId, 1);
    }
  };

  /**
   * The assertion this whole module is shaped around.
   *
   * A category with two volunteers is two identifiable students, and "who did
   * the Healthcare shifts" is answerable by anybody at a small school.
   */
  it('suppresses a category smaller than the threshold', () => {
    addEvent('i-big', 'Food Pantry', 'org-1');
    addEvent('i-small', 'Fundraiser', 'org-2');
    fill(MIN_BUCKET, 'i-big');
    fill(MIN_BUCKET - 1, 'i-small');

    const { categories } = buildImpact(db);
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
  it('still lists a suppressed bucket, so nothing looks like it never happened', () => {
    addEvent('i-small', 'Fundraiser', 'org-1');
    fill(2, 'i-small');

    const { categories } = buildImpact(db);
    expect(categories.map(c => c.label)).toContain('Fundraiser');
    expect(categories[0].count).toBeNull();
  });

  it('suppresses a thin month the same way', () => {
    addEvent('i-e1', 'School', 'org-1');
    fill(2, 'i-e1');

    const { growth } = buildImpact(db);
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
  it('never suppresses the platform-wide totals', () => {
    addEvent('i-e1', 'School', 'org-1');
    fill(1, 'i-e1');

    const { community } = buildImpact(db);
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
  it('leaks no identifier anywhere in the payload', () => {
    addEvent('i-e1', 'School', 'org-1', '221B Baker Street');
    addVolunteer('iv-1');
    attend('iv-1', 'i-e1', 4);

    const json = JSON.stringify(buildImpact(db));
    expect(json).not.toContain('iv-1');
    expect(json).not.toContain('Volunteer iv-1');
    expect(json).not.toContain('@example.invalid');
    expect(json).not.toContain('org-1');
    expect(json).not.toContain('221B Baker Street');
    expect(json).not.toContain('i-e1');
  });

  /** Geography is a count and nothing else until there is a real region model. */
  it('publishes a count of places and never the places themselves', () => {
    addEvent('i-e1', 'School', 'org-1', 'Lincoln High School');
    addEvent('i-e2', 'School', 'org-1', 'Riverside Park');
    addVolunteer('iv-1');
    attend('iv-1', 'i-e1', 1);
    attend('iv-1', 'i-e2', 1);

    const { geography } = buildImpact(db);
    expect(geography.distinctLocations).toBe(2);
    expect(geography.breakdown).toEqual([]);
    expect(JSON.stringify(geography)).not.toContain('Lincoln');
  });
});

describe('shape', () => {
  /** Sections are always present, so a client never distinguishes missing from none. */
  it('returns every section even with no data at all', () => {
    const out = buildImpact(db);
    expect(Object.keys(out).sort()).toEqual(
      ['categories', 'community', 'generatedAt', 'geography', 'growth', 'minBucket', 'volunteers']
    );
    expect(out.growth).toEqual([]);
    expect(out.categories).toEqual([]);
  });

  /** The client renders the threshold in its own footnote; it should not hardcode it. */
  it('tells the client what the threshold is', () => {
    expect(buildImpact(db).minBucket).toBe(MIN_BUCKET);
  });
});
