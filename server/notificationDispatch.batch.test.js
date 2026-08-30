import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `dispatchMany` must decide exactly what a loop of `dispatch` would decide.
 *
 * ── Why this file exists ──
 *
 * The batch path exists because a broadcast to 150 volunteers cost up to five
 * database round trips per recipient inside one HTTP request. That is a good
 * trade only if the two paths cannot disagree, because what they decide is
 * whether a suspended minor is told they have been suspended, whether they learn
 * an appeal outcome, and whether a child-safety report reaches a moderator.
 *
 * So the rules live in ONE function (`decideDelivery`, private to
 * notificationService.js) and both paths feed it. These are the tests that prove
 * the feeding is equivalent: each case is run BOTH ways against identical
 * fixtures and the resulting rows are compared, so a future edit to one path
 * that changes an outcome fails here.
 *
 * `notificationDispatch.characterization.test.js` is the companion: it pins what
 * `dispatch` itself does, branch by branch, and was written before any of this
 * moved.
 */
let srv, db, notificationService, MANDATORY_NOTICE_EVENTS, EVENT_CATEGORIES;

const A = 'user-student-1';
const B = 'user-student-2';
const C = 'user-student-3';
const ALL = [A, B, C];

const ORDINARY = 'APPLICATION_ACCEPTED';
const MANDATORY = 'ACCOUNT_SUSPENDED';

const payload = { eventId: 'event-softball', eventTitle: 'Softball Tournament Snack Shack' };

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ notificationService } = await import('./services/notificationService.js'));
  ({ MANDATORY_NOTICE_EVENTS, EVENT_CATEGORIES } = await import('./services/notificationContent.js'));
}, 60_000);

afterAll(async () => { await srv?.close(); });

const CATEGORY_OF = (event) => EVENT_CATEGORIES[event] || 'SYSTEM';

async function reset(ids = ALL) {
  for (const id of ids) {
    await db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM notification_preferences WHERE user_id = ?').run(id);
    await db.prepare('UPDATE users SET email_opt_out = 0 WHERE id = ?').run(id);
    await db.prepare('DELETE FROM notification_jobs WHERE payload LIKE ?').run(`%"${id}"%`);
  }
}

async function setPref(userId, category, channel, enabled) {
  await db.prepare(`
    INSERT INTO notification_preferences (user_id, category, channel, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = excluded.enabled
  `).run(userId, category, channel, enabled);
}

/** What was actually written for a set of recipients, in a comparable shape. */
async function written(ids = ALL) {
  const out = {};
  for (const id of ids) {
    const notifications = await db.prepare(
      'SELECT kind, priority, title, body, link, read, dedupe_key FROM notifications WHERE user_id = ? ORDER BY kind, title'
    ).all(id);
    const jobs = await db.prepare(
      'SELECT channel, payload FROM notification_jobs WHERE payload LIKE ?'
    ).all(`%"${id}"%`);
    out[id] = {
      notifications,
      jobs: jobs.map(j => {
        const p = JSON.parse(j.payload);
        return { channel: j.channel, event: p.event, userId: p.userId, dedupeKey: p.dedupeKey };
      }),
    };
  }
  return out;
}

/**
 * Runs one scenario both ways against identical fixtures and compares the rows.
 *
 * `setUp` is re-applied before each half, so the two halves genuinely start from
 * the same state rather than the second inheriting the first's writes.
 */
async function bothWays({ event, ids = ALL, dedupeKeyFor = null, setUp = async () => {} }) {
  await reset(ids);
  await setUp();
  const singleOutcomes = new Map();
  for (const id of ids) {
    singleOutcomes.set(id, await notificationService.dispatch(
      event, payload, id, dedupeKeyFor ? dedupeKeyFor(id) : null
    ));
  }
  const singleRows = await written(ids);

  await reset(ids);
  await setUp();
  const manyOutcomes = await notificationService.dispatchMany(event, payload, ids, dedupeKeyFor);
  const manyRows = await written(ids);

  expect(manyRows, 'the two paths wrote different rows').toEqual(singleRows);
  expect(
    Object.fromEntries(manyOutcomes),
    'the two paths reported different outcomes'
  ).toEqual(Object.fromEntries(singleOutcomes));

  return { rows: manyRows, outcomes: manyOutcomes };
}

beforeEach(async () => { await reset(); });

describe('the two paths agree, case by case', () => {
  it('agrees when everybody is eligible', async () => {
    const { rows } = await bothWays({ event: ORDINARY });
    for (const id of ALL) {
      expect(rows[id].notifications).toHaveLength(1);
      expect(rows[id].jobs).toHaveLength(1);
    }
  });

  it('agrees when one recipient has disabled in-app', async () => {
    const { rows } = await bothWays({
      event: ORDINARY,
      setUp: () => setPref(B, CATEGORY_OF(ORDINARY), 'inapp', 0),
    });
    expect(rows[A].notifications).toHaveLength(1);
    expect(rows[B].notifications).toHaveLength(0);
    expect(rows[B].jobs, 'email is a separate choice').toHaveLength(1);
    expect(rows[C].notifications).toHaveLength(1);
  });

  it('agrees when one recipient has disabled email', async () => {
    const { rows } = await bothWays({
      event: ORDINARY,
      setUp: () => setPref(C, CATEGORY_OF(ORDINARY), 'email', 0),
    });
    expect(rows[C].notifications).toHaveLength(1);
    expect(rows[C].jobs).toHaveLength(0);
    expect(rows[A].jobs).toHaveLength(1);
  });

  it('agrees when one recipient has opted out of email globally', async () => {
    const { rows } = await bothWays({
      event: ORDINARY,
      setUp: () => db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(A),
    });
    expect(rows[A].jobs).toHaveLength(0);
    expect(rows[A].notifications).toHaveLength(1);
    expect(rows[B].jobs).toHaveLength(1);
  });

  it('agrees on a MIXED page — every preference combination at once', async () => {
    /* The case a batch is most likely to get wrong: three recipients, three
       different answers, in one call. */
    const { rows } = await bothWays({
      event: ORDINARY,
      setUp: async () => {
        await setPref(A, CATEGORY_OF(ORDINARY), 'inapp', 0);
        await setPref(B, CATEGORY_OF(ORDINARY), 'email', 0);
        await db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(C);
      },
    });
    expect(rows[A].notifications).toHaveLength(0);
    expect(rows[A].jobs).toHaveLength(1);
    expect(rows[B].notifications).toHaveLength(1);
    expect(rows[B].jobs).toHaveLength(0);
    expect(rows[C].notifications).toHaveLength(1);
    expect(rows[C].jobs).toHaveLength(0);
  });

  it('agrees that a mandatory notice overrides every preference, for everybody', async () => {
    const { rows } = await bothWays({
      event: MANDATORY,
      setUp: async () => {
        for (const id of ALL) {
          await setPref(id, CATEGORY_OF(MANDATORY), 'inapp', 0);
          await setPref(id, CATEGORY_OF(MANDATORY), 'email', 0);
          await db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(id);
        }
      },
    });
    for (const id of ALL) {
      expect(rows[id].notifications, `${id} lost a mandatory in-app row`).toHaveLength(1);
      expect(rows[id].jobs, `${id} lost a mandatory email`).toHaveLength(1);
    }
  });

  it('agrees for EVERY event in MANDATORY_NOTICE_EVENTS', async () => {
    for (const event of MANDATORY_NOTICE_EVENTS) {
      await bothWays({
        event,
        setUp: async () => {
          for (const id of ALL) {
            await setPref(id, CATEGORY_OF(event), 'inapp', 0);
            await setPref(id, CATEGORY_OF(event), 'email', 0);
            await db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(id);
          }
        },
      });
    }
  });

  it('agrees when a recipient does not exist', async () => {
    const ids = [A, 'no-such-user', C];
    const { outcomes } = await bothWays({ event: ORDINARY, ids });
    expect(outcomes.get('no-such-user')).toBeNull();
    expect(outcomes.get(A)).toBe(true);
  });

  it('agrees on deduplication', async () => {
    const key = (id) => `batch-dedupe-shared-${id}`;
    /* Pre-seed A's row so the batch must skip exactly one recipient. */
    await bothWays({
      event: ORDINARY,
      dedupeKeyFor: key,
      setUp: async () => {
        await notificationService.dispatch(ORDINARY, payload, A, key(A));
      },
    });
  });

  it('agrees when every recipient is deduplicated', async () => {
    const key = (id) => `batch-dedupe-all-${id}`;
    const { outcomes } = await bothWays({
      event: ORDINARY,
      dedupeKeyFor: key,
      setUp: async () => {
        for (const id of ALL) await notificationService.dispatch(ORDINARY, payload, id, key(id));
      },
    });
    for (const id of ALL) expect(outcomes.get(id)).toBe(false);
  });

  it('agrees for a single recipient', async () => {
    await bothWays({ event: ORDINARY, ids: [A] });
  });
});

describe('edges the loop never had to think about', () => {
  it('an empty recipient list writes nothing and touches no database', async () => {
    const spy = vi.spyOn(db, 'prepare');
    try {
      const outcomes = await notificationService.dispatchMany(ORDINARY, payload, []);
      expect(outcomes.size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('a duplicated recipient id is notified once, not twice', async () => {
    await reset();
    const outcomes = await notificationService.dispatchMany(ORDINARY, payload, [A, A, A]);
    expect(outcomes.size).toBe(1);
    expect((await written([A]))[A].notifications).toHaveLength(1);
  });

  it('null and undefined recipients are dropped rather than queried', async () => {
    await reset();
    const outcomes = await notificationService.dispatchMany(ORDINARY, payload, [A, null, undefined, '']);
    expect([...outcomes.keys()]).toEqual([A]);
  });
});

describe('the batch is actually a batch', () => {
  it('costs a fixed number of statements regardless of recipient count', async () => {
    await reset();
    const original = db.prepare;
    const count = async (ids) => {
      await reset(ids);
      let calls = 0;
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => { calls++; return original(sql); });
      try {
        await notificationService.dispatchMany(ORDINARY, payload, ids);
      } finally { spy.mockRestore(); }
      return calls;
    };

    const one = await count([A]);
    const three = await count(ALL);

    // Three recipients must not cost three times one recipient.
    expect(three).toBe(one);
    // Facts, notifications, jobs. No dedupe probe: this call passes no keys.
    expect(three).toBeLessThanOrEqual(3);
  });

  it('costs the loop N times as much, which is the point of the change', async () => {
    await reset();
    const original = db.prepare;
    let loopCalls = 0;
    let spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => { loopCalls++; return original(sql); });
    try {
      for (const id of ALL) await notificationService.dispatch(ORDINARY, payload, id);
    } finally { spy.mockRestore(); }

    await reset();
    let batchCalls = 0;
    spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => { batchCalls++; return original(sql); });
    try {
      await notificationService.dispatchMany(ORDINARY, payload, ALL);
    } finally { spy.mockRestore(); }

    expect(batchCalls).toBeLessThan(loopCalls);
  });
});

describe('failure semantics', () => {
  it('an ordinary notice falls back to per-recipient when the batch write fails', async () => {
    /**
     * The property being preserved: `dispatch` was per-recipient best-effort, so
     * if recipient seven failed, one to six and eight onward still got theirs. A
     * batch write is all-or-nothing, so a failed batch must not cost everybody
     * else their notification.
     */
    await reset();
    const original = db.prepare;
    let failedOnce = false;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      // Fail only the MULTI-row insert, so the per-recipient retry can succeed.
      if (!failedOnce && /INSERT INTO notifications/i.test(sql) && /\),\s*\(/.test(sql)) {
        failedOnce = true;
        throw new Error('batch write refused');
      }
      return original(sql);
    });
    try {
      const outcomes = await notificationService.dispatchMany(ORDINARY, payload, ALL);
      expect(failedOnce, 'the batch insert was never attempted').toBe(true);
      for (const id of ALL) expect(outcomes.get(id), `${id} was lost`).toBe(true);
    } finally { spy.mockRestore(); }

    for (const id of ALL) {
      expect((await written([id]))[id].notifications, `${id} got no row`).toHaveLength(1);
    }
  });

  it('a MANDATORY notice rethrows instead of falling back', async () => {
    /**
     * Its caller is inside a transaction that must roll back. Continuing with
     * some recipients silently unnotified is the failure mode the rethrow in
     * `dispatch` exists to prevent, and the batch path must not reintroduce it.
     */
    await reset();
    const original = db.prepare;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (/INSERT INTO notifications/i.test(sql)) throw new Error('disk on fire');
      return original(sql);
    });
    try {
      await expect(
        notificationService.dispatchMany(MANDATORY, payload, ALL)
      ).rejects.toThrow('disk on fire');
    } finally { spy.mockRestore(); }
  });

  it('a socket failure does not fail the batch', async () => {
    await reset();
    const events = await import('./realtime/events.js');
    const spy = vi.spyOn(events, 'emitToUser').mockImplementation(() => {
      throw new Error('no socket server');
    });
    try {
      const outcomes = await notificationService.dispatchMany(ORDINARY, payload, ALL);
      for (const id of ALL) expect(outcomes.get(id)).toBe(true);
    } finally { spy.mockRestore(); }
    for (const id of ALL) {
      expect((await written([id]))[id].notifications).toHaveLength(1);
    }
  });
});
