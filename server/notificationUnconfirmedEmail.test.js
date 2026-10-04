import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Nothing but the confirmation link goes to an unconfirmed address
 * (owner ruling 25, final audit Phase 5, 2026-10-04).
 *
 * Signing up sent two emails in the same minute: "Please verify your email"
 * and "You earned a badge — Early Supporter". An address is unconfirmed
 * precisely because it may belong to somebody else — a typo, a sibling's —
 * and the badge email told that stranger the person had joined. The in-app
 * notification is still written; only the email waits. Mandatory notices
 * (a suspension, an appeal outcome) are unchanged: they go regardless, for the
 * reason MANDATORY_NOTICE_EVENTS gives.
 */
let srv, db, notificationService;
const STUDENT = 'user-student-1';

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ notificationService } = await import('./services/notificationService.js'));
}, 60_000);
afterAll(async () => { await srv?.close(); });

const jobs = () => db.prepare('SELECT * FROM notification_jobs WHERE payload LIKE ?').all(`%"${STUDENT}"%`);
const rows = () => db.prepare('SELECT * FROM notifications WHERE user_id = ?').all(STUDENT);

beforeEach(async () => {
  await db.prepare('DELETE FROM notifications WHERE user_id = ?').run(STUDENT);
  await db.prepare('DELETE FROM notification_jobs WHERE payload LIKE ?').run(`%"${STUDENT}"%`);
  await db.prepare('UPDATE users SET email_verified = 1, email_opt_out = 0 WHERE id = ?').run(STUDENT);
});

describe('email to an address nobody has confirmed', () => {
  it('writes the in-app notification and holds the email', async () => {
    await db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(STUDENT);
    await notificationService.dispatch('BADGE_EARNED', { badgeName: 'Early Supporter' }, STUDENT);
    expect(await rows()).toHaveLength(1);
    expect(await jobs()).toHaveLength(0);
  });

  it('holds it on the fan-out path too', async () => {
    await db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(STUDENT);
    await notificationService.dispatchMany('BADGE_EARNED', { badgeName: 'Early Supporter' }, [STUDENT]);
    expect(await jobs()).toHaveLength(0);
  });

  it('sends it once the address is confirmed', async () => {
    await notificationService.dispatch('BADGE_EARNED', { badgeName: 'Early Supporter' }, STUDENT);
    expect(await jobs()).toHaveLength(1);
  });

  it('still sends a mandatory notice', async () => {
    await db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(STUDENT);
    await notificationService.dispatch('ACCOUNT_SUSPENDED', { reason: 'fixture' }, STUDENT);
    expect(await jobs()).toHaveLength(1);
  });
});
