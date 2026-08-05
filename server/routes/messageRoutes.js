import express from 'express';
import { authenticateToken, inTransaction } from '../utils.js';
import { can, requireCap } from '../authz.js';
import { isBlockedBetween, block, unblock } from '../blocking.js';
import { notificationService } from '../services/notificationService.js';
import { emitToUser } from '../realtime/events.js';
import { db } from '../db.js';
import { recordAudit } from '../auditLog.js';
import {
  MESSAGE_MAX_LENGTH,
  MESSAGE_PAGE_LIMIT,
  computeConversationLifecycle,
  decorateConversation,
  eligibleRelationship,
  formatMessage,
  getConversation,
  getParticipant,
  isConversationParticipant,
  listConversationsForUser,
  newId,
  otherParticipant,
  resolveConversation
} from '../messaging.js';

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

function participantIds(conversationId) {
  return db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ?')
    .all(conversationId).map(r => r.user_id);
}

router.get('/api/messages/conversations', authenticateToken, (req, res) => {
  try {
    const conversations = listConversationsForUser(req.user.id);
    const unreadTotal = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
    res.json({ conversations, unreadTotal });
  } catch (err) {
    console.error('Messages conversations list error:', err);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

router.post('/api/messages/conversations/resolve', authenticateToken, (req, res) => {
  try {
    const { eventId, studentId } = req.body;
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });

    const result = resolveConversation({ eventId, studentId, actor: req.user, principal: req.principal });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    res.status(200).json({ conversation: result.conversation });
  } catch (err) {
    console.error('Resolve conversation error:', err);
    res.status(500).json({ error: 'Failed to open conversation' });
  }
});

router.get('/api/messages/conversations/:id/messages', authenticateToken, (req, res) => {
  try {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!isConversationParticipant(conversation.id, req.user.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const limit = Math.min(MESSAGE_PAGE_LIMIT, Math.max(1, Number(req.query.limit) || MESSAGE_PAGE_LIMIT));
    const before = req.query.before;
    let rows;
    if (before) {
      const cursor = db.prepare('SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?')
        .get(before, conversation.id);
      if (!cursor) return res.status(400).json({ error: 'Invalid pagination cursor' });
      rows = db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ? AND created_at < ?
        ORDER BY created_at DESC LIMIT ?
      `).all(conversation.id, cursor.created_at, limit);
    } else {
      rows = db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(conversation.id, limit);
    }

    rows.reverse();
    res.json({
      conversation: decorateConversation(conversation, req.user.id),
      messages: rows.map(formatMessage),
      hasMore: rows.length === limit
    });
  } catch (err) {
    console.error('Messages page error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

router.post('/api/messages/conversations/:id/messages', authenticateToken, (req, res) => {
  try {
    if (!checkMessageRateLimit(req.user.id)) {
      return res.status(429).json({
        error: 'Too many messages sent too quickly. Please pause for a minute.',
        code: 'rate_limited'
      });
    }

    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!isConversationParticipant(conversation.id, req.user.id)) {
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
    const other = otherParticipant(conversation.id, req.user.id);
    if (other && !can(req.principal, 'event.moderate') && isBlockedBetween(db, req.user.id, other.id)) {
      return res.status(409).json({
        error: 'This conversation is read-only.',
        code: 'conversation_read_only'
      });
    }

    const lifecycle = computeConversationLifecycle(conversation, new Date());
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

    inTransaction(() => {
      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(messageId, conversation.id, req.user.id, body, now);
      db.prepare(`
        UPDATE conversations
        SET last_message_id = ?, last_message_at = ?, lifecycle_state = ?, read_only_reason = ?, read_only_at = ?
        WHERE id = ?
      `).run(messageId, now, lifecycle.state, lifecycle.reason, lifecycle.readOnlyAt || null, conversation.id);
      db.prepare(`
        UPDATE conversation_participants
        SET last_read_message_id = ?, last_read_at = ?
        WHERE conversation_id = ? AND user_id = ?
      `).run(messageId, now, conversation.id, req.user.id);
      message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    });

    const recipients = participantIds(conversation.id).filter(id => id !== req.user.id);
    const sender = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
    const decorated = decorateConversation(getConversation(conversation.id), req.user.id);
    const payload = { message: formatMessage(message), conversation: decorated };

    for (const userId of recipients) {
      const participant = getParticipant(conversation.id, userId);
      const muted = participant?.muted_until && new Date(participant.muted_until) > new Date();
      if (!muted) {
        notificationService.dispatch('DIRECT_MESSAGE', {
          title: `New message from ${sender?.name || 'Someone'}`,
          body: `${decorated.event?.title || 'Volunteer conversation'}: ${body.slice(0, 120)}`,
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

router.post('/api/messages/conversations/:id/read', authenticateToken, (req, res) => {
  try {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!isConversationParticipant(conversation.id, req.user.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messageId = req.body.messageId || conversation.last_message_id;
    if (!messageId) return res.json({ success: true });
    const message = db.prepare('SELECT id, created_at FROM messages WHERE id = ? AND conversation_id = ?')
      .get(messageId, conversation.id);
    if (!message) return res.status(400).json({ error: 'Message not found in this conversation' });

    db.prepare(`
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
    for (const userId of participantIds(conversation.id).filter(id => id !== req.user.id)) {
      emitToUser(userId, 'conversation.read', conversation.id, payload);
    }
    emitToUser(req.user.id, 'conversation.read', conversation.id, payload);
    res.json({ success: true, ...payload });
  } catch (err) {
    console.error('Mark conversation read error:', err);
    res.status(500).json({ error: 'Failed to update read receipt' });
  }
});

router.patch('/api/messages/conversations/:id/preferences', authenticateToken, (req, res) => {
  try {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!isConversationParticipant(conversation.id, req.user.id)) {
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
    db.prepare(`
      UPDATE conversation_participants SET ${updates.join(', ')}
      WHERE conversation_id = ? AND user_id = ?
    `).run(...values);
    res.json({ conversation: decorateConversation(getConversation(conversation.id), req.user.id) });
  } catch (err) {
    console.error('Conversation preferences error:', err);
    res.status(500).json({ error: 'Failed to update conversation preferences' });
  }
});

router.get('/api/messages/search', authenticateToken, (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT m.*, c.event_id, e.title AS event_title, u.name AS sender_name
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
      JOIN events e ON e.id = c.event_id
      JOIN users u ON u.id = m.sender_id
      WHERE m.body LIKE ?
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

router.post('/api/messages/conversations/:id/report', authenticateToken, (req, res) => {
  try {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!isConversationParticipant(conversation.id, req.user.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const reason = String(req.body.reason || '');
    if (!['inappropriate', 'spam', 'safety', 'other'].includes(reason)) {
      return res.status(400).json({ error: 'Choose a report reason' });
    }
    const messageIds = Array.isArray(req.body.messageIds) ? req.body.messageIds.slice(0, 20) : [];
    const details = String(req.body.details || '').trim().slice(0, 1000);
    const reportId = newId('msg-report');
    const now = new Date().toISOString();

    inTransaction(() => {
      db.prepare(`
        INSERT INTO conversation_reports (id, reporter_id, conversation_id, reason, details, snapshot_created_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(reportId, req.user.id, conversation.id, reason, details || null, now, now);

      const snapshotRows = messageIds.length > 0
        ? messageIds.map(id => db.prepare(`
            SELECT id, sender_id, body, created_at FROM messages
            WHERE id = ? AND conversation_id = ?
          `).get(id, conversation.id)).filter(Boolean)
        : db.prepare(`
            SELECT id, sender_id, body, created_at FROM messages
            WHERE conversation_id = ?
            ORDER BY created_at DESC LIMIT 10
          `).all(conversation.id).reverse();

      const insert = db.prepare(`
        INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const msg of snapshotRows) {
        insert.run(reportId, msg.id, msg.sender_id, msg.body, msg.created_at);
      }
    });

    res.status(201).json({ success: true, reportId });
  } catch (err) {
    console.error('Conversation report error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

router.get('/api/messages/users/search', authenticateToken, (req, res) => {
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
      rows = db.prepare(`
        SELECT DISTINCT u.id, u.name, u.username, u.avatar, u.role, e.id AS eventId, e.title AS eventTitle
        FROM users u
        JOIN applications a ON a.user_id = u.id
        JOIN events e ON a.event_id = e.id
        WHERE e.organizer_id = ?
          AND (u.name LIKE ? OR u.username LIKE ?)
        LIMIT 20
      `).all(req.principal.userId, like, like);
    } else if (can(req.principal, 'application.withdraw')) {
      rows = db.prepare(`
        SELECT DISTINCT u.id, u.name, u.username, u.avatar, u.role, e.id AS eventId, e.title AS eventTitle
        FROM users u
        JOIN events e ON e.organizer_id = u.id
        JOIN applications a ON a.event_id = e.id
        WHERE a.user_id = ?
          AND (u.name LIKE ? OR u.username LIKE ?)
        LIMIT 20
      `).all(req.principal.userId, like, like);
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
router.get('/api/blocks', authenticateToken, (req, res) => {
  const rows = db.prepare(`
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
router.post('/api/blocks/:userId', authenticateToken, requireCap('event.apply'), (req, res) => {
  const targetId = req.params.userId;

  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot block yourself.' });
  }

  const target = db.prepare("SELECT id FROM users WHERE id = ? AND account_status != 'deleted'").get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  let created = false;
  try {
    inTransaction(() => {
      created = block(db, { blockerId: req.user.id, blockedId: targetId });

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
        recordAudit(db, {
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
router.delete('/api/blocks/:userId', authenticateToken, requireCap('event.apply'), (req, res) => {
  const removed = unblock(db, { blockerId: req.user.id, blockedId: req.params.userId });
  if (removed) {
    recordAudit(db, {
      adminId: req.user.id,
      action: 'USER_UNBLOCKED',
      targetUserId: req.params.userId,
      details: 'Student removed a block'
    });
  }
  res.json({ success: true, blocked: false, removed });
});

export default router;

