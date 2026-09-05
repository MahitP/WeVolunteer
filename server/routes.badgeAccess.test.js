import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Who may read a badge list.
 *
 * ── The defect these tests exist for ──
 *
 * `GET /api/badges` and `GET /api/users/:userId/badges` shipped with no
 * `authenticateToken` at all. The second one takes a user id in the path and
 * answers with that person's achievement history and the timestamp of every
 * award — for a population that is mostly minors — to anybody on the internet
 * who can guess or scrape an id. Ids appear in ordinary application URLs, so
 * "guess" overstates the work involved.
 *
 * It was invisible to authz.completeness.test.js Guard 2 for a structural
 * reason worth remembering: that guard walks the router stack for routes which
 * ARE authenticated and lack a capability gate. A route with no
 * `authenticateToken` is not in the set it examines, so the weakest routes in
 * the application were the ones the completeness guard could not see. Adding
 * the middleware is what puts them under review, and the ROUTE_REGISTRY entries
 * added alongside this file are where the "why is this open to every role?"
 * answer now lives.
 *
 * ── The posture, and why it is this one ──
 *
 * Not self-only. `BadgesList` renders on the volunteer profile page, whose
 * server route (`GET /api/users/:id/profile`) already returns `milestones` —
 * earned achievements — and the full completed-service history to any
 * authenticated caller, gating only contact PII and future whereabouts. Badges
 * are that same class of data, so they get that same posture rather than a
 * stricter new one invented here.
 */

let srv;
let db;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => { await srv.close(); });

const STUDENT = 'user-student-1';

describe('badge reads require a session', () => {
  beforeAll(async () => {
    // A real award, so a leak would actually have something to leak. The
    // migration seeds the badge catalogue, so any active badge will do.
    const badge = await db.prepare('SELECT id FROM badges WHERE active = 1 LIMIT 1').get();
    const already = await db.prepare('SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?')
      .get(STUDENT, badge.id);
    if (!already) {
      await db.prepare(`
        INSERT INTO user_badges (id, user_id, badge_id, earned_at)
        VALUES (?, ?, ?, ?)
      `).run('ub-access-test', STUDENT, badge.id, new Date().toISOString());
    }
  });

  /* The catalogue cases that were here are gone with `GET /api/badges`. It had
     no caller in the product and disagreed with how every other badge surface
     works — see the note in badgeRoutes.js. The per-user cases below are the
     ones that were protecting personal data, and they stay. */

  it('refuses an unauthenticated read of one person\'s achievements', async () => {
    const res = await srv.call('GET', `/api/users/${STUDENT}/badges`);
    expect(res.status).toBe(401);
    // The refusal must not carry the payload it is refusing.
    expect(res.body?.badges).toBeUndefined();
    expect(JSON.stringify(res.body ?? {})).not.toContain('earned_at');
  });

  it('answers 404 for the retired catalogue route', async () => {
    /* Pinned rather than merely deleted: a route that comes back by accident —
       a revert, a bad merge — should fail here rather than quietly start
       serving the definition list to every session again. */
    const token = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', '/api/badges', undefined, token);
    expect(res.status).toBe(404);
  });

  it('serves a volunteer\'s achievements to a signed-in caller, matching the profile page it renders on', async () => {
    const token = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', `/api/users/${STUDENT}/badges`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.badges.length).toBeGreaterThan(0);
    expect(res.body.badges[0].earned_at).toBeTruthy();
  });
});
