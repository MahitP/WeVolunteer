import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestServer } from './testServer.js';
import { distinctionFor } from './profileSerializer.js';

/**
 * The founder's profile (rulings 19 and 21, 2026-10-04).
 *
 * Ruling 21: his page is a student's page whatever his history — "it should
 * look like a student's profile" — with honest zeros until there is service on
 * it. Every other account keeps the history-driven layout.
 *
 * Ruling 19: "every badge, achievement, hour and streak" on his real account,
 * built as a showcase drawn on the profile and nothing else. Nothing is written
 * to attendance or to `user_badges`, so the transcript, certificates, /verify
 * and every platform total stay true without a marker that 26 files would each
 * have to remember to exclude.
 *
 * Both are decided on the server, from the address the ownership allowlist
 * names (`ownerIdentity`); the client only follows the flags.
 */

const FOUNDER_EMAIL = 'mahitp.16@gmail.com';
const PLATFORM_EMAIL = 'wevolunteer.platform@gmail.com';

describe('the founder distinction', () => {
  it('asks for the student layout and the showcase on the founder alone', () => {
    expect(distinctionFor('super_admin', FOUNDER_EMAIL)).toMatchObject({ studentProfile: true, showcase: true });
    for (const d of [distinctionFor('super_admin', PLATFORM_EMAIL), distinctionFor('super_admin'), distinctionFor('partner')]) {
      expect(d.studentProfile).toBeFalsy();
      expect(d.showcase).toBeFalsy();
    }
  });
});

describe('the founder profile, served', () => {
  let srv;
  let db;
  let student;
  let founderId;
  let platformId;

  const insertOwner = async (email, username) => {
    const id = `user-${randomUUID()}`;
    await db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, email_verified, account_status, created_at, token_version)
      VALUES (?, ?, ?, ?, 'x', 'Adult', 'super_admin', 1, 1, 'active', ?, 0)
    `).run(id, username, email, username, new Date().toISOString());
    return id;
  };

  const count = async (sql, ...args) => Number((await db.prepare(sql).get(...args)).n);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    student = await srv.login('leo.chen@example.com');
    founderId = await insertOwner(FOUNDER_EMAIL, 'mahit');
    platformId = await insertOwner(PLATFORM_EMAIL, 'wevolunteer');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('serves the founder a volunteer profile at zero hours, with honest zeros', async () => {
    const res = await srv.call('GET', `/api/users/${founderId}/profile`, undefined, student);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stats.hours).toBe(0);
    expect(res.body.stats.eventsCompleted).toBe(0);
  });

  it('still refuses that profile for an owner who has never volunteered', async () => {
    expect((await srv.call('GET', `/api/users/${platformId}/profile`, undefined, student)).status).toBe(404);
  });

  it('shows every active badge and every milestone as a demonstration, on both profile routes', async () => {
    const active = await count('SELECT COUNT(*) AS n FROM badges WHERE active = 1');
    expect(active).toBeGreaterThan(0);

    const record = (await srv.call('GET', `/api/users/${founderId}/profile`, undefined, student)).body;
    const pub = (await srv.call('GET', '/api/users/by-username/mahit', undefined, student)).body.profile;
    for (const showcase of [record.showcase, pub.showcase]) {
      expect(showcase.badges).toHaveLength(active);
      expect(showcase.milestones.length).toBeGreaterThan(0);
      expect(showcase.badges.every(b => b.name && b.icon)).toBe(true);
      /* Definitions only: an award date would be a claim that it was earned. */
      expect(showcase.badges.some(b => 'earned_at' in b)).toBe(false);
    }
  });

  it('keeps the real record separate: the showcase is not milestones or badges earned', async () => {
    const record = (await srv.call('GET', `/api/users/${founderId}/profile`, undefined, student)).body;
    expect(record.milestones.every(m => m.earned === false)).toBe(true);
    const badges = (await srv.call('GET', `/api/users/${founderId}/badges`, undefined, student)).body.badges;
    expect(badges).toHaveLength(0);
  });

  it('writes nothing to the record', async () => {
    await srv.call('GET', `/api/users/${founderId}/profile`, undefined, student);
    await srv.call('GET', '/api/users/by-username/mahit', undefined, student);
    expect(await count('SELECT COUNT(*) AS n FROM attendance WHERE user_id = ?', founderId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM user_badges WHERE user_id = ?', founderId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM certificates WHERE user_id = ?', founderId)).toBe(0);
  });

  it('shows no showcase on any other account', async () => {
    const pub = (await srv.call('GET', '/api/users/by-username/wevolunteer', undefined, student)).body.profile;
    expect(pub.showcase).toBeUndefined();
    const leo = (await srv.call('GET', '/api/users/by-username/leo', undefined, student)).body.profile;
    expect(leo?.showcase).toBeUndefined();
  });
});
