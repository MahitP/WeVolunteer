import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { setDefaultConnection, createConnectionProxy } from './db/connectionContext.js';
import { computeDraw, recordRun, applyRun, latestRun } from './services/autoSelect.js';
import {
  verifyRunStillApplies, RUN_STALE, STALE_REASONS, staleRunMessage,
} from './services/autoSelectStaleness.js';

/**
 * Refusing a stale Auto Select run.
 *
 * Owner decision, 2026-08-16: confirmation applies the recorded selection
 * **exactly or not at all**. It does not truncate to fit, and it does not
 * over-allocate.
 *
 * Two layers are tested. The verdict function is pure and gets the edge cases;
 * `applyRun` gets the thing that actually matters, which is that a refusal
 * leaves the database completely untouched.
 */

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, grade TEXT NOT NULL, role TEXT NOT NULL,
    created_at TEXT NOT NULL, email_opt_out INTEGER DEFAULT 0,
    email_verified INTEGER DEFAULT 1
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, organizer_id TEXT NOT NULL,
    application_deadline TEXT, status TEXT DEFAULT 'open',
    selection_summary TEXT, auto_approve INTEGER DEFAULT 0
  );
  CREATE TABLE notification_preferences (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, category TEXT NOT NULL,
    channel TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE slots (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT, max_spots INTEGER NOT NULL,
    start_datetime TEXT, end_datetime TEXT
  );
  CREATE TABLE applications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL,
    slot_id TEXT NOT NULL, status TEXT DEFAULT 'pending', applied_at TEXT NOT NULL,
    waitlist_order INTEGER, UNIQUE(user_id, slot_id)
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
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT, priority TEXT,
    title TEXT, body TEXT, link TEXT, read INTEGER DEFAULT 0,
    created_at TEXT NOT NULL, dedupe_key TEXT
  );
`;

describe('the stale-run verdict (pure)', () => {
  const slotMap = (entries) => new Map(Object.entries(entries));

  it('allows a run whose selection still fits', () => {
    const v = verifyRunStillApplies({
      selections: [{ id: 'a1', slotId: 's1', status: 'pending' }],
      slots: slotMap({ s1: { maxSpots: 2, acceptedNow: 0 } }),
    });
    expect(v.ok).toBe(true);
  });

  it('allows a run that exactly fills the remaining capacity', () => {
    const v = verifyRunStillApplies({
      selections: [
        { id: 'a1', slotId: 's1', status: 'pending' },
        { id: 'a2', slotId: 's1', status: 'pending' },
      ],
      slots: slotMap({ s1: { maxSpots: 3, acceptedNow: 1 } }),
    });
    expect(v.ok).toBe(true);
  });

  it('refuses when a spot was consumed after the draw', async () => {
    const v = verifyRunStillApplies({
      selections: [
        { id: 'a1', slotId: 's1', status: 'pending' },
        { id: 'a2', slotId: 's1', status: 'pending' },
      ],
      slots: slotMap({ s1: { maxSpots: 2, acceptedNow: 1 } }),
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe(RUN_STALE);
    expect(v.reason).toBe(STALE_REASONS.CAPACITY_CONSUMED);
    expect(v.detail).toMatchObject({ slotId: 's1', maxSpots: 2, acceptedNow: 1, selected: 2, overBy: 1 });
  });

  /**
   * Capacity is not the only way a run goes stale. A withdrawn applicant must
   * never be resurrected into `accepted` by a run that happens to still fit —
   * which is why availability is checked first and reported distinctly.
   */
  it('refuses when a selected applicant has withdrawn, even though capacity fits', async () => {
    const v = verifyRunStillApplies({
      selections: [{ id: 'a1', slotId: 's1', status: 'withdrawn' }],
      slots: slotMap({ s1: { maxSpots: 5, acceptedNow: 0 } }),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(STALE_REASONS.APPLICANT_UNAVAILABLE);
    expect(v.detail).toMatchObject({ applicationId: 'a1', currentStatus: 'withdrawn' });
  });

  it('refuses when a selected applicant was already accepted by hand', async () => {
    const v = verifyRunStillApplies({
      selections: [{ id: 'a1', slotId: 's1', status: 'accepted' }],
      slots: slotMap({ s1: { maxSpots: 5, acceptedNow: 1 } }),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(STALE_REASONS.APPLICANT_UNAVAILABLE);
  });

  it('refuses when a selected application no longer exists at all', async () => {
    const v = verifyRunStillApplies({
      selections: [{ id: 'gone', slotId: null, status: null }],
      slots: slotMap({}),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(STALE_REASONS.APPLICANT_UNAVAILABLE);
    expect(v.detail.currentStatus, 'null distinguishes "gone" from "withdrawn"').toBeNull();
  });

  it('refuses when the slot itself has disappeared', async () => {
    const v = verifyRunStillApplies({
      selections: [{ id: 'a1', slotId: 's-gone', status: 'pending' }],
      slots: slotMap({}),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(STALE_REASONS.SLOT_MISSING);
  });

  it('checks each slot independently', () => {
    const v = verifyRunStillApplies({
      selections: [
        { id: 'a1', slotId: 's1', status: 'pending' },
        { id: 'a2', slotId: 's2', status: 'pending' },
      ],
      slots: slotMap({ s1: { maxSpots: 5, acceptedNow: 0 }, s2: { maxSpots: 1, acceptedNow: 1 } }),
    });
    expect(v.ok).toBe(false);
    expect(v.detail.slotId, 'the full slot is the one reported').toBe('s2');
  });

  /**
   * A draw that waitlisted everybody selects nobody, and confirming it is still
   * a real action: it moves those applicants into `waitlisted` with their queue
   * positions. Treating an empty selection as stale would make such a run
   * permanently unconfirmable.
   */
  it('allows an empty selection — a waitlist-only draw is honourable', () => {
    expect(verifyRunStillApplies({ selections: [], slots: new Map() }).ok).toBe(true);
  });

  it('gives a specific message per reason', async () => {
    expect(staleRunMessage({ reason: STALE_REASONS.CAPACITY_CONSUMED })).toMatch(/Spots were filled/);
    expect(staleRunMessage({ reason: STALE_REASONS.APPLICANT_UNAVAILABLE })).toMatch(/no longer available/);
    expect(staleRunMessage({ reason: STALE_REASONS.SLOT_MISSING })).toMatch(/no longer exists/);
    expect(staleRunMessage({ reason: 'something-new' }), 'unknown reasons still read sensibly')
      .toMatch(/out of date/);
  });
});

describe('applyRun refuses a stale run and changes nothing (SQLite)', () => {
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
    conn.prepare(`INSERT INTO slots (id,event_id,name,max_spots,start_datetime,end_datetime)
      VALUES ('s1','e1','Shift',2,'2099-01-01T10:00:00.000Z','2099-01-01T12:00:00.000Z')`).run();
  });

  afterEach(() => { conn.close(); setDefaultConnection(null); });

  const addApplicant = (uid) => {
    conn.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
      VALUES (?,?,?,'h','11','student','2026-01-01T00:00:00.000Z')`).run(uid, uid, `${uid}@x.test`);
    conn.prepare(`INSERT INTO applications (id,user_id,event_id,slot_id,status,applied_at)
      VALUES (?,?,'e1','s1','pending','2026-01-01T00:00:00.000Z')`).run(`app-${uid}`, uid);
    return `app-${uid}`;
  };

  const statuses = () => Object.fromEntries(
    conn.prepare('SELECT id, status FROM applications ORDER BY id').all().map(r => [r.id, r.status])
  );
  const accepted = () => conn.prepare(
    "SELECT COUNT(*) AS c FROM applications WHERE slot_id='s1' AND status='accepted'"
  ).get().c;

  const drawAndRecord = async () => {
    const draw = await computeDraw(db, 'e1', { runNumber: 1 });
    await recordRun(db, 'e1', draw, { runNumber: 1, reason: 'test' });
    return { draw, run: await latestRun(db, 'e1') };
  };

  it('applies a run that is still valid', async () => {
    addApplicant('u1'); addApplicant('u2');
    const { draw, run } = await drawAndRecord();
    expect(draw.selectedIds, 'fixture: two spots, two applicants').toHaveLength(2);

    await applyRun(db, 'e1', run);

    expect(accepted()).toBe(2);
    expect(conn.prepare('SELECT is_confirmed FROM auto_select_runs WHERE id = ?').get(run.id).is_confirmed)
      .toBe(1);
  });

  /**
   * The case the whole decision is about, and the assertion that matters is the
   * second one: **nothing moved**.
   */
  it('refuses when a spot was taken between the draw and the confirmation', async () => {
    addApplicant('u1'); addApplicant('u2'); addApplicant('u3');
    const { draw, run } = await drawAndRecord();
    expect(draw.selectedIds).toHaveLength(2);

    /* Accept somebody the draw did NOT select. Picking a name by hand would be
       a coin flip on which two of the three the weighted draw chose, and if it
       happened to be a selected one the refusal would fire for
       `applicant_unavailable` instead — a correct refusal for the wrong reason,
       which would make this test pass without exercising the capacity rule. */
    const notSelected = draw.waitlistIds[0];
    expect(notSelected, 'fixture: exactly one applicant was left off the draw').toBeDefined();
    conn.prepare("UPDATE applications SET status='accepted' WHERE id = ?").run(notSelected);
    const before = statuses();
    expect(accepted(), 'fixture: one spot now consumed').toBe(1);

    let thrown;
    try { await applyRun(db, 'e1', run); } catch (e) { thrown = e; }

    expect(thrown, 'the run must be refused').toBeDefined();
    expect(thrown.code).toBe(RUN_STALE);
    expect(thrown.reason).toBe(STALE_REASONS.CAPACITY_CONSUMED);

    expect(statuses(), 'NOT ONE application may have changed').toEqual(before);
    expect(accepted(), 'and certainly not more than max_spots').toBe(1);
    expect(
      conn.prepare('SELECT is_confirmed FROM auto_select_runs WHERE id = ?').get(run.id).is_confirmed,
      'the run stays unconfirmed — that is how "stale" is represented',
    ).toBe(0);
  });

  it('refuses when a selected applicant withdrew, and leaves everything alone', async () => {
    addApplicant('u1'); addApplicant('u2');
    const { draw, run } = await drawAndRecord();
    expect(draw.selectedIds).toHaveLength(2);

    conn.prepare("UPDATE applications SET status='withdrawn' WHERE id = ?").run(draw.selectedIds[0]);
    const before = statuses();

    let thrown;
    try { await applyRun(db, 'e1', run); } catch (e) { thrown = e; }

    expect(thrown?.reason).toBe(STALE_REASONS.APPLICANT_UNAVAILABLE);
    expect(statuses()).toEqual(before);
    expect(accepted()).toBe(0);
  });

  /**
   * The refusal must not become a blanket "never confirm anything". A run drawn
   * against the current state still applies, which is what makes "draw again"
   * a real remedy rather than a dead end.
   */
  it('a fresh draw after the change applies normally', async () => {
    addApplicant('u1'); addApplicant('u2'); addApplicant('u3');
    const first = await drawAndRecord();
    const notSelected = first.draw.waitlistIds[0];
    expect(notSelected, 'fixture: one applicant was left off the draw').toBeDefined();
    conn.prepare("UPDATE applications SET status='accepted' WHERE id = ?").run(notSelected);
    await expect(applyRun(db, 'e1', first.run)).rejects.toThrow();

    // Draw again against the world as it now is.
    const draw2 = await computeDraw(db, 'e1', { runNumber: 2 });
    await recordRun(db, 'e1', draw2, { runNumber: 2, reason: 'redraw' });
    const run2 = await latestRun(db, 'e1');
    expect(draw2.selectedIds, 'one spot remains').toHaveLength(1);

    await applyRun(db, 'e1', run2);

    expect(accepted(), 'exactly at capacity, never over').toBe(2);
  });

  it('still applies a waitlist-only run, which selects nobody', async () => {
    addApplicant('u1'); addApplicant('u2'); addApplicant('u3');
    conn.prepare("UPDATE applications SET status='accepted' WHERE id IN ('app-u1','app-u2')").run();
    const { draw, run } = await drawAndRecord();
    expect(draw.selectedIds, 'slot is full, so nobody is selected').toHaveLength(0);
    expect(draw.waitlistIds.length).toBeGreaterThan(0);

    await applyRun(db, 'e1', run);

    expect(conn.prepare("SELECT status FROM applications WHERE id='app-u3'").get().status)
      .toBe('waitlisted');
    expect(accepted()).toBe(2);
  });

  /**
   * Mutation check: with the refusal removed, this workload over-allocates.
   * Asserted here so the tests above cannot be passing for some other reason —
   * the same role the negative control plays in the PostgreSQL suite.
   */
  it('NEGATIVE CONTROL: the same sequence over-allocates when the check is bypassed', async () => {
    addApplicant('u1'); addApplicant('u2'); addApplicant('u3');
    const { draw } = await drawAndRecord();
    const notSelected = draw.waitlistIds[0];
    expect(notSelected, 'fixture: one applicant was left off the draw').toBeDefined();
    conn.prepare("UPDATE applications SET status='accepted' WHERE id = ?").run(notSelected);

    /* Exactly what applyRun did before the refusal: apply the recorded ids. */
    for (const id of draw.selectedIds) {
      conn.prepare("UPDATE applications SET status='accepted' WHERE id = ?").run(id);
    }

    expect(
      accepted(),
      'without the check the slot goes to 3 against max_spots = 2 — this is what the refusal prevents',
    ).toBe(3);
  });
});
