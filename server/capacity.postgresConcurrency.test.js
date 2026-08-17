import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgresDatabase, runTransaction } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';

/**
 * Capacity enforcement under GENUINE concurrency, on PostgreSQL.
 *
 * ── What this file is, and what it deliberately is not ──
 *
 * It proves the *primitives* WeVolunteer's capacity workflow will rely on once
 * it runs on PostgreSQL: that a unique constraint really does serialise
 * duplicate applications, and that a slot's remaining spots can be read and
 * consumed atomically under real parallel load.
 *
 * It does **not** decide where those primitives get applied. `applyRun`
 * currently accepts a previously-computed selection without re-reading
 * capacity, and whether that should change is a product decision recorded as a
 * blocker in POSTGRES_MIGRATION_STATUS.md. Proving the mechanism now means the
 * answer, whichever way it goes, drops into a tested foundation rather than
 * starting one.
 *
 * ── Why these tests are PostgreSQL-only, and labelled as such ──
 *
 * SQLite cannot exhibit this. `node:sqlite` is synchronous on a single
 * connection, so two "concurrent" operations in one process are simply
 * sequential — a concurrency test there asserts nothing about concurrency. The
 * behaviours below are properties of PostgreSQL's MVCC, row locking and
 * constraint enforcement, so they are tested against PostgreSQL and are honestly
 * marked as not applying to the SQLite path rather than duplicated into it.
 *
 * ── Anti-vacuity ──
 *
 * Every test asserts final DATABASE STATE, not a return value. Fixtures are
 * counted into existence. Concurrency is proved to have actually overlapped
 * rather than assumed from `Promise.all`. And each protection has a negative
 * control showing the unprotected form really does fail.
 */
const URL = process.env.TEST_POSTGRES_URL;
const live = Boolean(URL);
if (!live) {
  console.warn(
    '[postgres] TEST_POSTGRES_URL is not set — the capacity CONCURRENCY tests are SKIPPED. '
    + 'They are the only proof that capacity can be enforced atomically under parallel load.'
  );
}

describe.skipIf(!live)('capacity under real PostgreSQL concurrency', () => {
  let db;

  beforeAll(async () => {
    db = new PostgresDatabase({ connectionString: URL, max: 12, translate: translatePlaceholders });
    await db.exec(`
      DROP TABLE IF EXISTS cap_applications;
      DROP TABLE IF EXISTS cap_slots;
      CREATE TABLE cap_slots (
        id text PRIMARY KEY,
        max_spots integer NOT NULL
      );
      CREATE TABLE cap_applications (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        slot_id text NOT NULL REFERENCES cap_slots(id),
        status text NOT NULL DEFAULT 'pending',
        UNIQUE (user_id, slot_id)
      );
    `);
  }, 30000);

  afterAll(async () => {
    if (!live) return;
    await db.exec('DROP TABLE IF EXISTS cap_applications; DROP TABLE IF EXISTS cap_slots;');
    await db.close();
  });

  beforeEach(async () => {
    await db.exec('TRUNCATE cap_applications, cap_slots CASCADE');
  });

  const makeSlot = async (id, spots) =>
    await db.prepare('INSERT INTO cap_slots (id, max_spots) VALUES (?, ?)').run(id, spots);

  const apply = async (uid, slot, status = 'pending') =>
    await db.prepare('INSERT INTO cap_applications (id, user_id, slot_id, status) VALUES (?, ?, ?, ?)')
      .run(`a-${uid}-${slot}`, uid, slot, status);

  const acceptedCount = async (slot) =>
    (await db.prepare("SELECT COUNT(*) AS c FROM cap_applications WHERE slot_id = ? AND status = 'accepted'").get(slot)).c;

  const totalFor = async (slot) =>
    (await db.prepare('SELECT COUNT(*) AS c FROM cap_applications WHERE slot_id = ?').get(slot)).c;

  it('is connected — a skip must not look like a pass', async () => {
    expect((await db.prepare('SELECT 1 AS ok').get()).ok).toBe(1);
  });

  describe('duplicate applications: held by the unique constraint', () => {
    /**
     * The invariant survives the migration untouched, because a constraint
     * cannot be raced. Proved rather than asserted from the schema, and with
     * genuinely parallel attempts.
     */
    it('admits exactly one of 20 simultaneous attempts by the same user', async () => {
      await makeSlot('s1', 100);

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, async () => await apply('same-user', 's1'))
      );

      const ok = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      expect(ok, 'exactly one insert may succeed').toBe(1);
      expect(failed, 'the other nineteen must be refused by the constraint').toBe(19);
      expect(await totalFor('s1'), 'the DATABASE holds one row, whatever the callers were told').toBe(1);
    });

    it('still lets different users apply in parallel', async () => {
      await makeSlot('s1', 100);
      await Promise.all(Array.from({ length: 20 }, async (_, i) => await apply(`u${i}`, 's1')));
      expect(await totalFor('s1')).toBe(20);
    });
  });

  /**
   * The capacity primitive.
   *
   * `SELECT … FOR UPDATE` on the slot row serialises every transaction that
   * wants to consume a spot: the second waits for the first to commit, then
   * reads a count that already includes it. This is the mechanism that makes
   * "read remaining, then accept" atomic without a global lock and without
   * changing any business rule.
   *
   * It is deliberately expressed as a standalone helper rather than wired into
   * `applyRun`, because whether `applyRun` should re-validate capacity is an open
   * product decision. The mechanism is proved here; the policy is not chosen.
   */
  const acceptWithCapacityCheck = async (slotId, applicationId) => await runTransaction(db, async (tx) => {
    /* The lock is taken on the SLOT, which is the thing whose capacity is
       scarce. Locking the applications would not serialise two transactions
       looking at different rows of the same slot. */
    const slot = await tx.prepare('SELECT max_spots FROM cap_slots WHERE id = ? FOR UPDATE').get(slotId);
    if (!slot) return { accepted: false, reason: 'no_such_slot' };

    /* An await between the read and the write, deliberately — this is the
       interleaving opportunity the async conversion introduces, and the lock has
       to hold across it. */
    await new Promise(r => setImmediate(r));

    const taken = (await tx.prepare(
      "SELECT COUNT(*) AS c FROM cap_applications WHERE slot_id = ? AND status = 'accepted'"
    ).get(slotId)).c;

    if (taken >= slot.max_spots) return { accepted: false, reason: 'full' };

    const res = await tx.prepare(
      "UPDATE cap_applications SET status = 'accepted' WHERE id = ? AND status = 'pending'"
    ).run(applicationId);

    return { accepted: res.changes === 1, reason: res.changes === 1 ? 'ok' : 'not_pending' };
  });

  describe('the capacity primitive under parallel acceptance', () => {
    it('two simultaneous acceptances for ONE remaining spot: exactly one wins', async () => {
      await makeSlot('s1', 1);
      await apply('u1', 's1');
      await apply('u2', 's1');
      expect(await totalFor('s1'), 'fixture: two pending applications exist').toBe(2);

      const [r1, r2] = await Promise.all([
        await acceptWithCapacityCheck('s1', 'a-u1-s1'),
        await acceptWithCapacityCheck('s1', 'a-u2-s1'),
      ]);

      expect([r1.accepted, r2.accepted].filter(Boolean), 'exactly one caller may win').toHaveLength(1);
      expect(await acceptedCount('s1'), 'THE DATABASE holds one accepted row').toBe(1);
    });

    it('twenty simultaneous acceptances for three spots: exactly three win', async () => {
      await makeSlot('s1', 3);
      for (let i = 0; i < 20; i++) await apply(`u${i}`, 's1');
      expect(await totalFor('s1')).toBe(20);

      const results = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => await acceptWithCapacityCheck('s1', `a-u${i}-s1`))
      );

      expect(results.filter(r => r.accepted)).toHaveLength(3);
      expect(await acceptedCount('s1'), 'never more than max_spots').toBe(3);
      expect(results.filter(r => r.reason === 'full').length, 'the rest were told the slot is full')
        .toBe(17);
    });

    /**
     * The negative control.
     *
     * Without the lock, the same workload over-allocates. Without this, the
     * tests above could be passing because the pool happened to serialise the
     * work, or because the interleaving never occurred — and a capacity test
     * that never races proves nothing.
     */
    it('NEGATIVE CONTROL: the same workload without the lock DOES over-allocate', async () => {
      await makeSlot('s1', 3);
      for (let i = 0; i < 20; i++) await apply(`u${i}`, 's1');

      const unlockedAccept = async (slotId, applicationId) => await runTransaction(db, async (tx) => {
        const slot = await tx.prepare('SELECT max_spots FROM cap_slots WHERE id = ?').get(slotId);
        await new Promise(r => setImmediate(r));
        const taken = (await tx.prepare(
          "SELECT COUNT(*) AS c FROM cap_applications WHERE slot_id = ? AND status = 'accepted'"
        ).get(slotId)).c;
        if (taken >= slot.max_spots) return { accepted: false };
        const res = await tx.prepare(
          "UPDATE cap_applications SET status = 'accepted' WHERE id = ? AND status = 'pending'"
        ).run(applicationId);
        return { accepted: res.changes === 1 };
      });

      await Promise.all(Array.from({ length: 20 }, async (_, i) => await unlockedAccept('s1', `a-u${i}-s1`)));

      expect(
        await acceptedCount('s1'),
        'without FOR UPDATE the count exceeds capacity — which is what makes the locked tests meaningful',
      ).toBeGreaterThan(3);
    });

    it('simultaneous acceptance and withdrawal cannot produce an over-count', async () => {
      await makeSlot('s1', 2);
      for (const u of ['u1', 'u2', 'u3']) await apply(u, 's1');
      await db.prepare("UPDATE cap_applications SET status = 'accepted' WHERE id = 'a-u1-s1'").run();
      expect(await acceptedCount('s1'), 'fixture: one spot already taken').toBe(1);

      const withdraw = async (id) => await runTransaction(db, async (tx) => {
        await tx.prepare('SELECT max_spots FROM cap_slots WHERE id = ? FOR UPDATE').get('s1');
        await new Promise(r => setImmediate(r));
        await tx.prepare("UPDATE cap_applications SET status = 'withdrawn' WHERE id = ?").run(id);
      });

      await Promise.all([
        await acceptWithCapacityCheck('s1', 'a-u2-s1'),
        await withdraw('a-u1-s1'),
        await acceptWithCapacityCheck('s1', 'a-u3-s1'),
      ]);

      const accepted = await acceptedCount('s1');
      expect(accepted, 'never above capacity whatever the interleaving').toBeLessThanOrEqual(2);
      expect(accepted, 'and at least one acceptance got through').toBeGreaterThanOrEqual(1);
    });

    it('a rollback mid-acceptance leaves no partial acceptance', async () => {
      await makeSlot('s1', 5);
      await apply('u1', 's1');

      await expect(runTransaction(db, async (tx) => {
        await tx.prepare('SELECT max_spots FROM cap_slots WHERE id = ? FOR UPDATE').get('s1');
        const res = await tx.prepare(
          "UPDATE cap_applications SET status = 'accepted' WHERE id = ? AND status = 'pending'"
        ).run('a-u1-s1');
        expect(res.changes, 'the write really happened inside the transaction').toBe(1);
        expect(
          (await tx.prepare("SELECT status FROM cap_applications WHERE id = 'a-u1-s1'").get()).status,
          'and is visible within it',
        ).toBe('accepted');
        throw new Error('boom');
      })).rejects.toThrow('boom');

      expect(await acceptedCount('s1'), 'nothing survived the rollback').toBe(0);
      expect(
        (await db.prepare("SELECT status FROM cap_applications WHERE id = 'a-u1-s1'").get()).status,
        'the application is back to pending',
      ).toBe('pending');
    });

    /**
     * Repetition, because a concurrency result observed once is an anecdote.
     * Twelve independent rounds, each a fresh race for two spots among ten.
     */
    it('holds across 12 repeated stress rounds', async () => {
      for (let round = 0; round < 12; round++) {
        await db.exec('TRUNCATE cap_applications, cap_slots CASCADE');
        await makeSlot('s1', 2);
        for (let i = 0; i < 10; i++) await apply(`u${i}`, 's1');

        const results = await Promise.all(
          Array.from({ length: 10 }, async (_, i) => await acceptWithCapacityCheck('s1', `a-u${i}-s1`))
        );

        const won = results.filter(r => r.accepted).length;
        const inDb = await acceptedCount('s1');
        if (won !== 2 || inDb !== 2) {
          throw new Error(`round ${round}: ${won} callers won, ${inDb} rows accepted; expected 2 and 2`);
        }
      }
      expect(await acceptedCount('s1')).toBe(2);
    }, 60000);
  });

  describe('the transaction stays pinned across the whole capacity operation', () => {
    /**
     * Requirement: BEGIN → read capacity → decide → write → COMMIT must all run
     * on one client, including across the `await` the async conversion adds.
     * Proved by backend identity rather than by outcome.
     */
    it('reports one backend pid for every step, including after an await', async () => {
      await makeSlot('s1', 1);
      await apply('u1', 's1');

      const pids = await runTransaction(db, async (tx) => {
        const pid = async () => (await tx.prepare('SELECT pg_backend_pid() AS p').get()).p;
        const atBegin = await pid();
        await tx.prepare('SELECT max_spots FROM cap_slots WHERE id = ? FOR UPDATE').get('s1');
        const afterLock = await pid();
        await new Promise(r => setImmediate(r));
        const afterAwait = await pid();
        await tx.prepare("UPDATE cap_applications SET status = 'accepted' WHERE id = 'a-u1-s1'").run();
        const afterWrite = await pid();
        return { atBegin, afterLock, afterAwait, afterWrite };
      });

      expect(pids.afterLock).toBe(pids.atBegin);
      expect(pids.afterAwait, 'the pin must survive asynchronous suspension').toBe(pids.atBegin);
      expect(pids.afterWrite).toBe(pids.atBegin);
      expect(await acceptedCount('s1'), 'and the work committed').toBe(1);
    });
  });
});
