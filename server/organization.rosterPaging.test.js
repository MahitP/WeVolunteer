import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A club's count and its roster have to agree, and "Show all" has to mean all.
 *
 * ── What the rehearsal showed (N11) ──
 *
 * The club page's head said 39 and its list held 38. The count was every
 * membership row; the list was every membership row whose account is active.
 * One student in the club had been suspended, so the page contradicted itself,
 * and so did the "Show all 38 members" link sitting under the "39".
 *
 * The count now means what the list means: people with active accounts. A
 * suspended account is hidden from rosters, so counting it would describe a
 * member nobody can see.
 *
 * ── Bounded, and still complete ──
 *
 * One response still carries at most a hundred members (the cap the
 * roster-privacy tests pin). The full members page reads the rest a hundred at
 * a time with `membersFrom`, behind the same gate: an outsider asking for a
 * later page gets the same empty list as for the first.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const OTHER_STUDENT = 'priya.patel@example.com';
const CLUB_SIZE = 105; // the manager plus 104 others — past one page

describe('the organization roster, past one page', () => {
  let srv;
  let db;
  let manager;
  let outsider;
  let orgKey;
  let orgId;

  const page = async (session, query = '') =>
    (await srv.call('GET', `/api/organizations/${orgKey}${query}`, undefined, session)).body;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    outsider = await srv.login(OTHER_STUDENT);

    const created = await srv.call('POST', '/api/organizations', {
      name: `Roster Paging Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club with more members than one page holds.',
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;

    const now = new Date().toISOString();
    for (let i = 1; i < CLUB_SIZE; i++) {
      const id = `rp-${String(i).padStart(3, '0')}`;
      await db.prepare(`
        INSERT INTO users (id, name, email, username, password_hash, grade, role,
                           verified, email_verified, account_status, created_at, token_version)
        VALUES (?, ?, ?, ?, 'x', '11', 'student', 1, 1, 'active', ?, 0)
      `).run(id, `Paged ${id}`, `${id}@example.invalid`, id.replace('-', '_'), now);
      await db.prepare(`
        INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(orgId, id, now);
    }
    /* One more member whose account is suspended — in the club, but not shown. */
    await db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role,
                         verified, email_verified, account_status, created_at, token_version)
      VALUES ('rp-suspended', 'Suspended Member', 'rp-suspended@example.invalid', 'rp_suspended',
              'x', '11', 'student', 1, 1, 'suspended', ?, 0)
    `).run(now);
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, 'rp-suspended', 'member', ?)
    `).run(orgId, now);
  }, 120000);

  afterAll(async () => { await srv?.close(); });

  it('counts the members a reader can see, not a suspended account', async () => {
    const p = await page(manager);
    expect(p.organization.memberCount).toBe(CLUB_SIZE);
    expect(JSON.stringify(p)).not.toContain('Suspended Member');
  });

  it('gives the same count in the directory and to an outsider', async () => {
    expect((await page(outsider)).organization.memberCount).toBe(CLUB_SIZE);
    const list = await srv.call('GET', '/api/organizations?limit=50', undefined, manager);
    const listed = list.body.organizations.find(o => o.id === orgId);
    expect(listed?.memberCount).toBe(CLUB_SIZE);
  });

  it('still answers with at most a hundred members at once', async () => {
    expect((await page(manager)).members).toHaveLength(100);
  });

  it('gives the rest with membersFrom, with nobody twice and nobody missed', async () => {
    const first = (await page(manager)).members.map(m => m.id);
    const rest = (await page(manager, '?membersFrom=100')).members.map(m => m.id);
    expect(rest).toHaveLength(CLUB_SIZE - 100);
    const all = new Set([...first, ...rest]);
    expect(all.size).toBe(CLUB_SIZE);
  });

  it('treats a nonsense membersFrom as the first page', async () => {
    for (const q of ['?membersFrom=-5', '?membersFrom=abc', '?membersFrom=1e9x']) {
      expect((await page(manager, q)).members).toHaveLength(100);
    }
  });

  it('gives an outsider no names on any page', async () => {
    expect((await page(outsider, '?membersFrom=100')).members).toEqual([]);
    expect((await page(outsider)).members).toEqual([]);
  });

  it('agrees after somebody joins', async () => {
    const joined = await srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, outsider);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.memberCount).toBe(CLUB_SIZE + 1);
  });
});
