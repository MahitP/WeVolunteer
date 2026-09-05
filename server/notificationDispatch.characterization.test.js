import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * What `notificationService.dispatch` actually does, branch by branch.
 *
 * ── Why this file exists ──
 *
 * These are CHARACTERIZATION tests, written before the dispatch path was
 * optimised and deliberately asserting the behaviour that was already there
 * rather than the behaviour somebody thinks ought to be there. The optimisation
 * that follows — folding three per-recipient reads into one, and adding a
 * batched path for fan-outs — is only safe if "the same decisions, on the same
 * inputs" can be checked rather than argued about.
 *
 * The decisions being pinned are not ordinary product behaviour. `dispatch`
 * decides whether a suspended minor is told they have been suspended, whether
 * they learn of an appeal outcome, and whether a child-safety report reaches a
 * moderator. `MANDATORY_NOTICE_EVENTS` exists because a notification preference
 * must not become a way to opt out of being told you were sanctioned, and the
 * rethrow on a mandatory failure exists because a suspension that commits with
 * no notice is worse than one that fails cleanly.
 *
 * So every branch below is asserted on the ROWS WRITTEN, not on the return
 * value: the return value was already `null` for two different reasons, which is
 * how the dedupe-logging defect (`notifications.dedupe.test.js`) survived.
 */
let srv, db, notificationService, MANDATORY_NOTICE_EVENTS, EVENT_CATEGORIES;

const STUDENT = 'user-student-1';
const CATEGORY_OF = (event) => EVENT_CATEGORIES[event] || 'SYSTEM';

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ notificationService } = await import('./services/notificationService.js'));
  ({ MANDATORY_NOTICE_EVENTS, EVENT_CATEGORIES } = await import('./services/notificationContent.js'));
}, 60_000);

afterAll(async () => { await srv?.close(); });

/** Clears this user's notifications, jobs and preferences between cases. */
async function reset(userId = STUDENT) {
  await db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM notification_preferences WHERE user_id = ?').run(userId);
  await db.prepare('UPDATE users SET email_opt_out = 0 WHERE id = ?').run(userId);
  await db.prepare("DELETE FROM notification_jobs WHERE payload LIKE ?").run(`%"${userId}"%`);
}

const notificationsFor = (userId = STUDENT) =>
  db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id').all(userId);

const jobsFor = (userId = STUDENT) =>
  db.prepare("SELECT * FROM notification_jobs WHERE payload LIKE ?").all(`%"${userId}"%`);

async function setPref(userId, category, channel, enabled) {
  await db.prepare(`
    INSERT INTO notification_preferences (user_id, category, channel, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = excluded.enabled
  `).run(userId, category, channel, enabled);
}

/* A non-mandatory event with a real content template. */
const ORDINARY = 'APPLICATION_ACCEPTED';
/* A mandatory one — a preference must not be able to suppress it. */
const MANDATORY = 'ACCOUNT_SUSPENDED';

const payloadFor = (event) => ({
  eventId: 'event-softball', eventTitle: 'Softball Tournament Snack Shack',
  reason: 'characterization fixture', event,
});

beforeEach(async () => { await reset(); });

describe('the happy path', () => {
  it('writes one in-app row and one email job, and reports true', async () => {
    const result = await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    expect(result).toBe(true);
    expect(await notificationsFor()).toHaveLength(1);
    expect(await jobsFor()).toHaveLength(1);
  });

  it('the in-app row carries the mapped kind, a title and a body', async () => {
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    const [row] = await notificationsFor();
    expect(row.kind).toBeTruthy();
    expect(row.title).toBeTruthy();
    expect(typeof row.body).toBe('string');
    expect(row.read).toBe(0);
    expect(row.created_at).toBeTruthy();
  });

  it('the email job carries the event, the payload and the recipient', async () => {
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    const [job] = await jobsFor();
    const parsed = JSON.parse(job.payload);
    expect(parsed.event).toBe(ORDINARY);
    expect(parsed.userId).toBe(STUDENT);
    expect(parsed.payload).toMatchObject({ eventId: 'event-softball' });
    expect(job.channel).toBe('email');
    expect(job.status).toBe('pending');
  });
});

describe('preferences are honoured for an ordinary notice', () => {
  it('no in-app row when the in-app channel is disabled', async () => {
    await setPref(STUDENT, CATEGORY_OF(ORDINARY), 'inapp', 0);
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    expect(await notificationsFor()).toHaveLength(0);
    expect(await jobsFor(), 'email is a separate choice').toHaveLength(1);
  });

  it('no email job when the email channel is disabled', async () => {
    await setPref(STUDENT, CATEGORY_OF(ORDINARY), 'email', 0);
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    expect(await notificationsFor(), 'in-app is a separate choice').toHaveLength(1);
    expect(await jobsFor()).toHaveLength(0);
  });

  it('no email job when the account has opted out globally', async () => {
    await db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(STUDENT);
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    expect(await notificationsFor()).toHaveLength(1);
    expect(await jobsFor()).toHaveLength(0);
  });

  it('defaults to enabled when no preference row exists', async () => {
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    expect(await notificationsFor()).toHaveLength(1);
    expect(await jobsFor()).toHaveLength(1);
  });

  it('a preference for a DIFFERENT category does not apply', async () => {
    await setPref(STUDENT, 'SOMETHING_ELSE', 'email', 0);
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    expect(await jobsFor()).toHaveLength(1);
  });
});

describe('a mandatory notice ignores every preference', () => {
  it('is delivered on both channels with both disabled and a global opt-out', async () => {
    /**
     * The rule this pins is published policy, not a nicety: a notification
     * preference is a choice about how much the product talks to you, and it
     * cannot be a way to opt out of being told you were sanctioned. A suspended
     * account cannot read an in-app row at all — `authenticateToken` refuses it
     * before `req.user` exists — so email is the only channel that reaches the
     * person being told about their own suspension and their right to appeal.
     */
    await setPref(STUDENT, CATEGORY_OF(MANDATORY), 'inapp', 0);
    await setPref(STUDENT, CATEGORY_OF(MANDATORY), 'email', 0);
    await db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(STUDENT);

    await notificationService.dispatch(MANDATORY, payloadFor(MANDATORY), STUDENT);

    expect(await notificationsFor(), 'the in-app row is written even though it cannot be read yet')
      .toHaveLength(1);
    expect(await jobsFor(), 'email is the only channel a suspended account can receive')
      .toHaveLength(1);
  });

  it('every event in MANDATORY_NOTICE_EVENTS behaves that way', async () => {
    /* Enumerated rather than sampled: adding an event to the set must mean it
       actually gets this treatment, and a spot check would not notice. */
    for (const event of MANDATORY_NOTICE_EVENTS) {
      await reset();
      await setPref(STUDENT, CATEGORY_OF(event), 'inapp', 0);
      await setPref(STUDENT, CATEGORY_OF(event), 'email', 0);
      await db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(STUDENT);

      await notificationService.dispatch(event, payloadFor(event), STUDENT);

      expect(await notificationsFor(), `${event} wrote no in-app row`).toHaveLength(1);
      expect(await jobsFor(), `${event} queued no email`).toHaveLength(1);
    }
  });
});

describe('deduplication', () => {
  it('the second dispatch with the same key writes nothing and reports false', async () => {
    const key = `char-dedupe-${Date.now()}`;
    expect(await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT, key)).toBe(true);
    expect(await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT, key)).toBe(false);
    expect(await notificationsFor()).toHaveLength(1);
    expect(await jobsFor()).toHaveLength(1);
  });

  it('a different key is a different notification', async () => {
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT, `a-${Date.now()}`);
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT, `b-${Date.now()}`);
    expect(await notificationsFor()).toHaveLength(2);
  });

  it('no key means no deduplication', async () => {
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
    expect(await notificationsFor()).toHaveLength(2);
  });

  it('a key older than the seven-day window does not suppress a new one', async () => {
    const key = `char-old-${Date.now()}`;
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT, key);
    /* Age the row past the window, and clear its key so the partial unique index
       does not refuse the second insert — the window is what is under test. */
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await db.prepare('UPDATE notifications SET created_at = ?, dedupe_key = NULL WHERE user_id = ?')
      .run(eightDaysAgo, STUDENT);

    expect(await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT, key)).toBe(true);
    expect(await notificationsFor()).toHaveLength(2);
  });

  it('deduplication is per recipient, not global', async () => {
    const key = `char-shared-${Date.now()}`;
    await reset('user-student-2');
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT, key);
    await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), 'user-student-2', key);
    expect(await notificationsFor(STUDENT)).toHaveLength(1);
    expect(await notificationsFor('user-student-2')).toHaveLength(1);
    await reset('user-student-2');
  });
});

describe('recipients that are not there', () => {
  it('an unknown user id writes nothing and reports null', async () => {
    const result = await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), 'no-such-user');
    expect(result).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?')
      .get('no-such-user')).toMatchObject({ c: 0 });
  });
});

describe('failure handling', () => {
  it('an ordinary notice swallows a failure and reports null', async () => {
    /* Best-effort by design: a missed event reminder must never fail the
       operation that triggered it. */
    const original = db.prepare;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (/INSERT INTO notifications/i.test(sql)) throw new Error('disk on fire');
      return original(sql);
    });
    try {
      const result = await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
      expect(result).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('a MANDATORY notice rethrows, so its caller can roll back', async () => {
    /**
     * `dispatch` is called inside the suspension transaction. A swallowed
     * failure meant a student could be suspended with no notice, no appeal link
     * and no error anywhere, with the suspension committed regardless.
     */
    const original = db.prepare;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (/INSERT INTO notifications/i.test(sql)) throw new Error('disk on fire');
      return original(sql);
    });
    try {
      await expect(
        notificationService.dispatch(MANDATORY, payloadFor(MANDATORY), STUDENT)
      ).rejects.toThrow('disk on fire');
    } finally { spy.mockRestore(); }
  });
});

describe('the realtime emit', () => {
  it('does not fail the dispatch when the socket layer throws', async () => {
    /* The emit is best-effort and must never fail the transaction it is in. */
    const events = await import('./realtime/events.js');
    const spy = vi.spyOn(events, 'emitToUser').mockImplementation(() => {
      throw new Error('no socket server');
    });
    try {
      const result = await notificationService.dispatch(ORDINARY, payloadFor(ORDINARY), STUDENT);
      expect(result).toBe(true);
      expect(await notificationsFor()).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
});
