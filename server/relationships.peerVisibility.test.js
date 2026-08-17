import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Peer eligibility gates DISCLOSURE, not only creation.
 *
 * ── The gap this closes ──
 *
 * Friendship became peer-only: `requestFriend` and `acceptFriend` both refuse a
 * pair where either side lacks `event.apply`. That stops any NEW organizer↔
 * student friendship from existing.
 *
 * It does nothing about one that already does. A row accepted before the rule
 * shipped carries `status = 'accepted'`, and every write-path check has already
 * run and passed for it — so the only thing between it and that student's
 * school, grade and bio was `areFriends`, which asked about the row and about
 * blocking and nothing else. Gating creation while leaving disclosure open
 * preserves exactly the exposure the rule was written to remove, silently, on
 * any database old enough to contain such a row.
 *
 * These cases therefore write the legacy row DIRECTLY, bypassing the routes,
 * because that is the only way to reproduce a database that predates the rule —
 * and it is the state the fix has to survive.
 */
describe('friend-tier visibility is peer-only', () => {
  let srv, db, areFriends;
  let organizerId, aliceId, bobId, carolId;
  let alice, bob;

  const PASSWORD = 'Password123';

  /** Writes an accepted friendship straight into the table, as a pre-rule build would. */
  const forceAcceptedFriendship = async (id, actorId, subjectId) => {
    await db.prepare('DELETE FROM user_relationships WHERE id = ?').run(id);
    await db.prepare(`
      INSERT INTO user_relationships (id, actor_id, subject_id, kind, status, created_at)
      VALUES (?, ?, ?, 'friend', 'accepted', datetime('now'))
    `).run(id, actorId, subjectId);
  };

  const drop = async (id) => await db.prepare('DELETE FROM user_relationships WHERE id = ?').run(id);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    ({ areFriends } = await import('./relationships.js'));

    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?')
      .get('jordan.whitfield@example.org')).id;

    const make = async (name, username) => {
      const r = await srv.signupConfirmed({
        name, username, email: `${username}@peervis.example.org`,
        grade: '11', role: 'student', password: PASSWORD,
      });
      return { token: r.cookie, id: r.user.id };
    };
    const a = await make('Ada Peer', 'ada_peer');
    const b = await make('Ben Peer', 'ben_peer');
    const c = await make('Cleo Peer', 'cleo_peer');
    alice = a.token; aliceId = a.id;
    bob = b.token; bobId = b.id;
    carolId = c.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /* ── The case the feature exists for ──────────────────────────────────── */

  it('grants friend visibility between two students', async () => {
    await forceAcceptedFriendship('rel-peer-ok', aliceId, bobId);
    expect(await areFriends(db, aliceId, bobId)).toBe(true);
    expect(await areFriends(db, bobId, aliceId), 'direction must not matter').toBe(true);
    await drop('rel-peer-ok');
  });

  /* ── The legacy rows ──────────────────────────────────────────────────── */

  /**
   * The whole point. This row is indistinguishable from a legitimate one at the
   * table level — it is only the CURRENT eligibility of the two accounts that
   * disqualifies it.
   */
  it('refuses a legacy accepted organizer→student friendship', async () => {
    await forceAcceptedFriendship('rel-legacy-org-student', organizerId, aliceId);
    expect(await areFriends(db, organizerId, aliceId)).toBe(false);
    expect(await areFriends(db, aliceId, organizerId)).toBe(false);
    await drop('rel-legacy-org-student');
  });

  it('refuses it in the other direction too', async () => {
    await forceAcceptedFriendship('rel-legacy-student-org', aliceId, organizerId);
    expect(await areFriends(db, aliceId, organizerId)).toBe(false);
    expect(await areFriends(db, organizerId, aliceId)).toBe(false);
    await drop('rel-legacy-student-org');
  });

  /**
   * And the refusal reaches the profile, which is where the exposure would
   * actually have landed: `profile_visibility = 'friends'` hands over school,
   * grade and bio to anyone `areFriends` calls a friend.
   */
  it('withholds the friends-only tier from a legacy non-peer relationship', async () => {
    await db.prepare("UPDATE users SET profile_visibility = 'friends' WHERE id = ?").run(aliceId);
    await forceAcceptedFriendship('rel-legacy-profile', organizerId, aliceId);

    const organizerToken = await srv.login('jordan.whitfield@example.org');
    const res = await srv.call('GET', `/api/users/${aliceId}`, undefined, organizerToken);

    /* Whatever the endpoint chooses to return, it must not be the friends-only
       fields. Asserted on the payload rather than on a status code, because a
       200 that carries `school` is the failure this exists to catch. */
    expect(res.body?.profile?.school ?? null).toBeNull();
    expect(res.body?.profile?.grade ?? null).toBeNull();

    await drop('rel-legacy-profile');
    await db.prepare("UPDATE users SET profile_visibility = 'private' WHERE id = ?").run(aliceId);
  });

  /* ── Blocking still wins ──────────────────────────────────────────────── */

  it('refuses friend visibility when one side has blocked the other', async () => {
    await forceAcceptedFriendship('rel-blocked', aliceId, bobId);
    await db.prepare(`
      INSERT INTO user_blocks (id, blocker_id, blocked_id, created_at)
      VALUES ('blk-peervis', ?, ?, datetime('now'))
    `).run(aliceId, bobId);

    expect(await areFriends(db, aliceId, bobId)).toBe(false);
    expect(await areFriends(db, bobId, aliceId)).toBe(false);

    await db.prepare("DELETE FROM user_blocks WHERE id = 'blk-peervis'").run();
    expect(await areFriends(db, aliceId, bobId), 'unblocking restores it').toBe(true);
    await drop('rel-blocked');
  });

  /* ── Removal ──────────────────────────────────────────────────────────── */

  it('grants nothing once the friendship row is gone', async () => {
    await forceAcceptedFriendship('rel-removal', aliceId, bobId);
    expect(await areFriends(db, aliceId, bobId)).toBe(true);

    const res = await srv.call('DELETE', `/api/users/${bobId}/friend`, undefined, alice);
    expect(res.status).toBe(200);
    expect(await areFriends(db, aliceId, bobId)).toBe(false);
  });

  /* ── Degenerate inputs ────────────────────────────────────────────────── */

  it('grants nothing for a missing account, self, or null', async () => {
    await forceAcceptedFriendship('rel-degenerate', aliceId, bobId);
    expect(await areFriends(db, aliceId, aliceId), 'self').toBe(false);
    expect(await areFriends(db, aliceId, 'no-such-user'), 'missing subject').toBe(false);
    expect(await areFriends(db, 'no-such-user', bobId), 'missing actor').toBe(false);
    expect(await areFriends(db, null, bobId), 'null').toBe(false);
    await drop('rel-degenerate');
  });

  /**
   * A pending row was never a friendship and must not become one by being
   * looked at. Guards the read side against the same mistake the write side
   * already refuses.
   */
  it('grants nothing for a pending request between peers', async () => {
    await db.prepare(`
      INSERT INTO user_relationships (id, actor_id, subject_id, kind, status, created_at)
      VALUES ('rel-pending', ?, ?, 'friend', 'pending', datetime('now'))
    `).run(bobId, carolId);
    expect(await areFriends(db, bobId, carolId)).toBe(false);
    await drop('rel-pending');
  });

  /* ── The ordinary path is untouched ───────────────────────────────────── */

  it('still lets two students befriend each other through the real routes', async () => {
    const request = await srv.call('POST', `/api/users/${carolId}/friend`, undefined, bob);
    expect([200, 201]).toContain(request.status);

    /* The fixture was created with PASSWORD, not the seeded accounts' default
       that `srv.login` assumes. */
    const carolToken = await srv.login('cleo_peer@peervis.example.org', PASSWORD);
    const accept = await srv.call('POST', `/api/users/${bobId}/friend/accept`, undefined, carolToken);
    expect(accept.status).toBe(200);

    expect(await areFriends(db, bobId, carolId)).toBe(true);
  });
});
