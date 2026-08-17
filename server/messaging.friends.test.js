import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Friends may message each other; being able to SEE somebody grants nothing.
 *
 * ── What this suite is guarding ──
 *
 * Member-to-member messaging is the first feature on this platform where one
 * student can open a channel to another student. Every existing thread required
 * either a shared event (an organizer and an applicant) or a moderation
 * capability, both of which are relationships somebody else established. This
 * one is established by the two participants, so the gate around it is the only
 * thing standing between "message your friend" and "message any minor whose
 * profile you can load".
 *
 * The gate is `areFriends`, and it is deliberately the SAME function that decides
 * whether the friends-only profile tier opens. These cases exist mostly to prove
 * the two cannot drift apart: a second definition of "friend" would be silent,
 * and the half that was wrong would be the messaging half.
 *
 * ── Why so much of this is about what is NOT allowed ──
 *
 * The permitted cases are one endpoint returning 200. The forbidden ones are
 * where the product actually lives: search results, public profiles, stale
 * clients, guessed ids, and relationships that used to exist. Each of those is a
 * different door to the same room, and closing the front one proves nothing
 * about the rest.
 */
describe('friend messaging', () => {
  let srv, db;
  let ada, ben, cleo;            // students
  let organizerToken, organizerId;

  const PASSWORD = 'Password123';

  const make = async (name, username) => {
    const r = await srv.signupConfirmed({
      name, username, email: `${username}@friendmsg.example.org`,
      grade: '11', role: 'student', password: PASSWORD,
    });
    return { token: r.cookie, id: r.user.id, name, username };
  };

  /** Drives the real friend endpoints, so the rows are the ones the app writes. */
  const befriend = async (a, b) => {
    await srv.call('POST', `/api/users/${b.id}/friend`, {}, a.token);
    await srv.call('POST', `/api/users/${a.id}/friend/accept`, {}, b.token);
  };

  const unfriend = (a, b) => srv.call('DELETE', `/api/users/${b.id}/friend`, undefined, a.token);

  const openPeer = (actor, target) =>
    srv.call('POST', '/api/messages/conversations/peer/resolve', { userId: target.id }, actor.token);

  const send = (actor, convId, body = 'Hello there') =>
    srv.call('POST', `/api/messages/conversations/${convId}/messages`, { body }, actor.token);

  const readThread = (actor, convId) =>
    srv.call('GET', `/api/messages/conversations/${convId}/messages`, undefined, actor.token);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    ada = await make('Ada Friend', 'ada_friend');
    ben = await make('Ben Friend', 'ben_friend');
    cleo = await make('Cleo Friend', 'cleo_friend');

    organizerToken = await srv.login('jordan.whitfield@example.org');
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?')
      .get('jordan.whitfield@example.org')).id;
  });

  afterAll(async () => { await srv.close(); });

  /* ──────────────────────────────────────────────────────────────────────────
   * Friends
   * ────────────────────────────────────────────────────────────────────────── */

  describe('two friends', () => {
    let convId;

    beforeAll(async () => { await befriend(ada, ben); });

    it('lets either of them open the thread, and it is the SAME thread', async () => {
      const fromAda = await openPeer(ada, ben);
      expect(fromAda.status).toBe(200);
      convId = fromAda.body.conversation.id;

      /**
       * The direction-independence claim, tested rather than assumed.
       *
       * `pair_key` is `min:max` precisely so that B→A resolves to the row A→B
       * created. If it did not, each friend would hold a different thread, both
       * would look like they worked, and each would see only their own half of
       * the conversation — the failure mode migration 035's header describes and
       * the reason the key is not `created_by`.
       */
      const fromBen = await openPeer(ben, ada);
      expect(fromBen.status).toBe(200);
      expect(fromBen.body.conversation.id).toBe(convId);
    });

    it('opens it as a peer thread with no event and no role columns set', async () => {
      const row = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
      expect(row.kind).toBe('peer');
      expect(row.event_id).toBeNull();
      /* Neither friend is seated in a column that would describe them as
         somebody they are not. Membership is the participant rows. */
      expect(row.student_id).toBeNull();
      expect(row.organizer_id).toBeNull();
      expect(row.pair_key).toBe([ada.id, ben.id].sort().join(':'));
    });

    it('is writable, with no event lifecycle applied to it', async () => {
      const res = await readThread(ada, convId);
      expect(res.status).toBe(200);
      expect(res.body.conversation.lifecycle.writable).toBe(true);
      expect(res.body.conversation.event).toBeNull();
    });

    it('carries messages in both directions', async () => {
      expect((await send(ada, convId, 'Are you going Saturday?')).status).toBe(201);
      expect((await send(ben, convId, 'Yes — see you there')).status).toBe(201);

      const res = await readThread(ben, convId);
      expect(res.status).toBe(200);
      expect(res.body.messages.map(m => m.body)).toEqual([
        'Are you going Saturday?',
        'Yes — see you there',
      ]);
    });

    it('shows up in each friend\'s conversation list', async () => {
      for (const who of [ada, ben]) {
        const res = await srv.call('GET', '/api/messages/conversations', undefined, who.token);
        expect(res.status).toBe(200);
        expect(res.body.conversations.map(c => c.id)).toContain(convId);
      }
    });

    it('tracks unread the same way every other thread does', async () => {
      const convo = (await srv.call('GET', '/api/messages/conversations', undefined, ada.token)).body.conversations.find(c => c.id === convId);
      /* Ada sent the first message and Ben answered, so Ben's reply is unread
         for her — the sender's own send marks their side read. */
      expect(convo.unreadCount).toBe(1);

      const last = convo.lastMessage.id;
      expect((await srv.call('POST', `/api/messages/conversations/${convId}/read`,
        { messageId: last }, ada.token)).status).toBe(200);

      const after = (await srv.call('GET', '/api/messages/conversations', undefined, ada.token)).body.conversations.find(c => c.id === convId);
      expect(after.unreadCount).toBe(0);
    });

    it('is findable in message search, which used to drop every eventless thread',
      async () => {
        const res = await srv.call('GET', '/api/messages/search?q=Saturday', undefined, ada.token);
        expect(res.status).toBe(200);
        expect(res.body.results.map(r => r.message.body)).toContain('Are you going Saturday?');
      });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Not friends
   * ────────────────────────────────────────────────────────────────────────── */

  describe('two students who are not friends', () => {
    it('refuses to open a thread', async () => {
      const res = await openPeer(ada, cleo);
      expect(res.status).toBe(403);
      /* Names the rule, not the person. See resolvePeerConversation: a distinct
         404 for "no such user" would make this endpoint an existence oracle. */
      expect(res.body.error).toMatch(/friends/i);
    });

    it('answers a nonexistent id exactly as it answers a stranger', async () => {
      const stranger = await openPeer(ada, { id: 'user-does-not-exist' });
      const real = await openPeer(ada, cleo);
      expect(stranger.status).toBe(real.status);
      expect(stranger.body.error).toBe(real.body.error);
    });

    it('refuses a PENDING request — asking is not agreeing', async () => {
      await srv.call('POST', `/api/users/${cleo.id}/friend`, {}, ada.token);
      const pending = await db.prepare(`
        SELECT status FROM user_relationships
        WHERE actor_id = ? AND subject_id = ? AND kind = 'friend'
      `).get(ada.id, cleo.id);
      expect(pending.status).toBe('pending');

      expect((await openPeer(ada, cleo)).status).toBe(403);
      /* ...and not from the other side either, which is the direction somebody
         would try if a pending request were mistaken for a friendship. */
      expect((await openPeer(cleo, ada)).status).toBe(403);

      await unfriend(ada, cleo);
    });

    it('refuses a conversation with yourself', async () => {
      const res = await openPeer(ada, ada);
      expect(res.status).toBe(400);
    });

    /**
     * The two capabilities a member holds over strangers, neither of which is
     * consent to be messaged.
     *
     * This is the misunderstanding the whole feature turns on: a search box that
     * returns somebody, or a profile that loads, feels like permission. It is
     * not, and on a platform of minors the gap between "I can see you" and "I can
     * message you" is the safety property.
     */
    it('grants nothing just because the member is searchable', async () => {
      const search = await srv.call('GET', '/api/directory/search?q=Cleo', undefined, ada.token);
      /* The directory finds them — that part is meant to work. */
      expect(search.status).toBe(200);
      expect(JSON.stringify(search.body)).toContain(cleo.id);

      expect((await openPeer(ada, cleo)).status).toBe(403);
    });

    it('grants nothing just because the public profile is readable', async () => {
      const profile = await srv.call('GET', `/api/users/${cleo.id}/public-profile`,
        undefined, ada.token);
      expect(profile.status).toBe(200);

      expect((await openPeer(ada, cleo)).status).toBe(403);
    });

    it('does not offer a non-friend in the recipient picker', async () => {
      const res = await srv.call('GET', '/api/messages/users/search?q=Cleo',
        undefined, ada.token);
      expect(res.status).toBe(200);
      expect(res.body.users.map(u => u.id)).not.toContain(cleo.id);
    });

    it('does offer a friend in the recipient picker, tagged for the right endpoint',
      async () => {
        const res = await srv.call('GET', '/api/messages/users/search?q=Ben',
          undefined, ada.token);
        const row = res.body.users.find(u => u.id === ben.id);
        expect(row).toBeTruthy();
        /* The client routes on this rather than inferring from a null eventId. */
        expect(row.kind).toBe('friend');
      });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Losing the friendship
   * ────────────────────────────────────────────────────────────────────────── */

  describe('when the friendship ends', () => {
    let dana, eli, convId;

    beforeAll(async () => {
      dana = await make('Dana Friend', 'dana_friend');
      eli = await make('Eli Friend', 'eli_friend');
      await befriend(dana, eli);
      convId = (await openPeer(dana, eli)).body.conversation.id;
      expect((await send(dana, convId, 'before')).status).toBe(201);
    });

    it('closes the EXISTING thread to new messages, in both directions', async () => {
      await unfriend(dana, eli);

      for (const who of [dana, eli]) {
        const res = await send(who, convId, 'after');
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('conversation_read_only');
      }
    });

    it('reports the thread as read-only so the client stops offering a composer',
      async () => {
        const res = await readThread(dana, convId);
        expect(res.status).toBe(200);
        expect(res.body.conversation.lifecycle.writable).toBe(false);
        expect(res.body.conversation.lifecycle.reason).toBe('not_friends');
        /* Says what changed, never who did it — "they unfriended you" is a
           disclosure about somebody else's decision. */
        expect(res.body.conversation.lifecycle.banner).not.toMatch(/unfriend|block/i);
      });

    it('keeps the history readable to both, which is what a report is made of',
      async () => {
        for (const who of [dana, eli]) {
          const res = await readThread(who, convId);
          expect(res.status).toBe(200);
          expect(res.body.messages.map(m => m.body)).toContain('before');
        }
      });

    it('refuses to open a NEW thread as well, not just to write to the old one',
      async () => {
        expect((await openPeer(dana, eli)).status).toBe(403);
      });

    it('reopens on the same thread when they become friends again', async () => {
      await befriend(dana, eli);

      const reopened = await openPeer(dana, eli);
      expect(reopened.status).toBe(200);
      /* The same row, so the history is continuous rather than a second thread
         beside the first. */
      expect(reopened.body.conversation.id).toBe(convId);
      expect((await send(dana, convId, 'again')).status).toBe(201);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Blocking
   * ────────────────────────────────────────────────────────────────────────── */

  describe('blocking', () => {
    let fay, gus, convId;

    beforeAll(async () => {
      fay = await make('Fay Friend', 'fay_friend');
      gus = await make('Gus Friend', 'gus_friend');
      await befriend(fay, gus);
      convId = (await openPeer(fay, gus)).body.conversation.id;
      await send(fay, convId, 'before the block');
      await srv.call('POST', `/api/blocks/${gus.id}`, {}, fay.token);
    });

    it('severs an existing thread for the blocker AND the blocked', async () => {
      for (const who of [fay, gus]) {
        expect((await send(who, convId, 'after')).status).toBe(409);
      }
    });

    it('refuses a new thread in either direction', async () => {
      expect((await openPeer(fay, gus)).status).toBe(403);
      /* The blocked party gets the identical refusal a stranger gets, so the
         response does not tell them they have been blocked. */
      expect((await openPeer(gus, fay)).status).toBe(403);
    });

    it('withdrew the friendship, so the two rules cannot disagree', async () => {
      const row = await db.prepare(`
        SELECT 1 FROM user_relationships WHERE kind = 'friend'
          AND ((actor_id = ? AND subject_id = ?) OR (actor_id = ? AND subject_id = ?))
      `).get(fay.id, gus.id, gus.id, fay.id);
      expect(row).toBeUndefined();
    });

    it('restores nothing on unblock alone — the friendship has to be remade',
      async () => {
        await srv.call('DELETE', `/api/blocks/${gus.id}`, undefined, fay.token);
        expect((await openPeer(fay, gus)).status).toBe(403);

        await befriend(fay, gus);
        expect((await openPeer(fay, gus)).status).toBe(200);
      });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Legacy and non-peer rows
   * ────────────────────────────────────────────────────────────────────────── */

  describe('relationship rows that do not mean what they appear to', () => {
    /**
     * An accepted organizer↔student friendship, written straight into the table.
     *
     * This is the state `relationships.peerVisibility.test.js` exists for: a row
     * created before friendship became peer-only. Every write-path check has
     * already run and passed for it, so the ONLY thing between it and a
     * fourteen-year-old's private messages with an adult who supervises them is
     * `areFriends`. Written by SQL because that is the only way to produce a
     * database that predates the rule — and it is the state the fix has to
     * survive.
     */
    it('does not let a legacy organizer↔student friendship unlock messaging', async () => {
      await db.prepare(`
        INSERT INTO user_relationships (id, actor_id, subject_id, kind, status, created_at)
        VALUES ('rel-legacy-msg', ?, ?, 'friend', 'accepted', datetime('now'))
      `).run(organizerId, ada.id);

      try {
        expect((await openPeer(ada, { id: organizerId })).status).toBe(403);

        const asOrganizer = await srv.call('POST', '/api/messages/conversations/peer/resolve',
          { userId: ada.id }, organizerToken);
        expect(asOrganizer.status).toBe(403);
      } finally {
        await db.prepare("DELETE FROM user_relationships WHERE id = 'rel-legacy-msg'").run();
      }
    });

    it('does not let a restrict-withdrawn friendship keep the thread open', async () => {
      const hana = await make('Hana Friend', 'hana_friend');
      await befriend(ada, hana);
      const convId = (await openPeer(ada, hana)).body.conversation.id;

      /* Restricting withdraws the friendship row (relationships.js), so this is
         the same closure an unfriend produces — asserted because "restrict" and
         "unfriend" are different buttons and only one of them is obviously
         about messaging. */
      await srv.call('POST', `/api/users/${hana.id}/restrict`, {}, ada.token);

      expect((await send(ada, convId)).status).toBe(409);
      expect((await send(hana, convId)).status).toBe(409);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Bypasses
   * ────────────────────────────────────────────────────────────────────────── */

  describe('the backend is authoritative', () => {
    it('refuses a guessed conversation id to a non-participant', async () => {
      await befriend(ada, ben);
      const convId = (await openPeer(ada, ben)).body.conversation.id;

      /* Cleo is a real, signed-in member who is simply not in this thread.
         404 rather than 403: confirming the id exists would let somebody walk
         ids and learn which conversations are real. */
      expect((await readThread(cleo, convId)).status).toBe(404);
      expect((await send(cleo, convId)).status).toBe(404);
    });

    it('ignores a body that names somebody other than the caller', async () => {
      /**
       * The stale-client and forged-body case in one.
       *
       * `studentId` is a field the EVENT resolve endpoint reads, and a client
       * holding a stale idea of how to open a thread might send it here. The peer
       * endpoint derives the actor from the session and reads only `userId`, so
       * the extra field changes nothing — and the friendship rule still decides.
       */
      const res = await srv.call('POST', '/api/messages/conversations/peer/resolve',
        { userId: cleo.id, studentId: ben.id, eventId: 'evt-anything' }, ada.token);
      expect(res.status).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await srv.call('POST', '/api/messages/conversations/peer/resolve',
        { userId: ben.id });
      expect(res.status).toBe(401);
    });

    it('rejects a missing or non-string target rather than guessing', async () => {
      for (const userId of [undefined, null, 42, { id: ben.id }, ['x']]) {
        const res = await srv.call('POST', '/api/messages/conversations/peer/resolve',
          { userId }, ada.token);
        expect(res.status).toBe(400);
      }
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Nothing was narrowed
   * ────────────────────────────────────────────────────────────────────────── */

  describe('the existing messaging paths are unchanged', () => {
    let eventId, slotId;

    beforeAll(async () => {
      const start = new Date(Date.now() + 20 * 864e5).toISOString();
      const end = new Date(Date.now() + 20 * 864e5 + 108e5).toISOString();
      const mk = await srv.call('POST', '/api/events', {
        title: 'Friend Messaging Control Event', description: 'd', category: 'Other',
        location: 'Hall', applicationDeadline: start,
        slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 3 }],
      }, organizerToken);
      eventId = mk.body.id;
      slotId = (await srv.call('GET', '/api/events', undefined, organizerToken)).body.find(e => e.id === eventId).slots[0].id;
      await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, cleo.token);
    });

    it('student → organizer on a shared event still works', async () => {
      const res = await srv.call('POST', '/api/messages/conversations/resolve',
        { eventId, studentId: cleo.id }, cleo.token);
      expect(res.status).toBe(200);
      expect(res.body.conversation.kind).toBe('student_organizer');
      expect((await send(cleo, res.body.conversation.id)).status).toBe(201);
    });

    it('organizer → student on their own event still works', async () => {
      const res = await srv.call('POST', '/api/messages/conversations/resolve',
        { eventId, studentId: cleo.id }, organizerToken);
      expect(res.status).toBe(200);
      const convId = res.body.conversation.id;
      expect((await srv.call('POST', `/api/messages/conversations/${convId}/messages`,
        { body: 'See you Saturday' }, organizerToken)).status).toBe(201);
    });

    it('an organizer cannot reach an arbitrary student through the peer endpoint',
      async () => {
        /**
         * The narrowing that matters most.
         *
         * An organizer holds `message.send`, so the route's capability gate lets
         * them in. What stops them is the peer rule inside — `areFriends` requires
         * BOTH parties to hold `event.apply`, which an organizer does not. If this
         * ever returns 200, the endpoint has become a way for an adult to open a
         * private channel to any student on the platform.
         */
        const res = await srv.call('POST', '/api/messages/conversations/peer/resolve',
          { userId: cleo.id }, organizerToken);
        expect(res.status).toBe(403);
      });

    it('an event thread still goes read-only on its own lifecycle rules', async () => {
      /* The peer branch returns early in computeConversationLifecycle, so this
         confirms it did not shadow the event rules on the way past. */
      const res = await srv.call('POST', '/api/messages/conversations/resolve',
        { eventId, studentId: cleo.id }, cleo.token);
      const convId = res.body.conversation.id;

      await db.prepare("UPDATE events SET status = 'completed' WHERE id = ?").run(eventId);
      await db.prepare('UPDATE slots SET end_datetime = ? WHERE event_id = ?')
        .run(new Date(Date.now() - 40 * 864e5).toISOString(), eventId);

      expect((await send(cleo, convId)).status).toBe(409);
    });
  });
});
