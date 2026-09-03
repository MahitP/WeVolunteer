import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Who may read a club's list of children.
 *
 * ── What this changed, and why it had to ──
 *
 * `GET /api/organizations/:key` used to return up to a hundred members to every
 * reader holding `directory.read` — which is every signed-in account except
 * `partner`. So any account could open any organization and read a named roster
 * of a club it has nothing to do with.
 *
 * Every row went through `profileSummary`, so no field leaked that a profile
 * would have withheld. That is the wrong question. The LIST is the disclosure,
 * and no per-field allowlist can answer it: "these forty children are in this
 * club at this school" is a fact about forty people that none of them published.
 *
 * ── The line ──
 *
 * Members, managers and moderators get the roster. Everybody else gets
 * `organization.memberCount`, which names nobody and is what actually answers
 * "is this club real, and how big is it" for somebody deciding whether to join.
 *
 * The count is deliberately NOT withheld. A club that showed nothing at all
 * would be unjoinable in practice — the whole point of the redesigned page is
 * that a stranger can judge whether to press Join.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';
const ADMIN = 'admin@example.gov';

describe('the organization roster', () => {
  let srv;
  let db;
  let manager;
  let member;
  let outsider;
  let managerId;
  let memberId;
  let outsiderId;
  let orgKey;
  let orgId;

  const join = async (userId, role = 'member') => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role
    `).run(orgId, userId, role, new Date().toISOString());
  };

  const page = async (session) =>
    (await srv.call('GET', `/api/organizations/${orgKey}`, undefined, session)).body;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    member = await srv.login(STUDENT);
    outsider = await srv.login(OTHER_STUDENT);

    managerId = (await srv.call('GET', '/api/auth/me', undefined, manager)).body.id;
    memberId = (await srv.call('GET', '/api/auth/me', undefined, member)).body.id;
    outsiderId = (await srv.call('GET', '/api/auth/me', undefined, outsider)).body.id;

    const created = await srv.call('POST', '/api/organizations', {
      name: `Roster Privacy Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club used by the roster-privacy tests.',
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(orgId);
    await join(managerId, 'manager');
    await join(memberId, 'member');
  });

  it('gives the roster to a member', async () => {
    const p = await page(member);
    expect(p.members.map(m => m.name).sort()).toEqual(['Jordan Whitfield', 'Leo Chen']);
  });

  it('gives the roster to the manager', async () => {
    expect((await page(manager)).members).toHaveLength(2);
  });

  /**
   * The change. A signed-in student with no connection to the club gets a
   * number and no names.
   */
  it('gives a non-member the count and not one name', async () => {
    const p = await page(outsider);
    expect(p.members).toEqual([]);
    expect(p.organization.memberCount).toBe(2);

    const body = JSON.stringify(p);
    expect(body).not.toContain('Leo Chen');
    expect(body).not.toContain('leochen');
    /* The founder's name is a separate, deliberate disclosure — a club records
       who started it — so it is NOT asserted absent here. What must be absent is
       the membership list. */
    expect(body).not.toContain(memberId);
  });

  it('gives the roster back the moment they join', async () => {
    expect((await page(outsider)).members).toEqual([]);
    const joined = await srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, outsider);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect((await page(outsider)).members).toHaveLength(3);
  });

  /**
   * A moderator sees it without a membership row, because
   * `organization.moderate` is the named bypass and an administrator reviewing a
   * club needs to know who is in it.
   */
  it('gives the roster to an administrator who is not a member', async () => {
    const admin = await srv.login(ADMIN);
    const p = await page(admin);
    expect(p.members.length).toBeGreaterThanOrEqual(2);
    expect(p.viewer.isMember).toBe(false);
  });

  /**
   * Per-member hours were already manager-only, and stay that way.
   *
   * A roster that ranked classmates by hours is a leaderboard nobody asked for,
   * and on a page about a school club it would read as one.
   */
  it('keeps per-member hours to the manager', async () => {
    const asManager = await page(manager);
    for (const m of asManager.members) expect(typeof m.hours).toBe('number');

    const asMember = await page(member);
    for (const m of asMember.members) expect(m.hours).toBeUndefined();
  });

  it('keeps the club’s total to the manager', async () => {
    expect((await page(manager)).totals).not.toBeNull();
    expect((await page(member)).totals).toBeNull();
    expect((await page(outsider)).totals).toBeNull();
  });

  /**
   * The viewer's OWN service is theirs to see whatever their membership, because
   * showing somebody their own record discloses nothing.
   */
  it('still gives every reader their own figures', async () => {
    for (const session of [manager, member, outsider]) {
      const p = await page(session);
      expect(typeof p.viewer.hours).toBe('number');
      expect(Array.isArray(p.viewer.history)).toBe(true);
    }
  });

  /**
   * The roster is still bounded. A club of five hundred must not answer with
   * five hundred children in one response, whoever is asking.
   */
  it('is capped', async () => {
    const source = await import('node:fs').then(fs => fs.promises.readFile(
      new URL('./routes/organizationRoutes.js', import.meta.url), 'utf8',
    ));
    expect(source).toMatch(/LIMIT 100/);
  });
});
