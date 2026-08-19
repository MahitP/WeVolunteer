import express from 'express';
import { caseInsensitiveLike } from '../db/dialectSql.js';
import { authenticateToken } from '../utils.js';
import { runInTransaction } from '../db/connectionContext.js';
import { reportLimiter } from '../reportLimiter.js';
import { createReport } from '../reportService.js';
import { can, requireCap, principalFor } from '../authz.js';
import { grantsFor } from '../userCapabilities.js';
import { isBlockedBetween, block, unblock } from '../blocking.js';
/* Blocking withdraws the friendship, exactly as restricting does — see the note
   in the block handler below. `areFriends` is the same single source of truth
   `resolvePeerConversation` authorises on; the recipient search filters through
   it so the picker cannot offer a row that would answer 403 when tapped. */
import { areFriends, removeFriend } from '../relationships.js';
import { notificationService } from '../services/notificationService.js';
import { emitToUser } from '../realtime/events.js';
import { db } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { MESSAGE_MAX_LENGTH, MESSAGE_PAGE_LIMIT, computeConversationLifecycle, decorateConversation, formatMessage, getConversation, getParticipant, isConversationParticipant, listConversationsForUser, newId, otherParticipant, resolveAdminConversation, resolveConversation, resolvePeerConversation } from '../messaging.js';

const router = express.Router();

const sendBuckets = new Map();
function checkMessageRateLimit(userId) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 20;
  const bucket = (sendBuckets.get(userId) || []).filter(ts => now - ts < windowMs);
  if (bucket.length >= limit) {
    sendBuckets.set(userId, bucket);
    return false;
  }
  bucket.push(now);
  sendBuckets.set(userId, bucket);

  // Opportunistic sweep to prevent unbounded growth from stale buckets
  if (sendBuckets.size > 5000) {
    for (const [k, v] of sendBuckets) {
      const active = v.filter(ts => now - ts < windowMs);
      if (active.length === 0) sendBuckets.delete(k);
      else sendBuckets.set(k, active);
    }
    // Force eviction if still too large
    if (sendBuckets.size > 5000) {
      for (const k of sendBuckets.keys()) {
        sendBuckets.delete(k);
        if (sendBuckets.size <= 4000) break;
      }
    }
  }

  return true;
}

async function participantIds(conversationId) {
  return (await db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ?')
    .all(conversationId)).map(r => r.user_id);
}

router.get('/api/messages/conversations', authenticateToken, async (req, res) => {
  try {
    const conversations = await listConversationsForUser(req.user.id);
    const unreadTotal = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
    res.json({ conversations, unreadTotal });
  } catch (err) {
    console.error('Messages conversations list error:', err);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

router.post('/api/messages/conversations/resolve', authenticateToken, async (req, res) => {
  try {
    const { eventId, studentId } = req.body;
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });

    const result = await resolveConversation({ eventId, studentId, actor: req.user, principal: req.principal });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    res.status(200).json({ conversation: result.conversation });
  } catch (err) {
    console.error('Resolve conversation error:', err);
    res.status(500).json({ error: 'Failed to open conversation' });
  }
});

/**
 * Opens (or reopens) the thread between the caller and one of their friends.
 *
 * ── Why this is a separate endpoint from `/resolve` ──
 *
 * Same reason the admin one below is: `/resolve` derives a (student, organizer,
 * event) triple from an event id and checks the caller's relationship to that
 * event. A peer thread has no event and names the counterparty directly, so
 * every branch of that handler would have had to ask which mode it was in.
 *
 * ── Gated on `message.send`, and then on friendship ──
 *
 * `message.send` is the capability that means "this account participates in
 * conversations", which is the right coarse gate — a partner holds neither it nor
 * `event.apply` and is refused here before any relationship is read.
 *
 * It is deliberately NOT sufficient on its own, and that is the whole design: an
 * organizer holds `message.send` too. What narrows this to friends is
 * `areFriends` inside `resolvePeerConversation`, which requires BOTH parties to
 * hold `event.apply` — so an organizer calling this endpoint directly is refused
 * by the peer rule rather than by a role comparison here. There is no role string
 * in this handler, and `authz.completeness.test.js` would fail the build if there
 * were.
 *
 * ── No audit row, unlike the admin endpoint below ──
 *
 * That one records `ADMIN_CONVERSATION_OPENED` because an administrator opening a
 * line to a member is a use of power a person might later ask about. Two friends
 * choosing to talk is not, and writing a row every time one of them opens a chat
 * would put ordinary teenage conversation into a moderation log with a broader
 * audience than the conversation has.
 */
router.post('/api/messages/conversations/peer/resolve', authenticateToken,
  requireCap('message.send'), async (req, res) => {
    try {
      const { userId } = req.body || {};
      const result = await resolvePeerConversation({ actor: req.user, friendId: userId });
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.status(200).json({ conversation: result.conversation });
    } catch (err) {
      console.error('Resolve peer conversation error:', err);
      res.status(500).json({ error: 'Failed to open conversation' });
    }
  });

/**
 * Opens (or reopens) an administrator's own thread with one person.
 *
 * ── Why this is a separate endpoint ──
 *
 * `/resolve` derives a (student, organizer, event) triple from an event id and
 * checks the caller's relationship to it. This has no event and names the
 * counterparty directly, so every branch of that handler would have had to ask
 * which mode it was in.
 *
 * ── Gated on `report.resolve`, not `message.send` ──
 *
 * `message.send` is what lets somebody participate in a conversation, and students
 * and organizers hold it. What this endpoint does is different and stronger: it
 * lets the caller open a channel to a person they have no event in common with,
 * chosen by id. That is a moderation power, so it is gated on the moderation
 * capability — an organizer holding `message.send` must not be able to reach an
 * arbitrary student through it.
 */
router.post('/api/messages/admin/conversations/resolve', authenticateToken,
  requireCap('report.resolve'), async (req, res) => {
    try {
      const { userId } = req.body || {};
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
      }

      /**
       * The counterparty's principal is built with their per-user grants, because
       * `adminThreadKind` asks what they can DO rather than what role they hold —
       * a student granted `event.create` is an organizer for the purpose of which
       * thread shape applies to them.
       */
      const target = await db.prepare(
        "SELECT id, role FROM users WHERE id = ? AND account_status != 'deleted'"
      ).get(userId);
      if (!target) return res.status(404).json({ error: 'Person not found' });

      const counterpartyPrincipal = principalFor(target, { grants: await grantsFor(db, target.id) });

      const result = await resolveAdminConversation({
        actor: req.user, counterpartyId: userId, counterpartyPrincipal,
      });
      if (!result.ok) return res.status(result.status).json({ error: result.error });

      /**
       * Recorded when the channel is opened, not only when a message is sent.
       *
       * "An administrator opened a line to this student" is the fact worth having
       * on the record — it is the act that a person who has done nothing wrong
       * might reasonably ask about later. The message bodies are deliberately NOT
       * copied here: `admin_audit_logs` has a broader audience than the
       * conversation does, and the same reasoning the report trail uses for
       * resolution notes applies unchanged.
       */
      // Read as prose, not as an enum. This row is read by a person asking why an
      // administrator contacted a student, and "Opened a admin_student thread" is
      // the sort of thing that makes a record look machine-generated and unread.
      const who = result.conversation.kind === 'admin_organizer' ? 'organizer' : 'student';

      await recordAudit(db, {
        adminId: req.user.id,
        action: 'ADMIN_CONVERSATION_OPENED',
        targetUserId: userId,
        details: `Opened a moderation conversation with a ${who} (${result.conversation.id})`,
      });

      res.status(200).json({ conversation: result.conversation });
    } catch (err) {
      console.error('Resolve admin conversation error:', err);
      res.status(500).json({ error: 'Failed to open conversation' });
    }
  });

router.get('/api/messages/conversations/:id/messages', authenticateToken, async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!await isConversationParticipant(conversation.id, req.user.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const limit = Math.min(MESSAGE_PAGE_LIMIT, Math.max(1, Number(req.query.limit) || MESSAGE_PAGE_LIMIT));
    const before = req.query.before;
    let rows;
    if (before) {
      const cursor = await db.prepare('SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?')
        .get(before, conversation.id);
      if (!cursor) return res.status(400).json({ error: 'Invalid pagination cursor' });
      rows = await db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ? AND created_at < ?
        ORDER BY created_at DESC LIMIT ?
      `).all(conversation.id, cursor.created_at, limit);
    } else {
      rows = await db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(conversation.id, limit);
    }

    rows.reverse();
    res.json({
      conversation: await decorateConversation(conversation, req.user.id),
      messages: rows.map(formatMessage),
      hasMore: rows.length === limit
    });
  } catch (err) {
    console.error('Messages page error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

router.post('/api/messages/conversations/:id/messages', authenticateToken, async (req, res) => {
  try {
    if (!checkMessageRateLimit(req.user.id)) {
      return res.status(429).json({
        error: 'Too many messages sent too quickly. Please pause for a minute.',
        code: 'rate_limited'
      });
    }

    const conversation = await getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!await isConversationParticipant(conversation.id, req.user.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    /**
     * A block closes an EXISTING conversation, not just the opening of a new one.
     *
     * `eligibleRelationship` guards `resolve`, which is only reached when a
     * conversation is first opened — an already-open thread never passes
     * through it again. Without this check, blocking would silently do nothing
     * for the only case that matters: the conversation the student is currently
     * in, with the person they want to stop hearing from.
     *
     * Deliberately placed BEFORE the lifecycle check so a blocked sender is
     * refused whether or not the thread is still writable, and phrased as the
     * generic read-only refusal so the block is not announced back to the
     * blocked party.
     */
    const other = await otherParticipant(conversation.id, req.user.id);
    if (other && !can(req.principal, 'event.moderate') && await isBlockedBetween(db, req.user.id, other.id)) {
      return res.status(409).json({
        error: 'This conversation is read-only.',
        code: 'conversation_read_only'
      });
    }

    if (conversation.event_id && !can(req.principal, 'event.moderate')) {
      const isStudent = await db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? AND role_at_creation = ?').get(conversation.id, req.user.id, 'student');
      if (isStudent) {
        const event = await db.prepare('SELECT organization_id FROM events WHERE id = ?').get(conversation.event_id);
        if (event && event.organization_id) {
          const ban = await db.prepare('SELECT 1 FROM organization_bans WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL').get(event.organization_id, req.user.id);
          if (ban) {
            return res.status(403).json({
              error: 'You cannot send messages to this organization while banned.',
              code: 'banned'
            });
          }
        }
      }
    }

    const lifecycle = await computeConversationLifecycle(conversation, new Date());
    if (!lifecycle.writable) {
      return res.status(409).json({
        error: 'This conversation is read-only.',
        code: 'conversation_read_only',
        lifecycle
      });
    }

    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
    if (body.length > MESSAGE_MAX_LENGTH) {
      return res.status(400).json({ error: `Message is too long (max ${MESSAGE_MAX_LENGTH} characters)` });
    }

    const messageId = newId('msg');
    const now = new Date().toISOString();
    let message;

    await runInTransaction(db, async (tx) => {
      await tx.prepare(`
        INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(messageId, conversation.id, req.user.id, body, now);
      await tx.prepare(`
        UPDATE conversations
        SET last_message_id = ?, last_message_at = ?, lifecycle_state = ?, read_only_reason = ?, read_only_at = ?
        WHERE id = ?
      `).run(messageId, now, lifecycle.state, lifecycle.reason, lifecycle.readOnlyAt || null, conversation.id);
      await tx.prepare(`
        UPDATE conversation_participants
        SET last_read_message_id = ?, last_read_at = ?
        WHERE conversation_id = ? AND user_id = ?
      `).run(messageId, now, conversation.id, req.user.id);
      message = await tx.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    });

    const recipients = (await participantIds(conversation.id)).filter(id => id !== req.user.id);
    const sender = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
    const decorated = await decorateConversation(await getConversation(conversation.id), req.user.id);
    const payload = { message: formatMessage(message), conversation: decorated };

    for (const userId of recipients) {
      const participant = await getParticipant(conversation.id, userId);
      const muted = participant?.muted_until && new Date(participant.muted_until) > new Date();
      if (!muted) {
        /**
         * The context line names what the thread is, and a moderation thread is
         * not "Volunteer conversation".
         *
         * The fallback used to be reached only by an event-scoped thread whose
         * event had been deleted, where it was a reasonable thing to say. An admin
         * thread has no event by design, so without this every message from an
         * administrator would arrive labelled as being about a volunteer
         * opportunity — which is exactly what it is not, and is misleading in the
         * one case where the recipient most needs to know who is contacting them
         * and why.
         */
        /**
         * A peer thread is neither, and the two-branch version got it badly
         * wrong: anything that was not `student_organizer` fell to the
         * administrator line, so a message from a school friend would have
         * arrived labelled as contact from platform staff. That is alarming in
         * the exact way a notification must not be, and it misidentifies who is
         * getting in touch — the one thing the context line exists to say.
         */
        const CONTEXT_BY_KIND = {
          student_organizer: decorated.event?.title || 'Volunteer conversation',
          peer: 'Message from a friend',
        };
        const context = CONTEXT_BY_KIND[decorated.kind]
          ?? 'Message from a WeVolunteer administrator';

        await notificationService.dispatch('DIRECT_MESSAGE', {
          title: `New message from ${sender?.name || 'Someone'}`,
          body: `${context}: ${body.slice(0, 120)}`,
          link: `/messages?conversation=${conversation.id}`
        }, userId);
      }
      emitToUser(userId, 'message.created', message.id, payload);
    }
    emitToUser(req.user.id, 'message.created', message.id, payload);

    res.status(201).json(payload);
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

router.post('/api/messages/conversations/:id/read', authenticateToken, async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!await isConversationParticipant(conversation.id, req.user.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messageId = req.body.messageId || conversation.last_message_id;
    if (!messageId) return res.json({ success: true });
    const message = await db.prepare('SELECT id, created_at FROM messages WHERE id = ? AND conversation_id = ?')
      .get(messageId, conversation.id);
    if (!message) return res.status(400).json({ error: 'Message not found in this conversation' });

    await db.prepare(`
      UPDATE conversation_participants
      SET last_read_message_id = ?, last_read_at = ?
      WHERE conversation_id = ? AND user_id = ?
    `).run(message.id, message.created_at, conversation.id, req.user.id);

    const payload = {
      conversationId: conversation.id,
      userId: req.user.id,
      lastReadMessageId: message.id,
      lastReadAt: message.created_at
    };
    for (const userId of (await participantIds(conversation.id)).filter(id => id !== req.user.id)) {
      emitToUser(userId, 'conversation.read', conversation.id, payload);
    }
    emitToUser(req.user.id, 'conversation.read', conversation.id, payload);
    res.json({ success: true, ...payload });
  } catch (err) {
    console.error('Mark conversation read error:', err);
    res.status(500).json({ error: 'Failed to update read receipt' });
  }
});

router.patch('/api/messages/conversations/:id/preferences', authenticateToken, async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!await isConversationParticipant(conversation.id, req.user.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const updates = [];
    const values = [];
    const now = new Date().toISOString();
    if (req.body.archived !== undefined) {
      updates.push('archived_at = ?');
      values.push(req.body.archived ? now : null);
    }
    if (req.body.muted !== undefined) {
      updates.push('muted_until = ?');
      values.push(req.body.muted ? '9999-12-31T23:59:59.999Z' : null);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No preferences to update' });
    values.push(conversation.id, req.user.id);
    await db.prepare(`
      UPDATE conversation_participants SET ${updates.join(', ')}
      WHERE conversation_id = ? AND user_id = ?
    `).run(...values);
    res.json({ conversation: await decorateConversation(await getConversation(conversation.id), req.user.id) });
  } catch (err) {
    console.error('Conversation preferences error:', err);
    res.status(500).json({ error: 'Failed to update conversation preferences' });
  }
});

router.get('/api/messages/search', authenticateToken, async (req, res) => {
    /* SQLite's LIKE ignores case, PostgreSQL's does not. Bound per handler
       rather than at module scope: `db` is a proxy whose engine is not
       resolved when this module is imported. */
    const LIKE = caseInsensitiveLike(db);
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const like = `%${q}%`;
    /**
     * `events` is LEFT joined, because not every conversation has one.
     *
     * It was an inner join, which silently dropped every thread whose `event_id`
     * is NULL from search results — a filter nobody wrote and no error reported.
     * That already excluded the admin threads migration 018 introduced, and it
     * would have excluded peer threads entirely: a member could search their
     * messages, match nothing from a friend, and reasonably conclude the search
     * was broken rather than that it had never looked.
     *
     * `event_title` is therefore NULL for those rows, which is what it should be
     * — the client already renders a thread with no event.
     */
    const rows = await db.prepare(`
      SELECT m.*, c.event_id, e.title AS event_title, u.name AS sender_name
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
      LEFT JOIN events e ON e.id = c.event_id
      JOIN users u ON u.id = m.sender_id
      WHERE m.body ${LIKE} ?
      ORDER BY m.created_at DESC
      LIMIT 50
    `).all(req.user.id, like);
    res.json({
      results: rows.map(r => ({
        message: formatMessage(r),
        eventTitle: r.event_title,
        senderName: r.sender_name,
        snippet: r.body.length > 180 ? `${r.body.slice(0, 180)}...` : r.body
      }))
    });
  } catch (err) {
    console.error('Message search error:', err);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

router.post('/api/messages/conversations/:id/report', authenticateToken, reportLimiter, async (req, res) => {
  const reason = String(req.body.reason || '');
  const details = String(req.body.details || '').trim();

  const legacyToCategory = {
    safety: 'something_feels_wrong',
    inappropriate: 'bullying_or_harassment',
    spam: 'spam_or_advertising',
    other: 'other'
  };
  const category = legacyToCategory[reason] || reason;

  const result = await createReport({
    reporter: req.user,
    targetType: 'conversation',
    targetId: req.params.id,
    category,
    description: details
  });

  if (!result.ok) {
    return res.status(result.status || 400).json({ error: result.error, code: result.code });
  }

  res.status(201).json({ success: true, reportId: result.reportId, duplicate: result.duplicate });
});

router.post('/api/messages/:id/report', authenticateToken, reportLimiter, async (req, res) => {
  const reason = String(req.body.reason || '');
  const details = String(req.body.details || '').trim();

  const legacyToCategory = {
    safety: 'something_feels_wrong',
    inappropriate: 'bullying_or_harassment',
    spam: 'spam_or_advertising',
    other: 'other'
  };
  const category = legacyToCategory[reason] || reason;

  const result = await createReport({
    reporter: req.user,
    targetType: 'message',
    targetId: req.params.id,
    category,
    description: details
  });

  if (!result.ok) {
    return res.status(result.status || 400).json({ error: result.error, code: result.code });
  }

  res.status(201).json({ success: true, reportId: result.reportId, duplicate: result.duplicate });
});

router.get('/api/messages/users/search', authenticateToken, async (req, res) => {
    /* SQLite's LIKE ignores case, PostgreSQL's does not. Bound per handler
       rather than at module scope: `db` is a proxy whose engine is not
       resolved when this module is imported. */
    const LIKE = caseInsensitiveLike(db);
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [] });
    const like = `%${q}%`;
    let rows = [];

    // Result scoping, not a gate: every authenticated role reaches this route,
    // and the capability only chooses which query runs.
    //
    // Ordered most-privileged-first, and deliberately: `can()` treats a
    // super_admin principal as satisfying EVERY capability (the '*' wildcard
    // in authz.js), so a wildcard principal always matches whichever branch is
    // tested first. The staff-style query was reached by BOTH `organizer` and
    // `admin` before this conversion (the original condition compared the
    // account's role against both names directly), so the capability check
    // has to cover both too: `applicant.review` is
    // organizer-only in the capability table, so `event.moderate` (admin, and
    // super_admin via the wildcard) is included alongside it — using
    // `applicant.review` alone would have silently narrowed admin out of a
    // query it could reach today, the exact shape of the Task 7b defect this
    // project is guarding against. `application.withdraw` (student
    // self-service) is checked second. Neither branch matching (partner
    // today) falls through to the empty `rows = []` above — never an
    // unscoped `else` that would search every user on the platform.
    if (can(req.principal, 'applicant.review') || can(req.principal, 'event.moderate')) {
      rows = await db.prepare(`
        SELECT DISTINCT u.id, u.name, u.username, u.avatar, u.role,
               'applicant' AS kind, e.id AS "eventId", e.title AS "eventTitle"
        FROM users u
        JOIN applications a ON a.user_id = u.id
        JOIN events e ON a.event_id = e.id
        WHERE e.organizer_id = ?
          AND (u.name ${LIKE} ? OR u.username ${LIKE} ?)
        LIMIT 20
      `).all(req.principal.userId, like, like);
    } else if (can(req.principal, 'application.withdraw')) {
      rows = await db.prepare(`
        SELECT DISTINCT u.id, u.name, u.username, u.avatar, u.role,
               'organizer' AS kind, e.id AS "eventId", e.title AS "eventTitle"
        FROM users u
        JOIN events e ON e.organizer_id = u.id
        JOIN applications a ON a.event_id = e.id
        WHERE a.user_id = ?
          AND (u.name ${LIKE} ? OR u.username ${LIKE} ?)
        LIMIT 20
      `).all(req.principal.userId, like, like);

      /**
       * ...and the caller's friends, which is the other half of who a member may
       * message.
       *
       * ── Why this is a second query and not a UNION ──
       *
       * The organizer query is keyed on an application and carries the event it
       * came from; a friend has no event and the columns would be NULL. Keeping
       * them apart lets each say what it means, and lets the friendship rule be
       * expressed as a filter through `areFriends` rather than as SQL that would
       * be a second definition of "friend".
       *
       * ── The candidate set is deliberately narrow ──
       *
       * Only accounts with an accepted friendship row in either direction, and
       * every one of them is then re-asked through `areFriends`. The row alone is
       * NOT the answer: it does not know about blocking, and it does not know
       * that friendship became peer-only, so a legacy organizer↔student row would
       * otherwise surface somebody this member cannot actually message. Filtering
       * with the same function the resolve endpoint authorises on is what keeps
       * the picker from offering a row that answers 403 when tapped.
       *
       * `kind` tells the client which endpoint to call. Without it the picker
       * would have to infer it from `eventId` being absent, which is the same
       * shape of guess `decorateConversation` refuses to make about `event`.
       */
      const friendCandidates = await db.prepare(`
        SELECT DISTINCT u.id, u.name, u.username, u.avatar, u.role
        FROM users u
        JOIN user_relationships r
          ON r.kind = 'friend' AND r.status = 'accepted'
         AND ((r.actor_id = ? AND r.subject_id = u.id)
           OR (r.subject_id = ? AND r.actor_id = u.id))
        WHERE u.account_status = 'active'
          AND (u.name ${LIKE} ? OR u.username ${LIKE} ?)
        LIMIT 20
      `).all(req.principal.userId, req.principal.userId, like, like);

      /* A loop, not `.filter`: `areFriends` is async now, and `Array.filter`
         does not await — every candidate would have passed the check and the
         search would have returned strangers as friends, which is what opens
         the friends-only tier of a profile. */
      for (const u of friendCandidates) {
        if (await areFriends(db, req.principal.userId, u.id)) {
          rows.push({ ...u, kind: 'friend', eventId: null, eventTitle: null });
        }
      }
    }

    res.json({ users: rows });
  } catch (err) {
    console.error('User search error:', err);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Blocking
 *
 * The one safety control a student holds themselves. Everything else on this
 * platform is reactive — report it, and a human eventually acts — which depends
 * on the student trusting the response and being willing to wait. Blocking
 * works immediately, with nobody else involved.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Who the caller has blocked. */
router.get('/api/blocks', authenticateToken, async (req, res) => {
  const rows = await db.prepare(`
    SELECT b.blocked_id AS id, u.name, u.avatar, b.created_at
    FROM user_blocks b
    JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ?
    ORDER BY b.created_at DESC
  `).all(req.user.id);
  res.json({ blocked: rows });
});

/**
 * Blocks somebody.
 *
 * ── Why only students may call this ──
 *
 * Gated on `event.apply`, which students hold and organizers do not. An
 * organizer able to block would be able to sever the channel a student would
 * use to complain about them, before anybody reviewed anything — turning a
 * safety feature into a silencing tool. An organizer being harassed has the
 * report queue, administrators, and suspension, all of which involve a second
 * person. Expressed as a capability, never a role comparison.
 */
router.post('/api/blocks/:userId', authenticateToken, requireCap('event.apply'), async (req, res) => {
  const targetId = req.params.userId;

  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot block yourself.' });
  }

  const target = await db.prepare("SELECT id FROM users WHERE id = ? AND account_status != 'deleted'").get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  let created = false;
  try {
    await runInTransaction(db, async (tx) => {
      created = await block(tx, { blockerId: req.user.id, blockedId: targetId });

      /**
       * Blocking also withdraws any friendship between the two.
       *
       * Without this the severity ordering the product documents was inverted
       * in practice: `restrict` — the gentler, quieter control — withdrew the
       * friendship (relationships.js), while Block, the one immediate safety
       * control a student holds, left it standing. An accepted friendship is
       * what unlocks the friends-only tier of a profile, so a student who
       * blocked somebody harassing them kept handing that person their school,
       * grade and bio, and both stayed in each other's friend lists.
       *
       * Unconditional rather than gated on `created`: a block recorded by an
       * earlier version left the friendship behind, so a second tap is the only
       * moment this platform gets to repair that row. `removeFriend` is a
       * no-op when there is nothing to remove.
       */
      await removeFriend(tx, req.user.id, targetId);

      /**
       * A block against an adult is a safety signal, not a preference.
       *
       * Recorded so that a pattern — several students blocking the same
       * organizer — is visible to moderation without anyone having filed a
       * report. Students frequently block rather than report, because blocking
       * is immediate and reporting feels like an accusation; if that signal is
       * not captured, the platform loses its earliest warning.
       *
       * Only on creation: a repeat tap is not new information.
       */
      if (created) {
        await recordAudit(tx, {
          adminId: req.user.id,
          action: 'USER_BLOCKED',
          targetUserId: targetId,
          details: 'Student blocked another account'
        });
      }
    });
  } catch (err) {
    console.error('Failed to block user:', err);
    return res.status(500).json({ error: 'Failed to block' });
  }

  // Idempotent: a second tap is a no-op, not an error page.
  res.json({ success: true, blocked: true, created });
});

/** Removes a block. */
router.delete('/api/blocks/:userId', authenticateToken, requireCap('event.apply'), async (req, res) => {
  const removed = await unblock(db, { blockerId: req.user.id, blockedId: req.params.userId });
  if (removed) {
    await recordAudit(db, {
      adminId: req.user.id,
      action: 'USER_UNBLOCKED',
      targetUserId: req.params.userId,
      details: 'Student removed a block'
    });
  }
  res.json({ success: true, blocked: false, removed });
});

export default router;

