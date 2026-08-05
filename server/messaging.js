import crypto from 'crypto';
import { db } from './db.js';
import { inTransaction } from './utils.js';
import { can, principalFor } from './authz.js';
import { isBlockedBetween } from './blocking.js';

export const MESSAGE_MAX_LENGTH = 4000;
export const MESSAGE_PAGE_LIMIT = 50;
const COMPLETED_OPEN_DAYS = 30;
const TERMINAL_OPEN_DAYS = 7;

export function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export function getConversation(conversationId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

export function getParticipant(conversationId, userId) {
  return db.prepare(`
    SELECT cp.*, u.name, u.avatar, u.role
    FROM conversation_participants cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.conversation_id = ? AND cp.user_id = ?
  `).get(conversationId, userId);
}

export function isConversationParticipant(conversationId, userId) {
  return !!getParticipant(conversationId, userId);
}

export function otherParticipant(conversationId, userId) {
  return db.prepare(`
    SELECT u.id, u.name, u.avatar, u.role, u.school
    FROM conversation_participants cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.conversation_id = ? AND cp.user_id != ?
    LIMIT 1
  `).get(conversationId, userId);
}

/**
 * `principal` is optional so a caller who only has an `actor` (e.g. a direct
 * unit-test call, or some future caller that never built a full request
 * principal) still works — it falls back to a principal built from `actor`'s
 * base role alone, with no per-user grants. Route handlers should pass the
 * real `req.principal` so per-user capability grants (Task 4) are honoured,
 * not just the base role's.
 */
export function eligibleRelationship({ eventId, actor, studentId = null, principal = null }) {
  const event = db.prepare(`
    SELECT e.*, u.name AS organizer_name, u.avatar AS organizer_avatar, u.school AS organizer_school
    FROM events e
    JOIN users u ON u.id = e.organizer_id
    WHERE e.id = ?
  `).get(eventId);
  if (!event) return { ok: false, status: 404, error: 'Event not found' };

  let resolvedStudentId = studentId;
  let resolvedOrganizerId = event.organizer_id;

  const p = principal || principalFor(actor);

  /**
   * Previously `actor.role === 'student' / 'organizer' / 'admin'`, checked in
   * that order with an unconditional `else { 403 }` — so `super_admin` and
   * `partner` both fell into the `else` and were denied outright. That is the
   * exact "add a role, silently deny it everywhere" defect Tasks 7a-7e exist
   * to eliminate from server/routes/, just not yet converted here.
   *
   * Order matters: super_admin's '*' wildcard in authz.js satisfies every
   * can() check, so whichever arm is tested first is the one super_admin
   * lands in. Checked broadest-privilege first (Task 7b's lesson) so
   * super_admin gets admin's treatment, not a narrower one it would also
   * technically satisfy.
   */
  if (can(p, 'event.moderate')) {
    // admin, and super_admin via the wildcard: may open a conversation about
    // any student in any event, no ownership check.
    if (!resolvedStudentId) {
      return { ok: false, status: 400, error: 'studentId is required for admin messaging in an event context' };
    }
  } else if (can(p, 'applicant.review')) {
    // organizer: only for the event they host.
    if (event.organizer_id !== actor.id) {
      return { ok: false, status: 403, error: 'Access denied: You do not host this event' };
    }
    if (!resolvedStudentId) {
      return { ok: false, status: 400, error: 'studentId is required for organizer messaging' };
    }
  } else if (can(p, 'event.apply')) {
    // student: always about themselves.
    resolvedStudentId = actor.id;
  } else {
    // partner (and anything else without a matching capability): no
    // business in student conversations. Explicit deny, never an unscoped
    // fall-through.
    return { ok: false, status: 403, error: 'Access denied' };
  }

  const student = db.prepare("SELECT id, name, avatar, role FROM users WHERE id = ? AND role = 'student'").get(resolvedStudentId);

  const relationship = student
    ? db.prepare(`
        SELECT a.*, s.start_datetime, s.end_datetime
        FROM applications a
        JOIN slots s ON s.id = a.slot_id
        WHERE a.event_id = ? AND a.user_id = ?
        ORDER BY a.applied_at ASC
      `).all(eventId, resolvedStudentId)
    : [];

  const isStaff = can(p, 'event.moderate');

  /**
   * ── The two refusals below used to be distinguishable, and that was a leak ──
   *
   * An unknown id answered 404 'Volunteer not found'; a real student who had
   * not applied answered 403 'Messaging unlocks…'. No conversation opened
   * either way — the rule held — but the PAIR of codes is an existence oracle.
   * An organizer could walk arbitrary ids against any event they host and read
   * off which ones belong to students, learning the roster of a platform whose
   * users are mostly minors without ever sending a message.
   *
   * This codebase has fixed exactly this shape once already: the export
   * download collapsed a foreign job and a missing one into a single 404 for
   * the same reason (see routes/privacyRoutes.js and privacyExportIdor.test.js).
   * Messaging was the remaining instance.
   *
   * Staff keep the precise 404. `event.moderate` already grants a full view of
   * every user through the admin surfaces, so there is no existence left to
   * protect from them, and a moderator chasing a bad id needs to be told the id
   * is bad rather than being sent to look for a nonexistent application.
   *
   * Everyone else gets ONE answer for both cases. It is phrased as the reason
   * that is true in the overwhelmingly common case — an organizer messaging
   * someone who has not applied — and it confirms nothing about the id.
   */
  if (isStaff) {
    if (!student) return { ok: false, status: 404, error: 'Volunteer not found' };
  } else if (!student || relationship.length === 0) {
    return { ok: false, status: 403, error: 'Messaging unlocks after an application exists for this event' };
  }

  /**
   * A block closes the channel in both directions.
   *
   * Checked after the application rule so that a blocked pair is refused for
   * the same reason a stranger is — the message does not confirm that a block
   * exists, which would tell an organizer that a specific student blocked them
   * and turn a safety control into a provocation.
   *
   * Staff are exempt: moderation has to be able to reach both parties precisely
   * when a block has been placed, and `event.moderate` is not a party to it.
   */
  if (!isStaff && isBlockedBetween(db, resolvedStudentId, actor.id)) {
    return { ok: false, status: 403, error: 'Messaging unlocks after an application exists for this event' };
  }

  return {
    ok: true,
    event,
    student,
    studentId: resolvedStudentId,
    organizerId: resolvedOrganizerId,
    applications: relationship
  };
}

export function resolveConversation({ eventId, actor, studentId = null, principal = null }) {
  const rel = eligibleRelationship({ eventId, actor, studentId, principal });
  if (!rel.ok) return rel;

  let conversation = db.prepare(`
    SELECT * FROM conversations WHERE event_id = ? AND student_id = ? AND organizer_id = ?
  `).get(rel.event.id, rel.studentId, rel.organizerId);

  if (!conversation) {
    const now = new Date().toISOString();
    const conversationId = newId('conv');
    inTransaction(() => {
      db.prepare(`
        INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(conversationId, rel.event.id, rel.studentId, rel.organizerId, actor.id, now);
      db.prepare(`
        INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).run(
        conversationId, rel.studentId, 'student', now,
        conversationId, rel.organizerId, 'organizer', now
      );
    });
    conversation = getConversation(conversationId);
  }

  return { ok: true, conversation: decorateConversation(conversation, actor.id), relationship: rel };
}

export function decorateConversation(conversation, viewerId) {
  if (!conversation) return null;
  const event = db.prepare(`
    SELECT e.id, e.title, e.location, e.status, e.application_deadline,
           u.name AS organizer_name, u.school AS organizer_school,
           MIN(s.start_datetime) AS start_datetime,
           MAX(s.end_datetime) AS end_datetime
    FROM events e
    JOIN users u ON u.id = e.organizer_id
    LEFT JOIN slots s ON s.event_id = e.id
    WHERE e.id = ?
    GROUP BY e.id
  `).get(conversation.event_id);
  const participant = getParticipant(conversation.id, viewerId);
  const other = otherParticipant(conversation.id, viewerId);
  const lifecycle = computeConversationLifecycle(conversation, new Date());
  const lastMessage = conversation.last_message_id
    ? db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE id = ?').get(conversation.last_message_id)
    : null;
  const unread = unreadCount(conversation.id, viewerId);
  
  const otherParticipantRow = other ? db.prepare('SELECT last_read_message_id, last_read_at FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(conversation.id, other.id) : null;

  return {
    id: conversation.id,
    eventId: conversation.event_id,
    studentId: conversation.student_id,
    organizerId: conversation.organizer_id,
    createdAt: conversation.created_at,
    lastMessageAt: conversation.last_message_at,
    lastMessage: lastMessage ? formatMessage(lastMessage) : null,
    unreadCount: unread,
    archived: !!participant?.archived_at,
    mutedUntil: participant?.muted_until || null,
    lastReadMessageId: participant?.last_read_message_id || null,
    lifecycle,
    event: event ? {
      id: event.id,
      title: event.title,
      location: event.location,
      status: event.status,
      organizerName: event.organizer_name,
      organizerSchool: event.organizer_school,
      startDatetime: event.start_datetime,
      endDatetime: event.end_datetime,
      applicationDeadline: event.application_deadline
    } : null,
    otherParticipant: other ? {
      id: other.id,
      name: other.name,
      avatar: other.avatar,
      role: other.role,
      school: other.school,
      lastReadMessageId: otherParticipantRow?.last_read_message_id || null,
      lastReadAt: otherParticipantRow?.last_read_at || null
    } : null
  };
}

export function formatMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at || null
  };
}

export function listConversationsForUser(userId) {
  return db.prepare(`
    SELECT c.*
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE cp.user_id = ?
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
  `).all(userId).map(c => decorateConversation(c, userId));
}

export function unreadCount(conversationId, userId) {
  const participant = db.prepare(`
    SELECT last_read_at FROM conversation_participants
    WHERE conversation_id = ? AND user_id = ?
  `).get(conversationId, userId);
  if (!participant) return 0;
  if (!participant.last_read_at) {
    return db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE conversation_id = ? AND sender_id != ?
    `).get(conversationId, userId).c;
  }
  return db.prepare(`
    SELECT COUNT(*) AS c FROM messages
    WHERE conversation_id = ? AND sender_id != ? AND created_at > ?
  `).get(conversationId, userId, participant.last_read_at).c;
}

export function computeConversationLifecycle(conversation, now = new Date()) {
  const apps = db.prepare(`
    SELECT a.status, a.applied_at, s.end_datetime
    FROM applications a
    JOIN slots s ON s.id = a.slot_id
    WHERE a.event_id = ? AND a.user_id = ?
  `).all(conversation.event_id, conversation.student_id);

  const eventDates = db.prepare(`
    SELECT e.status, MAX(s.end_datetime) AS end_datetime
    FROM events e LEFT JOIN slots s ON s.event_id = e.id
    WHERE e.id = ?
    GROUP BY e.id
  `).get(conversation.event_id);

  const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000);
  
  let earliestReadOnlyAt = null;
  let enforcedReason = null;
  let enforcedBanner = null;

  if (eventDates?.status === 'completed' || (eventDates?.end_datetime && now > new Date(eventDates.end_datetime))) {
    earliestReadOnlyAt = addDays(eventDates.end_datetime || conversation.created_at, COMPLETED_OPEN_DAYS);
    enforcedReason = 'completed';
    enforcedBanner = 'This conversation has been archived because the volunteer opportunity has ended. Message history is still available, but no new messages can be sent.';
  }

  const active = apps.some(a => ['pending', 'waitlisted', 'accepted'].includes(a.status));
  if (!active) {
    const terminalApps = apps.filter(a => ['withdrawn', 'rejected'].includes(a.status));
    const latestTerminal = terminalApps
      .map(a => ({ status: a.status, at: a.applied_at }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];

    if (latestTerminal) {
      const terminalReadOnlyAt = addDays(latestTerminal.at, TERMINAL_OPEN_DAYS);
      if (!earliestReadOnlyAt || terminalReadOnlyAt < earliestReadOnlyAt) {
        earliestReadOnlyAt = terminalReadOnlyAt;
        enforcedReason = latestTerminal.status;
        enforcedBanner = `This conversation is now read-only because the application was ${enforcedReason}. Message history is still available.`;
      }
    }
  }

  if (earliestReadOnlyAt) {
    const writable = now < earliestReadOnlyAt;
    return {
      state: writable ? 'active' : 'read_only',
      writable,
      reason: writable ? null : enforcedReason,
      readOnlyAt: writable ? null : earliestReadOnlyAt.toISOString(),
      banner: writable ? null : enforcedBanner
    };
  }

  return { state: 'active', writable: true, reason: null, banner: null };
}

