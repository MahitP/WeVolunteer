import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A profile that holds everything the platform can award.
 *
 * ── Why this exists ──
 *
 * The badge catalogue has 23 active entries across four categories and the
 * milestone ladder has 7 tiers, and until the QA fixture existed no account had
 * ever held more than a handful. Nobody had seen what the ordering rules do when
 * they have something to order, whether twelve hour badges wrap sanely at 320px,
 * or whether the "and N more" line counts correctly.
 *
 * These tests pin the two properties that make such an account meaningful:
 * the collection really is COMPLETE, and it is complete because the history
 * supports it rather than because rows were inserted.
 *
 * ── Why the history matters ──
 *
 * `evaluateBadges` WITHDRAWS any automatic award whose criteria no longer hold
 * (`badgeService.js` deletes rows where `awarded_by IS NULL`). So a profile
 * populated by inserting `user_badges` directly would look right until the next
 * attendance change and then silently shed most of its badges. Deriving the
 * badges from real attendance is what makes them stable — and is what the
 * instruction "do not merely insert fake UI badges" is protecting.
 */

describe('an account can hold the complete collection', () => {
  let srv;
  let db;
  let badgeService;
  let milestones;
  let subjectId;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    ({ badgeService } = await import('./services/badgeService.js'));
    milestones = await import('./milestones.js');

    subjectId = db.prepare(
      "SELECT id FROM users WHERE role = 'student' AND account_status = 'active' AND email NOT LIKE '%invalid%' LIMIT 1"
    ).get()?.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('has a subject and a non-trivial catalogue to be complete against', () => {
    /* The vacuity guard. "Holds every badge" is trivially true of an empty
       catalogue, and every assertion below would pass against one. */
    expect(subjectId, 'no student to build the fixture on').toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) n FROM badges WHERE active = 1').get().n)
      .toBeGreaterThanOrEqual(20);
  });

  /**
   * The same history `bin/seed-qa-profile.mjs` builds, in miniature: enough
   * credited hours and enough consecutive months to clear the top tier of both
   * progressions, plus hosted events for the leadership pair.
   */
  const buildHistory = () => {
    const now = Date.now();
    const MONTH = 30 * 86400000;
    const tmplEvent = db.prepare('SELECT * FROM events LIMIT 1').get();
    const tmplSlot = db.prepare('SELECT * FROM slots LIMIT 1').get();
    const tmplApp = db.prepare('SELECT * FROM applications LIMIT 1').get();
    if (!tmplEvent || !tmplSlot || !tmplApp) return false;

    const cloneInto = (table, template, overrides) => {
      const row = { ...template, ...overrides };
      const cols = Object.keys(row);
      db.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      ).run(...cols.map(c => row[c]));
    };

    for (let i = 0; i < 26; i += 1) {
      const at = new Date(now - i * MONTH).toISOString();
      const ev = `own-ev-${i}`; const sl = `own-sl-${i}`; const ap = `own-ap-${i}`;
      /* 'open', not 'active' — the events CHECK constraint is
         ('open','closed','completed','cancelled'), and 'active' fails it. */
      cloneInto('events', tmplEvent, { id: ev, title: `Owner fixture ${i}`, status: 'open', organizer_id: subjectId });
      cloneInto('slots', tmplSlot, { id: sl, event_id: ev, start_datetime: at, end_datetime: at });
      cloneInto('applications', tmplApp, { id: ap, event_id: ev, slot_id: sl, user_id: subjectId, status: 'accepted' });
      /* `attendance` is exactly (event_id, slot_id, user_id, present,
         hours_awarded) — no id, no application id, no timestamp of its own.
         That last absence is why the slot's `end_datetime` above carries the
         backdating: the streak is derived from when the SHIFT was, which is the
         only honest source, since nothing here records when it was credited. */
      db.prepare(`INSERT OR REPLACE INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
                  VALUES (?, ?, ?, 1, 20)`)
        .run(ev, sl, subjectId);
    }
    /* Backdated so the early-adopter rank can qualify. */
    db.prepare('UPDATE users SET created_at = ? WHERE id = ?')
      .run(new Date(now - 400 * 86400000).toISOString(), subjectId);
    return true;
  };

  it('earns every ACTIVE badge from real service history, not inserted rows', () => {
    expect(buildHistory(), 'no template rows to build a history from').toBe(true);

    /* The real evaluator, the one attendance changes call. */
    badgeService.evaluateBadges(subjectId);

    const missing = db.prepare(`
      SELECT b.category, b.name FROM badges b
       WHERE b.active = 1
         AND b.id NOT IN (SELECT badge_id FROM user_badges WHERE user_id = ?)
       ORDER BY b.category, b.name
    `).all(subjectId);

    expect(
      missing.map(m => `${m.category}/${m.name}`),
      'the catalogue is not fully covered by this history',
    ).toEqual([]);
  });

  it('holds those badges through a re-evaluation, because the history earns them', () => {
    /**
     * The property that separates a real collection from a decorated one.
     * `evaluateBadges` deletes automatic awards whose criteria no longer hold,
     * so inserted rows would vanish here while derived ones survive.
     */
    const before = db.prepare('SELECT COUNT(*) n FROM user_badges WHERE user_id = ?').get(subjectId).n;
    badgeService.evaluateBadges(subjectId);
    const after = db.prepare('SELECT COUNT(*) n FROM user_badges WHERE user_id = ?').get(subjectId).n;

    expect(after, 'badges were withdrawn on re-evaluation — they were not really earned').toBe(before);
    expect(after).toBeGreaterThanOrEqual(20);
  });

  it('earns every milestone tier from the same history', () => {
    /**
     * Milestones are the other half of what the product calls achievements:
     * derived on every read from hours and distinct events, never stored. They
     * have to be coherent with the badges — a profile showing a 500-hour badge
     * beside an unearned 100-hour milestone would be visibly contradictory.
     */
    const hours = db.prepare(
      'SELECT COALESCE(SUM(hours_awarded), 0) h FROM attendance WHERE user_id = ? AND present = 1'
    ).get(subjectId).h;
    const events = db.prepare(
      'SELECT COUNT(DISTINCT event_id) n FROM attendance WHERE user_id = ? AND present = 1'
    ).get(subjectId).n;

    const built = milestones.buildMilestones(hours, events);
    expect(built.length).toBe(milestones.MILESTONE_TIERS.length);
    expect(built.filter(m => !m.earned).map(m => m.id), 'unearned milestone tiers').toEqual([]);
  });

  it('is coherent: the hours behind the top badge really are on the record', () => {
    /* Guards the case where a badge is granted by criteria the ledger does not
       actually support — the profile would show 500 Hours over 12 recorded. */
    const hours = db.prepare(
      'SELECT COALESCE(SUM(hours_awarded), 0) h FROM attendance WHERE user_id = ? AND present = 1'
    ).get(subjectId).h;
    const topTier = db.prepare(
      "SELECT MAX(criteria_value) v FROM badges b JOIN user_badges ub ON ub.badge_id = b.id WHERE ub.user_id = ? AND b.category = 'Service hours'"
    ).get(subjectId).v;

    expect(hours).toBeGreaterThanOrEqual(topTier);
  });
});
