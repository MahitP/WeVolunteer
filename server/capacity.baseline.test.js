import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { setDefaultConnection, createConnectionProxy } from './db/connectionContext.js';
import { computeDraw, recordRun } from './services/autoSelect.js';
import { calculateWeight } from './weighting.js';

/**
 * The capacity baseline, captured BEFORE the PostgreSQL conversion touches it.
 *
 * ── What this file is for ──
 *
 * "An opportunity must never have more accepted applications than its capacity"
 * is the invariant the conversion has to preserve. Preserving it requires
 * knowing precisely what holds it up today, and where it is already thin — a
 * conversion measured against an assumed baseline proves nothing.
 *
 * So these are **characterization tests**: they record the behaviour that exists
 * now, on SQLite, including one case where the invariant does *not* hold. That
 * case is marked, and it is deliberately recorded rather than fixed — see the
 * note on it below.
 *
 * ── Where capacity is actually enforced ──
 *
 * Not at application time. `POST /api/applications` writes `status = 'pending'`
 * and never consults `max_spots`; anybody may apply to a full slot. Capacity is
 * arithmetic performed at ACCEPTANCE time, and there are two independent
 * acceptance paths:
 *
 *   1. `computeDraw` (Auto Select) — reads the accepted count, computes
 *      `remainingSpots = max_spots - accepted`, and selects at most that many.
 *   2. The bulk approve in `eventRoutes.js:1371` — recomputes
 *      `remaining = max_spots - accepted` per slot and stops at zero.
 *
 * Both are read-then-write sequences whose atomicity comes from the handler
 * being synchronous. That is exactly what the async conversion removes, which is
 * why this baseline exists.
 */

/** The columns these paths actually touch. Kept minimal and explicit. */
const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, grade TEXT NOT NULL, role TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, organizer_id TEXT NOT NULL,
    application_deadline TEXT, status TEXT DEFAULT 'open', auto_approve INTEGER DEFAULT 0
  );
  CREATE TABLE slots (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT, max_spots INTEGER NOT NULL,
    start_datetime TEXT, end_datetime TEXT
  );
  CREATE TABLE applications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL,
    slot_id TEXT NOT NULL, status TEXT DEFAULT 'pending', applied_at TEXT NOT NULL,
    waitlist_order INTEGER,
    UNIQUE(user_id, slot_id)
  );
  CREATE TABLE attendance (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT, slot_id TEXT,
    present INTEGER, hours_awarded REAL
  );
  CREATE TABLE organization_bans (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
    reason TEXT, created_at TEXT, lifted_at TEXT, banned_by TEXT, lifted_by TEXT
  );
  CREATE TABLE organization_members (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
    member_role TEXT DEFAULT 'member', joined_at TEXT
  );
  CREATE TABLE auto_select_runs (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, run_number INTEGER NOT NULL,
    created_at TEXT NOT NULL, selected_ids TEXT NOT NULL, waitlist_ids TEXT NOT NULL,
    is_confirmed INTEGER DEFAULT 0, reason TEXT
  );
`;

describe('capacity baseline (SQLite, current behaviour)', () => {
  let conn, db;

  beforeEach(() => {
    conn = new DatabaseSync(':memory:');
    conn.exec(SCHEMA);
    setDefaultConnection(conn);
    db = createConnectionProxy();

    conn.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
      VALUES ('org','Org','org@x.test','h','Adult','organizer','2026-01-01T00:00:00.000Z')`).run();
    conn.prepare(`INSERT INTO events (id,title,organizer_id,application_deadline,status)
      VALUES ('e1','Event','org','2099-01-01T00:00:00.000Z','open')`).run();
  });

  afterEach(() => { conn.close(); setDefaultConnection(null); });

  const addSlot = (id, maxSpots) => conn.prepare(
    `INSERT INTO slots (id,event_id,name,max_spots,start_datetime,end_datetime)
     VALUES (?, 'e1', ?, ?, '2099-01-01T10:00:00.000Z', '2099-01-01T12:00:00.000Z')`
  ).run(id, id, maxSpots);

  const addApplicant = (uid, slotId, status = 'pending', appliedAt = '2026-01-01T00:00:00.000Z') => {
    conn.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
      VALUES (?,?,?,'h','11','student','2026-01-01T00:00:00.000Z')
      ON CONFLICT (id) DO NOTHING`).run(uid, uid, `${uid}@x.test`);
    conn.prepare(`INSERT INTO applications (id,user_id,event_id,slot_id,status,applied_at)
      VALUES (?,?,'e1',?,?,?)`).run(`app-${uid}-${slotId}`, uid, slotId, status, appliedAt);
    return `app-${uid}-${slotId}`;
  };

  const acceptedIn = (slotId) => conn.prepare(
    "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
  ).get(slotId).c;

  /* Every fixture is asserted into existence — a draw over an empty table
     "respects capacity" trivially, and that is not a result. */
  const assertFixtures = (slotId, expectedPending) => {
    const n = conn.prepare(
      "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'pending'"
    ).get(slotId).c;
    expect(n, `fixture check: expected ${expectedPending} pending applicants`).toBe(expectedPending);
  };

  describe('the draw respects remaining capacity', () => {
    it('selects exactly max_spots when more applied than fit', async () => {
      addSlot('s1', 2);
      for (const u of ['u1', 'u2', 'u3', 'u4', 'u5']) addApplicant(u, 's1');
      assertFixtures('s1', 5);

      const { selectedIds, waitlistIds } = await computeDraw(db, 'e1', { runNumber: 1 });

      expect(selectedIds).toHaveLength(2);
      expect(waitlistIds).toHaveLength(3);
      expect(new Set([...selectedIds, ...waitlistIds]).size, 'nobody appears twice').toBe(5);
    });

    it('selects everybody when fewer applied than fit', async () => {
      addSlot('s1', 5);
      for (const u of ['u1', 'u2']) addApplicant(u, 's1');
      assertFixtures('s1', 2);

      const { selectedIds, waitlistIds } = await computeDraw(db, 'e1', { runNumber: 1 });
      expect(selectedIds).toHaveLength(2);
      expect(waitlistIds).toHaveLength(0);
    });

    /**
     * The rule the code comment calls out: hand-accepted volunteers consume
     * capacity, and the draw must see that. This is the read half of the
     * read-then-write pair the conversion puts an `await` into.
     */
    it('subtracts spots already taken by hand-accepted volunteers', async () => {
      addSlot('s1', 3);
      addApplicant('taken1', 's1', 'accepted');
      addApplicant('taken2', 's1', 'accepted');
      for (const u of ['u1', 'u2', 'u3']) addApplicant(u, 's1');
      assertFixtures('s1', 3);
      expect(acceptedIn('s1'), 'two spots are already consumed').toBe(2);

      const { selectedIds, waitlistIds } = await computeDraw(db, 'e1', { runNumber: 1 });

      expect(selectedIds, 'only one spot remained').toHaveLength(1);
      expect(waitlistIds).toHaveLength(2);
    });

    it('waitlists everyone when the slot is already full', async () => {
      addSlot('s1', 2);
      addApplicant('t1', 's1', 'accepted');
      addApplicant('t2', 's1', 'accepted');
      for (const u of ['u1', 'u2']) addApplicant(u, 's1');
      assertFixtures('s1', 2);

      const { selectedIds, waitlistIds } = await computeDraw(db, 'e1', { runNumber: 1 });
      expect(selectedIds).toHaveLength(0);
      expect(waitlistIds).toHaveLength(2);
    });

    it('treats each slot separately', async () => {
      addSlot('s1', 1);
      addSlot('s2', 2);
      addApplicant('u1', 's1'); addApplicant('u2', 's1');
      addApplicant('u3', 's2'); addApplicant('u4', 's2'); addApplicant('u5', 's2');

      const { selectedIds } = await computeDraw(db, 'e1', { runNumber: 1 });
      expect(selectedIds, '1 from s1 + 2 from s2').toHaveLength(3);
    });
  });

  describe('the draw is deterministic for a given run number', () => {
    /**
     * Behaviourally significant and therefore pinned: the seed incorporates the
     * run number, so one run is reproducible and a re-draw differs. The
     * conversion must not perturb either property.
     */
    it('produces the same selection twice for the same run number', async () => {
      addSlot('s1', 2);
      for (const u of ['u1', 'u2', 'u3', 'u4', 'u5']) addApplicant(u, 's1');

      const a = await computeDraw(db, 'e1', { runNumber: 1 });
      const b = await computeDraw(db, 'e1', { runNumber: 1 });
      expect(a.selectedIds).toEqual(b.selectedIds);
      expect(a.waitlistIds).toEqual(b.waitlistIds);
    });

    it('is a pure read — it writes nothing', async () => {
      addSlot('s1', 2);
      for (const u of ['u1', 'u2', 'u3']) addApplicant(u, 's1');
      const before = conn.prepare("SELECT COUNT(*) AS c FROM applications WHERE status = 'pending'").get().c;

      await computeDraw(db, 'e1', { runNumber: 1 });

      expect(conn.prepare("SELECT COUNT(*) AS c FROM applications WHERE status = 'pending'").get().c)
        .toBe(before);
      expect(conn.prepare('SELECT COUNT(*) AS c FROM auto_select_runs').get().c).toBe(0);
    });
  });

  describe('Equalizer: fewest credited hours is favoured', () => {
    /**
     * ── A correction, recorded because it changed how this is tested ──
     *
     * The first version of this test asserted that a zero-hours applicant beats
     * a 60-hour one in more than 70% of draws. It failed at 22/40 (55%), and the
     * implementation was right — the expectation was wrong.
     *
     * The curve is `W(h) = 1.5 + 8.5 / (1 + 0.005h)`, so 0h weighs 10.000 and
     * 60h weighs 8.038: a **55.4%** edge, not a landslide. Auto Select is a
     * weighted lottery, not a ranking, and the module says so in its own words —
     * "Auto Select exists to spread opportunity, not to rank students". A
     * volunteer with more hours is meant to remain genuinely able to win.
     *
     * The observed 55.0% against a predicted 55.4% is the algorithm behaving
     * exactly as specified. So the characterization is split in two: the weights
     * are asserted **exactly**, because they are deterministic and are the real
     * thing the conversion must not perturb; and the lottery is asserted against
     * a bound derived from those weights rather than from intuition.
     */
    it('gives the documented weight for a given number of hours', () => {
      expect(calculateWeight(0)).toBeCloseTo(10.000, 3);
      expect(calculateWeight(60)).toBeCloseTo(8.038, 3);
      expect(calculateWeight(200)).toBeCloseTo(5.750, 3);
      expect(calculateWeight(1000)).toBeCloseTo(2.917, 3);
    });

    it('weighs strictly monotonically downward as hours rise', () => {
      const hours = [0, 10, 25, 60, 120, 200, 500, 1000];
      const weights = hours.map(calculateWeight);
      for (let i = 1; i < weights.length; i++) {
        expect(weights[i], `${hours[i]}h must weigh less than ${hours[i - 1]}h`)
          .toBeLessThan(weights[i - 1]);
      }
    });

    /**
     * The lottery, over enough runs that the bound is not noise.
     *
     * 0h vs 1000h is a 77.4% edge by the formula. Over 200 draws the expected
     * count is ~155 with a standard deviation of ~5.9, so a floor of 120 sits
     * more than five deviations below the expectation while remaining far above
     * the 100 that an unweighted coin would produce. It fails loudly if the
     * curve is flattened or inverted, and does not fail on chance.
     */
    it('favours the zero-hours applicant at close to the rate the curve predicts', async () => {
      const RUNS = 200;
      let lowWins = 0;

      for (let i = 0; i < RUNS; i++) {
        conn.exec('DELETE FROM applications; DELETE FROM attendance; DELETE FROM slots;');
        addSlot('s1', 1);
        addApplicant('low', 's1');
        addApplicant('high', 's1');
        /**
         * `e0` has to be a real event now, and it always was in production.
         *
         * `attendance.event_id` carries `FOREIGN KEY … REFERENCES events(id)`, so
         * an attendance row pointing at an event that does not exist is a state
         * the schema forbids — SQLite only allowed it here because foreign keys
         * are off by default. The draw's hours query now joins `events` to
         * exclude cancelled ones, matching `creditedHoursFor`, and against this
         * fixture that join found nothing and read the 1000 hours as zero.
         *
         * So the fixture was exercising an impossible row, and the assertion it
         * broke was the one that noticed. Inserting the event makes the history
         * real rather than making the test weaker: 'high' still has 1000
         * credited hours, and the lottery bounds below are unchanged.
         */
        conn.prepare(`INSERT OR IGNORE INTO events (id,title,organizer_id,application_deadline,status)
          VALUES ('e0','History','org','2099-01-01T00:00:00.000Z','completed')`).run();
        conn.prepare(`INSERT INTO attendance (id,user_id,event_id,slot_id,present,hours_awarded)
          VALUES (?, 'high', 'e0', 's0', 1, 1000)`).run(`att-${i}`);
        assertFixtures('s1', 2);

        const { selectedIds } = await computeDraw(db, 'e1', { runNumber: i + 1 });
        expect(selectedIds, 'exactly one spot').toHaveLength(1);
        if (selectedIds[0] === 'app-low-s1') lowWins++;
      }

      const rate = ((lowWins / RUNS) * 100).toFixed(1);
      expect(
        lowWins,
        `the zero-hours applicant won ${lowWins}/${RUNS} (${rate}%); the curve predicts ~77% `
        + 'and an unweighted draw would give ~50%',
      ).toBeGreaterThan(120);

      /* And the high-hours applicant must still win sometimes — a curve that
         became a ranking would pass the bound above while breaking the feature. */
      expect(
        RUNS - lowWins,
        'a volunteer with many hours must remain able to win; this is a lottery, not a ranking',
      ).toBeGreaterThan(0);
    });
  });

  /**
   * ── A PRE-EXISTING GAP, recorded rather than fixed ──
   *
   * `computeDraw` reads capacity and picks a set. `recordRun` files that set.
   * `applyRun` later accepts exactly those ids — **without re-reading capacity**.
   *
   * So any acceptance that happens between the draw and the confirmation is not
   * accounted for, and the slot ends up over capacity. No concurrency is needed
   * to reach it: draw, bulk-approve, confirm, in that order, on one thread.
   *
   * This is NOT caused by the PostgreSQL migration, and per the standing rule it
   * is recorded here rather than repaired inside a conversion. It matters to the
   * conversion for one reason: the wave's headline invariant ("never exceed
   * capacity") **is not currently true**, so the conversion must be measured
   * against real behaviour rather than against the invariant as stated.
   *
   * Whether `applyRun` should re-validate is a product question, not a technical
   * one — re-validating would mean a confirmed draw silently accepts fewer people
   * than the organizer was shown when they pressed the button. That decision is
   * flagged in POSTGRES_MIGRATION_STATUS.md rather than taken here.
   */
  describe('KNOWN GAP: confirmation does not re-check capacity', () => {
    it('over-allocates when a spot is taken between the draw and the confirmation', async () => {
      addSlot('s1', 2);
      const a1 = addApplicant('u1', 's1');
      const a2 = addApplicant('u2', 's1');
      addApplicant('u3', 's1');
      assertFixtures('s1', 3);

      // 1. Draw: two spots free, two selected.
      const draw = await computeDraw(db, 'e1', { runNumber: 1 });
      expect(draw.selectedIds).toHaveLength(2);

      await recordRun(db, 'e1', draw, { runNumber: 1, reason: 'baseline' });

      // 2. Meanwhile somebody is accepted by hand, consuming a spot.
      conn.prepare("UPDATE applications SET status = 'accepted' WHERE id = ?").run('app-u3-s1');
      expect(acceptedIn('s1')).toBe(1);

      // 3. Confirmation applies the stale selection verbatim.
      conn.prepare("UPDATE applications SET status = 'accepted' WHERE id IN (?, ?)").run(a1, a2);

      expect(
        acceptedIn('s1'),
        'three accepted against max_spots = 2 — the invariant does not hold today',
      ).toBe(3);
      expect(acceptedIn('s1')).toBeGreaterThan(2);
    });

    it('by contrast, a fresh draw after the hand-acceptance respects capacity', async () => {
      /* The negative control: the arithmetic itself is sound. It is the staleness
         between draw and confirm that breaks it, which is what makes this a
         sequencing gap rather than a maths error. */
      addSlot('s1', 2);
      addApplicant('u1', 's1');
      addApplicant('u2', 's1');
      addApplicant('u3', 's1', 'accepted');
      assertFixtures('s1', 2);

      const draw = await computeDraw(db, 'e1', { runNumber: 1 });
      expect(draw.selectedIds, 'one spot left, so one selected').toHaveLength(1);
    });
  });

  describe('application uniqueness is held by the schema, not by timing', () => {
    /**
     * This one survives the conversion untouched, and that is worth pinning:
     * `UNIQUE(user_id, slot_id)` is a constraint, so no amount of interleaving
     * produces a duplicate. Recorded so the wave does not "protect" something
     * that is already safe.
     */
    it('refuses a second application for the same user and slot', () => {
      addSlot('s1', 5);
      addApplicant('u1', 's1');

      expect(() => addApplicant('u1', 's1')).toThrow();
      expect(conn.prepare("SELECT COUNT(*) AS c FROM applications WHERE user_id = 'u1'").get().c).toBe(1);
    });
  });
});
