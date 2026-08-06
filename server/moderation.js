/**
 * One definition of what a report is.
 *
 * ── Why this module exists ──
 *
 * There used to be two reporting systems that did not know about each other:
 * `reports` (events and comments, free-text reason, no category) and
 * `conversation_reports` (messages, its own reason enum, its own status enum,
 * and — until PR-1 — no reader at all). Two tables, two write paths, two
 * modals, two shapes of truth about the same question. A student reporting a
 * comment and a student reporting a conversation were producing incomparable
 * records, and only one of them was ever going to be looked at.
 *
 * Everything about a report that is a decision rather than a database row lives
 * here: the categories, the words students see, which categories make sense for
 * which target, how priority is derived, and how a target is resolved into the
 * snapshot that has to outlive it. The routes are thin. That is deliberate —
 * three of them create reports, and three copies of this logic would be three
 * chances to snapshot nothing.
 *
 * The client imports `REPORT_CATEGORIES` from here too, via `src/moderation.js`,
 * for the same reason `authz.js` is re-exported rather than retyped: two lists
 * of categories drift, and the drift shows up as a student picking a label the
 * server rejects.
 *
 * ── This module imports nothing ──
 *
 * Like `authz.js`. No db, no config. `createReport` takes a `db` handle as an
 * argument instead, which is what lets the whole taxonomy be unit-tested without
 * booting a listener or opening a database.
 */

/* ── Status ────────────────────────────────────────────────────────────────
 *
 * Five states. Stored lower-case snake_case, which is the convention every
 * other enum in this schema follows (`account_status`, `target_type`,
 * `lifecycle_state`); the UI upper-cases them for display, as it already did
 * for the three that existed before.
 *
 * `escalated` is a state and not a priority, deliberately. Priority says how
 * fast; escalated says "this has left the ordinary queue and a named human is
 * dealing with it off-platform". A report can be critical and unescalated (it
 * just arrived) or medium and escalated (a moderator picked up the phone). One
 * field cannot carry both without lying about one of them.
 */
export const REPORT_STATUSES = ['open', 'reviewing', 'escalated', 'resolved', 'dismissed'];

/** Statuses that still hold evidence. Mirrors evidenceHolds.js, which is authoritative. */
export const LIVE_REPORT_STATUSES = ['open', 'reviewing', 'escalated'];

/** Terminal states. A report here has been dealt with and releases its holds. */
export const CLOSED_REPORT_STATUSES = ['resolved', 'dismissed'];

/* ── Priority ──────────────────────────────────────────────────────────── */

export const REPORT_PRIORITIES = ['normal', 'urgent'];

/**
 * How the two levels are meant to be read, so that a future category is
 * classified by the same rule rather than by feel:
 *
 *   urgent — a child may be in immediate danger, this is an attempt at contact
 *            or exploitation, a recognised grooming pattern, or targeted harm.
 *            Someone looks at it today. This is where "I can't explain why" lands.
 *   normal — real harm that needs a human but not tonight, or nuisance.
 *            Nobody is immediately unsafe. One business day.
 *
 * Priority is derived from the category the reporter chose and from who they
 * are reporting. It is NEVER accepted from the client: a field the client sets
 * is a field an abusive client sets to `critical` on everything, and a queue
 * where everything is critical has no priority at all.
 *
 * A moderator may change it afterwards. That is the escape hatch for the cases
 * derivation gets wrong, and PR-3's history table is what will record who
 * overrode what.
 */
export const CATEGORY_PRIORITY = Object.freeze({
  // A child may be in immediate danger, or this is an attempt at contact or
  // exploitation. Nothing in the queue outranks these.
  asked_to_meet_alone: 'urgent',
  sexual_content: 'urgent',
  threatened_me: 'urgent',
  offered_gifts_or_substances: 'urgent',

  // The recognised grooming patterns, and targeted harm to a person.
  asked_for_private_info: 'urgent',
  asked_to_move_off_platform: 'urgent',
  asked_to_keep_secret: 'urgent',
  comments_on_my_body: 'urgent',
  pressured_about_my_place: 'urgent',
  messages_not_about_the_event: 'urgent',
  hate_or_discrimination: 'urgent',
  shared_private_info: 'urgent',

  // Needs a person, does not need tonight.
  something_feels_wrong: 'normal',
  bullying_or_harassment: 'normal',
  pretending_to_be_someone: 'normal',
  fake_hours_or_certificate: 'normal',
  other: 'normal',

  // Nobody is unsafe.
  spam_or_advertising: 'normal',
});

/* ── Categories ────────────────────────────────────────────────────────────
 *
 * Stored values are stable snake_case and are never displayed. Labels are what
 * a fifteen-year-old sees, and they are written in the first person because
 * that is how someone describes a thing that happened to them — "Someone asked
 * me for my phone number", not "Solicitation of personal contact information".
 *
 * Drafted from the Youth Safety Guidelines' "What adults are not allowed to do"
 * and the Community Guidelines' "What does not belong", translated out of policy
 * voice. Both documents are the source; the wording here is not.
 *
 * `something_feels_wrong` is pinned above the groups and is the first thing in
 * the list, because the Youth Safety Guidelines say in terms: "If a conversation
 * makes you uneasy and you cannot say exactly why, that is reason enough to
 * report it." Making the vaguest option the easiest one to pick is the whole
 * design, and it is why that category derives `high` rather than `medium`.
 */

export const CATEGORY_GROUPS = Object.freeze({
  unsure: 'I\'m not sure, but something\'s off',
  unsafe: 'I feel unsafe',
  cruel: 'Someone is being cruel',
  dishonest: 'Something is dishonest',
  other: 'Something else',
});

export const REPORT_CATEGORIES = Object.freeze([
  { value: 'something_feels_wrong', group: 'unsure', label: 'Something feels wrong and I can\'t explain why' },

  { value: 'asked_for_private_info', group: 'unsafe', label: 'Someone asked me for my phone number, address, or social media' },
  { value: 'asked_to_move_off_platform', group: 'unsafe', label: 'They want to talk somewhere else — text, Snap, Instagram, Discord' },
  { value: 'asked_to_keep_secret', group: 'unsafe', label: 'Someone asked me to keep this secret from my parents or teachers' },
  { value: 'asked_to_meet_alone', group: 'unsafe', label: 'Someone wants to meet me alone' },
  { value: 'comments_on_my_body', group: 'unsafe', label: 'Someone said something about my body or how I look' },
  { value: 'sexual_content', group: 'unsafe', label: 'Someone sent me something sexual, or asked me for photos' },
  { value: 'offered_gifts_or_substances', group: 'unsafe', label: 'Someone offered me money, gifts, vapes, alcohol, or drugs' },
  { value: 'threatened_me', group: 'unsafe', label: 'Someone threatened me, or said they\'d hurt someone' },
  { value: 'pressured_about_my_place', group: 'unsafe', label: 'Someone said I\'d lose my volunteer spot if I didn\'t do something' },
  { value: 'messages_not_about_the_event', group: 'unsafe', label: 'An adult is messaging me about things that have nothing to do with the event' },

  { value: 'bullying_or_harassment', group: 'cruel', label: 'Someone is being mean, piling on, or won\'t leave me alone' },
  { value: 'hate_or_discrimination', group: 'cruel', label: 'Someone targeted me for my race, religion, disability, gender, sexuality, or where I\'m from' },
  { value: 'shared_private_info', group: 'cruel', label: 'Someone posted private information about me or someone else' },

  { value: 'pretending_to_be_someone', group: 'dishonest', label: 'This account is pretending to be someone else' },
  { value: 'fake_hours_or_certificate', group: 'dishonest', label: 'Someone\'s claiming hours they didn\'t work, or using a certificate that isn\'t theirs' },
  { value: 'spam_or_advertising', group: 'dishonest', label: 'Spam, ads, or recruiting for something that isn\'t volunteering' },

  { value: 'other', group: 'other', label: 'Something else — I\'ll explain' },
]);

export const CATEGORY_VALUES = Object.freeze(REPORT_CATEGORIES.map(c => c.value));

const CATEGORY_SET = new Set(CATEGORY_VALUES);

export const isValidCategory = (value) => CATEGORY_SET.has(value);

/* ── Target types ──────────────────────────────────────────────────────── */

export const REPORT_TARGET_TYPES = ['event', 'comment', 'message', 'conversation', 'user', 'announcement', 'certificate'];

/**
 * `organizer` is accepted from a client and stored as `user`.
 *
 * An organizer is a `users` row. A separate stored target type would be a
 * second, mutable source of truth about a role that already lives on the row,
 * and it would be wrong the moment somebody's role changes — which is exactly
 * when a moderator most needs the record to be right. What triage actually
 * needs is the role **at report time**, and that is `target_role_snapshot`,
 * which is a fact that cannot go stale.
 *
 * The alias exists because the product genuinely does offer "Report this
 * organizer" from an organizer's profile, and a client should not have to know
 * that the platform models that as a user. Impersonation is likewise a category
 * (`pretending_to_be_someone`) whose target is a user, not a target type:
 * `target_type` answers *what did you point at*, `category` answers *what is
 * wrong with it*.
 */
export const TARGET_TYPE_ALIASES = Object.freeze({ organizer: 'user' });

export function normalizeTargetType(value) {
  const raw = String(value ?? '');
  const mapped = TARGET_TYPE_ALIASES[raw] ?? raw;
  return REPORT_TARGET_TYPES.includes(mapped) ? mapped : null;
}

/**
 * Which categories the UI offers for a given target.
 *
 * **UI-only, and the server must not enforce it.** A mismatch is a mis-tap, not
 * an attack, and 400-ing a distressed student because "someone asked me to meet
 * alone" was filed against a comment rather than a message is worse in every
 * way than filing a slightly mis-categorised report. The server accepts any
 * valid category for any valid target. Do not "tighten" this later.
 */
export function categoriesForTarget(targetType) {
  const type = normalizeTargetType(targetType) ?? 'other';
  if (type === 'message' || type === 'conversation') return REPORT_CATEGORIES;
  if (type === 'user') return REPORT_CATEGORIES.filter(c => c.value !== 'spam_or_advertising');
  
  if (type === 'certificate') {
    return REPORT_CATEGORIES.filter(c => c.value === 'fake_hours_or_certificate' || c.value === 'other');
  }

  // An event listing, public comment, or announcement cannot itself ask you to meet alone.
  // Offering those categories here would make the list longer and less scannable
  // at no benefit — the conversation is where those belong.
  const surface = new Set([
    'something_feels_wrong', 'bullying_or_harassment', 'hate_or_discrimination',
    'shared_private_info', 'pretending_to_be_someone', 'fake_hours_or_certificate',
    'spam_or_advertising', 'other',
  ]);
  return REPORT_CATEGORIES.filter(c => surface.has(c.value));
}

/* ── Resolution ────────────────────────────────────────────────────────── */

export const REPORT_RESOLUTIONS = [
  'no_action', 'content_removed', 'warning_issued', 'account_suspended',
  'account_removed', 'escalated_offline', 'duplicate',
];

/** Longest a description may be. Raised from 1000: a student describing a
 *  grooming conversation needs room, and running out of characters mid-sentence
 *  is a bad thing to happen to somebody who has worked up to typing it. */
export const MAX_DESCRIPTION_LENGTH = 2000;

/* ── Priority derivation ───────────────────────────────────────────────── */

const PRIORITY_RANK = Object.freeze({ normal: 0, urgent: 1 });

/**
 * The priority a report gets, derived and never accepted.
 *
 * Two inputs: the category the reporter chose, and the actor asymmetry — a
 * student reporting an adult floors at `urgent` whatever the category says.
 *
 * That floor costs one lookup and it is the difference between a student who
 * knows exactly which box to tick and one who freezes at the dropdown and picks
 * the mildest-sounding thing. The second student is not in less danger. Reports
 * between peers are not floored: student-on-student unpleasantness is real and
 * is handled, but it is not the asymmetry the platform exists to watch.
 *
 * Never lowers anything.
 */
export function derivePriority({ category, reporterRole, targetRole }) {
  const base = CATEGORY_PRIORITY[category] ?? 'normal';
  const adultRoles = new Set(['organizer', 'admin', 'super_admin']);
  const asymmetric = reporterRole === 'student' && adultRoles.has(targetRole);
  if (!asymmetric) return base;
  return PRIORITY_RANK[base] >= PRIORITY_RANK.urgent ? base : 'urgent';
}

/* ── Target resolution ─────────────────────────────────────────────────────
 *
 * Everything a moderator will need to read, captured at the moment the report
 * is filed rather than joined at the moment it is read.
 *
 * That is not an optimisation. Every one of these joins crosses to a row the
 * reported party can destroy: a comment is theirs to delete, an event is the
 * organizer's own, a conversation cascades from the event, and a users row is
 * anonymised on deletion and hard-purged three years later. PR-1 severed the
 * cascades so the report survives; these columns are what keep the surviving
 * row legible. A report that reads "someone reported something about someone"
 * is not evidence of anything.
 */

/**
 * @returns {{
 *   targetName: string|null, targetBody: string|null,
 *   authorId: string|null, authorName: string|null, authorRole: string|null,
 *   conversationId: string|null, eventId: string|null, exists: boolean
 * }}
 */
export function resolveTarget(db, targetType, targetId, viewerId) {
  const empty = {
    targetName: null, targetBody: null, authorId: null, authorName: null,
    authorRole: null, conversationId: null, eventId: null, exists: false,
  };

  switch (targetType) {
    case 'event': {
      const row = db.prepare(`
        SELECT e.id, e.title, e.organizer_id, u.name AS author_name, u.role AS author_role
        FROM events e LEFT JOIN users u ON u.id = e.organizer_id WHERE e.id = ?
      `).get(targetId);
      if (!row) return empty;
      return {
        ...empty, exists: true, eventId: row.id,
        targetName: row.title, targetBody: row.title,
        authorId: row.organizer_id, authorName: row.author_name, authorRole: row.author_role,
      };
    }

    case 'comment': {
      const row = db.prepare(`
        SELECT c.id, c.body, c.event_id, c.user_id, u.name AS author_name, u.role AS author_role,
               e.title AS event_title
        FROM event_comments c
        LEFT JOIN users u  ON u.id = c.user_id
        LEFT JOIN events e ON e.id = c.event_id
        WHERE c.id = ?
      `).get(targetId);
      if (!row) return empty;
      return {
        ...empty, exists: true, eventId: row.event_id,
        targetName: row.event_title ? `Comment on “${row.event_title}”` : 'Comment',
        targetBody: row.body,
        authorId: row.user_id, authorName: row.author_name, authorRole: row.author_role,
      };
    }

    case 'announcement': {
      const row = db.prepare(`
        SELECT a.id, a.body, a.event_id, a.author_id, u.name AS author_name, u.role AS author_role,
               e.title AS event_title
        FROM event_announcements a
        LEFT JOIN users u  ON u.id = a.author_id
        LEFT JOIN events e ON e.id = a.event_id
        WHERE a.id = ?
      `).get(targetId);
      if (!row) return empty;
      return {
        ...empty, exists: true, eventId: row.event_id,
        targetName: row.event_title ? `Announcement in “${row.event_title}”` : 'Announcement',
        targetBody: row.body,
        authorId: row.author_id, authorName: row.author_name, authorRole: row.author_role,
      };
    }

    case 'certificate': {
      // Certificates don't query the DB to prevent an oracle. Just do a format check.
      if (!/^WEV-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(targetId)) return { ...empty, exists: false };
      return {
        ...empty, exists: true,
        targetName: `Certificate ${targetId}`,
        targetBody: null,
      };
    }

    case 'message': {
      const row = db.prepare(`
        SELECT m.id, m.body, m.conversation_id, m.sender_id,
               u.name AS author_name, u.role AS author_role, c.event_id
        FROM messages m
        LEFT JOIN users u        ON u.id = m.sender_id
        LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = ?
      `).get(targetId);
      if (!row) return empty;
      return {
        ...empty, exists: true,
        conversationId: row.conversation_id, eventId: row.event_id,
        targetName: row.author_name ? `Message from ${row.author_name}` : 'Message',
        targetBody: row.body,
        authorId: row.sender_id, authorName: row.author_name, authorRole: row.author_role,
      };
    }

    case 'conversation': {
      const row = db.prepare(`
        SELECT c.id, c.event_id, c.student_id, c.organizer_id, e.title AS event_title
        FROM conversations c LEFT JOIN events e ON e.id = c.event_id WHERE c.id = ?
      `).get(targetId);
      if (!row) return empty;
      // The reported party is whichever participant is not the reporter.
      const otherId = row.student_id === viewerId ? row.organizer_id : row.student_id;
      const other = otherId
        ? db.prepare('SELECT name, role FROM users WHERE id = ?').get(otherId)
        : null;
      return {
        ...empty, exists: true, conversationId: row.id, eventId: row.event_id,
        targetName: row.event_title ? `Conversation about “${row.event_title}”` : 'Conversation',
        targetBody: null,
        authorId: otherId ?? null, authorName: other?.name ?? null, authorRole: other?.role ?? null,
      };
    }

    case 'user': {
      /**
       * Resolved, but a miss is NOT treated as "does not exist" by the caller.
       *
       * There is deliberately no existence check on a user report: answering
       * differently for a real id and an invented one turns the report endpoint
       * into a membership oracle over a platform of minors, which is the exact
       * leak `server/messaging.js` already had to close once. An unknown id
       * files a report that the queue renders as an unknown account.
       */
      const row = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(targetId);
      if (!row) return { ...empty, exists: false };
      return {
        ...empty, exists: true,
        targetName: row.name, targetBody: null,
        authorId: row.id, authorName: row.name, authorRole: row.role,
      };
    }

    default:
      return empty;
  }
}

/* ── Evidence ──────────────────────────────────────────────────────────────
 *
 * How many messages get snapshotted, and why context rather than the single
 * reported line.
 *
 * "Sure, whatever you want" means nothing on its own and everything after the
 * message before it. A single-line snapshot is the shape of evidence that gets
 * a report dismissed. So a message report captures the messages either side of
 * it, and a conversation report captures the thread.
 *
 * The old conversation snapshot was capped at twenty caller-named ids or the
 * last ten messages, which is why message eleven of a reported conversation was
 * being swept by retention while the investigation was still open (PR-1 fixed
 * the sweep; this fixes the snapshot).
 */
export const EVIDENCE_CONTEXT_BEFORE = 10;
export const EVIDENCE_CONTEXT_AFTER = 10;
export const EVIDENCE_CONVERSATION_CAP = 500;

/** The messages to freeze for a report, oldest first. */
export function collectEvidence(db, { targetType, targetId, conversationId }) {
  if (targetType === 'message') {
    const anchor = db.prepare(
      'SELECT conversation_id, created_at FROM messages WHERE id = ?'
    ).get(targetId);
    if (!anchor) return [];
    const before = db.prepare(`
      SELECT id, sender_id, body, created_at FROM messages
      WHERE conversation_id = ? AND created_at <= ?
      ORDER BY created_at DESC LIMIT ?
    `).all(anchor.conversation_id, anchor.created_at, EVIDENCE_CONTEXT_BEFORE + 1).reverse();
    const after = db.prepare(`
      SELECT id, sender_id, body, created_at FROM messages
      WHERE conversation_id = ? AND created_at > ?
      ORDER BY created_at ASC LIMIT ?
    `).all(anchor.conversation_id, anchor.created_at, EVIDENCE_CONTEXT_AFTER);
    return [...before, ...after];
  }

  if (targetType === 'conversation' && conversationId) {
    return db.prepare(`
      SELECT id, sender_id, body, created_at FROM messages
      WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?
    `).all(conversationId, EVIDENCE_CONVERSATION_CAP);
  }

  return [];
}
