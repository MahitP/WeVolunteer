import crypto from 'crypto';
import { runInTransaction } from './db/connectionContext.js';
import { db } from './db.js';
import { canRunEvent } from './organizations.js';
import { can, principalFor } from './authz.js';
import { isBlockedBetween } from './blocking.js';
/* The ONE definition of "these two are friends". See resolvePeerConversation —
   re-deriving it here from `user_relationships` would create a second answer
   that could disagree with the profile tier about the same pair. */
import { areFriends } from './relationships.js';

export const MESSAGE_MAX_LENGTH = 4000;
export const MESSAGE_PAGE_LIMIT = 50;
const COMPLETED_OPEN_DAYS = 30;
const TERMINAL_OPEN_DAYS = 7;

export function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function getConversation(conversationId) {
  return await db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

export async function getParticipant(conversationId, userId) {
  return await db.prepare(`
    SELECT cp.*, u.name, u.avatar, u.role
    FROM conversation_participants cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.conversation_id = ? AND cp.user_id = ?
  `).get(conversationId, userId);
}

export async function isConversationParticipant(conversationId, userId) {
  return !!await getParticipant(conversationId, userId);
}

export async function otherParticipant(conversationId, userId) {
  /* No `u.school`. It is one of a volunteer's PUBLIC_ONLY_FIELDS
     (profileSerializer.js) and `profile_visibility` defaults to 'private', so a
     student who never opened the setting has it withheld from every peer — while
     every conversation payload published it. Nothing in the message UI read it. */
  return await db.prepare(`
    SELECT u.id, u.name, u.avatar, u.role
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
export async function eligibleRelationship({ eventId, actor, studentId = null, principal = null }) {
  const event = await db.prepare(`
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
    /* `canRunEvent`: a club's manager can now edit, cancel, broadcast to and
       credit hours on an event a helper posted, so refusing them a conversation
       about a volunteer on it was the one power that did not follow. */
    if (!await canRunEvent(db, event, actor.id, { hasModerate: can(p, 'event.moderate') })) {
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

  const student = await db.prepare("SELECT id, name, avatar, role FROM users WHERE id = ? AND role = 'student'").get(resolvedStudentId);

  const relationship = student
    ? await db.prepare(`
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
  if (!isStaff && await isBlockedBetween(db, resolvedStudentId, actor.id)) {
    return { ok: false, status: 403, error: 'Messaging unlocks after an application exists for this event' };
  }

  if (!isStaff && event.organization_id && actor.id === resolvedStudentId) {
    const ban = await db.prepare('SELECT 1 FROM organization_bans WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL').get(event.organization_id, actor.id);
    if (ban) {
      return { ok: false, status: 403, error: 'You cannot message this organization while banned.' };
    }
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

export async function resolveConversation({ eventId, actor, studentId = null, principal = null }) {
  const rel = await eligibleRelationship({ eventId, actor, studentId, principal });
  if (!rel.ok) return rel;

  let conversation = await db.prepare(`
    SELECT * FROM conversations WHERE event_id = ? AND student_id = ? AND organizer_id = ?
  `).get(rel.event.id, rel.studentId, rel.organizerId);

  if (!conversation) {
    const now = new Date().toISOString();
    const conversationId = newId('conv');
    await runInTransaction(db, async (tx) => {
      await tx.prepare(`
        INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(conversationId, rel.event.id, rel.studentId, rel.organizerId, actor.id, now);
      await tx.prepare(`
        INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).run(
        conversationId, rel.studentId, 'student', now,
        conversationId, rel.organizerId, 'organizer', now
      );
    });
    conversation = await getConversation(conversationId);
  }

  return { ok: true, conversation: await decorateConversation(conversation, actor.id), relationship: rel };
}

/**
 * Which `kind` an administrator's thread with this person is.
 *
 * Derived from the counterparty's capabilities rather than a role string, per
 * `authz.js`, and ordered most-privileged-first because `can()` answers true for
 * every capability a super_admin asks about — testing `event.apply` first would
 * classify an administrator as a student.
 *
 * Returns null for somebody an administrator has no moderation thread shape for.
 * That is deliberately an explicit deny rather than a default: a `partner`, or any
 * future capability-poor role, must not silently land in whichever branch happens
 * to be last.
 */
export function adminThreadKind(counterpartyPrincipal) {
  if (can(counterpartyPrincipal, 'event.create')) return 'admin_organizer';
  if (can(counterpartyPrincipal, 'event.apply')) return 'admin_student';
  return null;
}

/**
 * Finds or creates an administrator's thread with one person.
 *
 * ── Why this is not `resolveConversation` with a null eventId ──
 *
 * That function's whole job is deriving a (student, organizer, event) triple from
 * an event and checking the actor's relationship to it. None of that applies here:
 * there is no event, the relationship is "an administrator may contact a member of
 * this platform", and the counterparty is named directly rather than inferred.
 * Overloading it would mean a function whose every branch had to ask which mode it
 * was in.
 *
 * ── Uniqueness ──
 *
 * Keyed on (kind, created_by, counterparty) and enforced by a partial unique index
 * (migration 018), not just by this lookup. The index is what makes pressing
 * "message" twice idempotent even if two requests interleave; the lookup is what
 * makes the normal case not raise.
 */
export async function resolveAdminConversation({ actor, counterpartyId, counterpartyPrincipal }) {
  if (!counterpartyId || typeof counterpartyId !== 'string') {
    return { ok: false, status: 400, error: 'A person to contact is required' };
  }
  if (counterpartyId === actor.id) {
    return { ok: false, status: 400, error: 'You cannot open a conversation with yourself' };
  }

  const counterparty = await db.prepare(
    "SELECT id, role, account_status FROM users WHERE id = ? AND account_status != 'deleted'"
  ).get(counterpartyId);
  if (!counterparty) return { ok: false, status: 404, error: 'Person not found' };

  const kind = adminThreadKind(counterpartyPrincipal);
  if (!kind) {
    return {
      ok: false,
      status: 400,
      error: 'There is no message thread for this kind of account.',
    };
  }

  /**
   * The counterparty occupies the role column that describes them, and the
   * administrator is identified by `created_by` plus their participant row. The
   * CHECK constraints in migration 018 enforce that exactly one of the two role
   * columns is filled, so this mapping is not merely convention.
   */
  const studentId = kind === 'admin_student' ? counterparty.id : null;
  const organizerId = kind === 'admin_organizer' ? counterparty.id : null;

  let conversation = await db.prepare(`
    SELECT * FROM conversations
     WHERE kind = ? AND created_by = ? AND COALESCE(student_id, organizer_id) = ?
  `).get(kind, actor.id, counterparty.id);

  if (!conversation) {
    const now = new Date().toISOString();
    const conversationId = newId('conv');
    await runInTransaction(db, async (tx) => {
      await tx.prepare(`
        INSERT INTO conversations (id, kind, event_id, student_id, organizer_id, created_by, created_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?)
      `).run(conversationId, kind, studentId, organizerId, actor.id, now);

      /**
       * `role_at_creation` is a snapshot, and the administrator's is recorded as
       * what they were when the thread opened. It is what tells a reader a year
       * later that this thread was opened by staff rather than by a peer — the
       * account's current role may have changed by then.
       */
      await tx.prepare(`
        INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).run(
        conversationId, actor.id, actor.role, now,
        conversationId, counterparty.id, counterparty.role, now
      );
    });
    conversation = await getConversation(conversationId);
  }

  return {
    ok: true,
    created: true,
    conversation: await decorateConversation(conversation, actor.id),
  };
}

/**
 * The canonical key for one unordered pair of members.
 *
 * `min:max`, so `peerPairKey(a, b) === peerPairKey(b, a)` by construction rather
 * than by every caller remembering to sort. That is the whole reason the column
 * exists — see migration 035: keyed on `created_by` instead, A→B and B→A would be
 * two different rows and one friendship's messages would split across two threads
 * that each party sees half of.
 *
 * Defined here, beside its only writer, so the ordering rule has one home. The
 * migration's unique index is what ENFORCES it; this is what produces it.
 */
export function peerPairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Finds or creates the thread between two friends.
 *
 * ── The authorization rule, in one line ──
 *
 * `areFriends(db, actor.id, friendId)`. Nothing else. Not a role comparison, not
 * a second query against `user_relationships`, and deliberately not "can the
 * actor SEE this person" — being able to find somebody in search or open their
 * public profile is not consent to be messaged by them, and on a platform whose
 * members are mostly minors that distinction is the entire feature.
 *
 * ── Why that one call is sufficient ──
 *
 * `areFriends` is already the gate for the friends-only profile tier, and it was
 * hardened for exactly the failure mode this endpoint would otherwise reintroduce.
 * It answers false when:
 *
 *   · there is no accepted row (a pending request is not a friendship);
 *   · either party has blocked the other — so a block severs messaging here for
 *     the same reason it severs disclosure;
 *   · the two are not PEERS, i.e. either lacks `event.apply`. This is the check
 *     that makes a legacy organizer↔student friendship row — accepted before
 *     friendship became peer-only, and still sitting in databases that old —
 *     grant nothing. Messaging permission reflects current authorization state,
 *     not the survival of an old row;
 *   · either account is missing or deleted (`principalFor` returns null and
 *     `can(null, …)` is false).
 *
 * Restriction needs no separate check: `setUnilateral` withdraws the friendship
 * row when it records a restrict, and `block()` does the same, so both are
 * already visible to `areFriends` as "not friends".
 *
 * Calling it rather than restating it is the point. A second definition of
 * "friend" is how the profile tier and the message gate come to disagree about
 * the same pair, and the disagreement would be silent.
 *
 * ── This authorises CREATION. It is not the only gate. ──
 *
 * Friendship can end after the thread exists, and a conversation row is not a
 * standing permission. `computeConversationLifecycle` re-asks this same question
 * on every read and every send, which is what makes unfriending take effect on an
 * open thread rather than only on the next new one.
 */
export async function resolvePeerConversation({ actor, friendId }) {
  if (!friendId || typeof friendId !== 'string') {
    return { ok: false, status: 400, error: 'A person to message is required' };
  }
  if (friendId === actor.id) {
    return { ok: false, status: 400, error: 'You cannot open a conversation with yourself' };
  }

  /**
   * ── One refusal for "not a friend" and for "no such person" ──
   *
   * Distinguishing them would make this endpoint an existence oracle: an id that
   * answered 404 is not a member and one that answered 403 is, so anybody could
   * walk ids and enumerate the platform's accounts without sending a message.
   * `eligibleRelationship` above collapses the same pair of cases for the same
   * reason, and privacyRoutes.js did it before either.
   *
   * The sentence names the rule rather than the person, so it is equally true and
   * equally uninformative in both cases — and it does not reveal a block, which
   * would tell a blocked party who blocked them.
   */
  if (!await areFriends(db, actor.id, friendId)) {
    return { ok: false, status: 403, error: 'You can only message people you are friends with' };
  }

  const pairKey = peerPairKey(actor.id, friendId);

  let conversation = await db.prepare(
    "SELECT * FROM conversations WHERE kind = 'peer' AND pair_key = ?"
  ).get(pairKey);

  if (!conversation) {
    const now = new Date().toISOString();
    const conversationId = newId('conv');
    await runInTransaction(db, async (tx) => {
      /**
       * Both role columns stay NULL. Both of these people are students and
       * neither is an organizer, so seating one of them in `organizer_id` would
       * be a false statement in the data — and would put the row in front of
       * every query that reads those columns to mean what they say. Membership
       * is the participant rows, which is what `isConversationParticipant`
       * reads anyway.
       */
      await tx.prepare(`
        INSERT INTO conversations (id, kind, event_id, student_id, organizer_id, pair_key, created_by, created_at)
        VALUES (?, 'peer', NULL, NULL, NULL, ?, ?, ?)
      `).run(conversationId, pairKey, actor.id, now);

      /* `role_at_creation` is a snapshot of what each party was when the thread
         opened, exactly as it is for the other kinds. Both are students here;
         recording it is what lets a reader a year later tell that this was a
         peer thread and not staff contact, even if a role has changed since. */
      await tx.prepare(`
        INSERT INTO conversation_participants (conversation_id, user_id, role_at_creation, joined_at)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).run(
        conversationId, actor.id, actor.role, now,
        conversationId, friendId, 'student', now
      );
    });
    conversation = await getConversation(conversationId);
  }

  return { ok: true, conversation: await decorateConversation(conversation, actor.id) };
}

/**
 * @param {Map<string, object>} [events] pre-loaded event rows, keyed by id.
 *   `listConversationsForUser` supplies this so the list costs one event query
 *   instead of one per conversation. Omitted, the event is fetched here, which
 *   is what every single-conversation caller wants.
 */
export async function decorateConversation(conversation, viewerId, events = null) {
  if (!conversation) return null;
  /* Every non-aggregated column is grouped, including the two from `users`.
     SQLite allows a bare column that is functionally dependent on the grouped
     key and picks an arbitrary row for it; PostgreSQL requires it to be named,
     and answers `column "u.name" must appear in the GROUP BY clause`. Adding
     them changes no result here — `e.id` is the primary key, so each group has
     exactly one organizer. */
  const event = events
    ? (conversation.event_id ? events.get(conversation.event_id) ?? null : null)
    : await db.prepare(`
      SELECT e.id, e.title, e.location, e.status, e.application_deadline,
             u.name AS organizer_name, u.school AS organizer_school,
             MIN(s.start_datetime) AS start_datetime,
             MAX(s.end_datetime) AS end_datetime
      FROM events e
      JOIN users u ON u.id = e.organizer_id
      LEFT JOIN slots s ON s.event_id = e.id
      WHERE e.id = ?
      GROUP BY e.id, u.name, u.school
    `).get(conversation.event_id);
  const participant = await getParticipant(conversation.id, viewerId);
  const other = await otherParticipant(conversation.id, viewerId);
  const lifecycle = await computeConversationLifecycle(conversation, new Date());
  const lastMessage = conversation.last_message_id
    ? await db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE id = ?').get(conversation.last_message_id)
    : null;
  const unread = await unreadCount(conversation.id, viewerId);
  
  const otherParticipantRow = other ? await db.prepare('SELECT last_read_message_id, last_read_at FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(conversation.id, other.id) : null;

  return {
    id: conversation.id,
    /**
     * What kind of thread this is, so the client can render it without inferring.
     *
     * Inferring it from `event === null` is the trap: an event-scoped thread whose
     * event was deleted also has a null event (the row cascades), and it must NOT
     * be treated as a moderation thread — its lifecycle rules still apply and its
     * participants are still a student and an organizer. `kind` is the stored
     * fact; the shape of the joined data is a consequence.
     *
     * Defaulted for rows read before migration 018 ran, which cannot be any other
     * kind because no other kind could be created.
     */
    kind: conversation.kind || 'student_organizer',
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

/**
 * The most conversations one list response may carry.
 *
 * This query had no `LIMIT`, and each row it returned cost seven further
 * queries to decorate — so the response was unbounded in rows AND the
 * `Promise.all` over it put seven times that many statements against a pool of
 * ten, from one request.
 *
 * Two hundred is far past any real inbox here: conversations are created per
 * event and per moderation thread, not by people messaging each other freely
 * (the product has no open DMs). It is the same shape as the caps on events,
 * applications and the appeals queue — bounded, ordered, and loud when it bites.
 */
export const CONVERSATION_LIST_MAX = 200;

export async function listConversationsForUser(userId) {
  const rows = await db.prepare(`
    SELECT c.*
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE cp.user_id = ?
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id ASC
    LIMIT ?
  `).all(userId, CONVERSATION_LIST_MAX);

  if (rows.length === CONVERSATION_LIST_MAX) {
    console.warn(
      `[messaging] Conversation list for ${userId} hit the ${CONVERSATION_LIST_MAX} cap. `
      + 'Older threads are not being shown; this list needs paginating.'
    );
  }

  /**
   * The event behind every conversation, in ONE query rather than one per row.
   *
   * `decorateConversation` looks its event up with a three-table join and a
   * GROUP BY — comfortably the heaviest of its seven lookups — and the list ran
   * it once per conversation. Passing them in pre-loaded leaves the single-row
   * path untouched for its own callers while the list pays for one query
   * instead of N.
   *
   * `Promise.all` is still how the remaining per-row lookups run, and it is now
   * bounded by the cap above rather than by how many conversations somebody has
   * accumulated.
   */
  const eventIds = [...new Set(rows.map(c => c.event_id).filter(Boolean))];
  const eventsById = new Map();
  if (eventIds.length) {
    const marks = eventIds.map(() => '?').join(',');
    for (const row of await db.prepare(`
      SELECT e.id, e.title, e.location, e.status, e.application_deadline,
             u.name AS organizer_name, u.school AS organizer_school,
             MIN(s.start_datetime) AS start_datetime,
             MAX(s.end_datetime) AS end_datetime
      FROM events e
      JOIN users u ON u.id = e.organizer_id
      LEFT JOIN slots s ON s.event_id = e.id
      WHERE e.id IN (${marks})
      GROUP BY e.id, u.name, u.school
    `).all(...eventIds)) {
      eventsById.set(row.id, row);
    }
  }

  /* `Promise.all`, not a bare `.map`: `decorateConversation` is async now, and
     an array of pending promises serialises to `[{}, {}]` — an empty
     conversation list that looks like a real one. */
  return Promise.all(rows.map(c => decorateConversation(c, userId, eventsById)));
}

export async function unreadCount(conversationId, userId) {
  const participant = await db.prepare(`
    SELECT last_read_at FROM conversation_participants
    WHERE conversation_id = ? AND user_id = ?
  `).get(conversationId, userId);
  if (!participant) return 0;
  if (!participant.last_read_at) {
    return (await db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE conversation_id = ? AND sender_id != ?
    `).get(conversationId, userId)).c;
  }
  return (await db.prepare(`
    SELECT COUNT(*) AS c FROM messages
    WHERE conversation_id = ? AND sender_id != ? AND created_at > ?
  `).get(conversationId, userId, participant.last_read_at)).c;
}

export async function computeConversationLifecycle(conversation, now = new Date()) {
  /**
   * A moderation thread never goes read-only, and this returns EARLY rather than
   * relying on the queries below finding nothing.
   *
   * They would find nothing — `event_id` is NULL, so both lookups come back empty
   * and the function falls through to "active". But that is an accident of how the
   * absence of an event happens to flow through event-shaped SQL, not a decision,
   * and it would stop being true the moment somebody added a rule keyed on
   * `created_at` or on the absence of applications (an admin thread has none,
   * which reads exactly like a student who withdrew — the branch below turns THAT
   * read-only after seven days).
   *
   * The rule itself is the point: the event-driven rules exist so a thread about a
   * finished shift stops accepting messages. A student's channel to an
   * administrator is not about a shift, and closing it 30 days after some
   * unrelated event ended would shut the one route a person has for raising
   * something — including an appeal. This is the hazard the audit named when it
   * rejected putting an admin in the `organizer_id` slot.
   */
  /**
   * A peer thread is writable exactly while the two are still friends.
   *
   * ── Why the rule lives HERE and not only in the send handler ──
   *
   * This function is called on every read (`decorateConversation`) and on every
   * send, and the send handler already refuses when `writable` is false. Putting
   * the check here therefore does two jobs with one answer: the backend refuses
   * the write, AND the client is told the thread is read-only so it renders the
   * banner and disables the composer instead of offering a box whose submissions
   * will 409. A rule enforced in the handler alone would be correct and would
   * still show the user a working-looking composer.
   *
   * ── What "still friends" covers ──
   *
   * `areFriends` is the same single source of truth `resolvePeerConversation`
   * opens the thread on, so permission cannot drift between creating and
   * continuing. It goes false on unfriend, on block by either party, on restrict
   * (which withdraws the friendship row), on either account being deleted, and on
   * either party ceasing to be a peer. Every one of those closes the thread on
   * the next request, with no sweep and no stored state to keep in step.
   *
   * ── Read-only rather than invisible ──
   *
   * The history stays readable to both parties, which is the same choice this
   * codebase makes everywhere else a thread stops accepting messages — a
   * completed event, a withdrawn application, a block on an event thread. Two
   * reasons it is the right one here too: a student who is being harassed needs
   * the record to still exist when they report it, and hiding a conversation the
   * moment a friendship ends would delete a person's side of an argument from
   * under them. Membership is unchanged; only writing stops.
   *
   * ── Participants, not the role columns ──
   *
   * A peer row's `student_id` and `organizer_id` are NULL by CHECK (migration
   * 035), so the pair has to come from `conversation_participants`. Reading it
   * rather than splitting `pair_key` keeps this working for a row whose key is
   * somehow absent, and participants are the membership of record regardless.
   */
  if (conversation.kind === 'peer') {
    const ids = (await db.prepare(
      'SELECT user_id FROM conversation_participants WHERE conversation_id = ?'
    ).all(conversation.id)).map(r => r.user_id);

    if (ids.length === 2 && await areFriends(db, ids[0], ids[1])) {
      return { state: 'active', writable: true, reason: null, banner: null };
    }
    return {
      state: 'read_only',
      writable: false,
      reason: 'not_friends',
      readOnlyAt: null,
      /* Says what changed and not who did it. "They unfriended you", "they
         blocked you" and "they deleted their account" are three different
         disclosures about somebody else's decision, and this thread is not where
         any of them should be announced. */
      banner: 'This conversation is read-only because you are no longer connected. '
        + 'Message history is still available.',
    };
  }

  if (conversation.kind && conversation.kind !== 'student_organizer') {
    return { state: 'active', writable: true, reason: null, banner: null };
  }

  const apps = await db.prepare(`
    SELECT a.status, a.applied_at, s.end_datetime
    FROM applications a
    JOIN slots s ON s.id = a.slot_id
    WHERE a.event_id = ? AND a.user_id = ?
  `).all(conversation.event_id, conversation.student_id);

  const eventDates = await db.prepare(`
    SELECT e.status, MAX(s.end_datetime) AS end_datetime
    FROM events e LEFT JOIN slots s ON s.event_id = e.id
    WHERE e.id = ?
    GROUP BY e.id, e.status
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

