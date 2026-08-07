/**
 * Turning an audit row into something a person can read.
 *
 * ── Why this is not just cosmetics ──
 *
 * The trail is written for machines to append and for people to read months
 * later. It stored `REPORT_EVIDENCE_VIEWED` and the screen showed exactly that,
 * in caps, next to five more like it. A page of SCREAMING_SNAKE is a page nobody
 * scans: every row looks like every other row, and the one that matters —
 * somebody read a student's private messages — sits at the same weight as a
 * routine approval.
 *
 * So each action gets a sentence in the past tense, because that is what the row
 * is: a record of something that already happened.
 */

/**
 * The tone ladder.
 *
 * `grave` is reserved for the two things this platform can do to a person that
 * they cannot undo themselves: lock them out, and read their private messages.
 * They are not "errors" — they are usually correct and always consequential,
 * and an owner skimming a year of records should be able to find them without
 * reading every line.
 *
 * Deliberately not a severity COLUMN in the database. `recordAudit` rejects any
 * key outside its frozen four, and its error message says why the fifth was
 * never added: severity is a reading of an action, and a reading belongs where
 * it can be revised without rewriting history.
 */
export const TONES = Object.freeze({ GRAVE: 'grave', NOTABLE: 'notable', ROUTINE: 'routine' });

const ACTIONS = {
  ACCOUNT_SUSPENDED:        ['Account suspended', TONES.GRAVE],
  ACCOUNT_UNSUSPENDED:      ['Suspension lifted', TONES.NOTABLE],
  ACCOUNT_WARNED:           ['Formal warning issued', TONES.GRAVE],
  ACCOUNT_DELETED:          ['Account deleted', TONES.GRAVE],
  /* Reading the message bodies preserved with a safety report. The most
     invasive power on this platform, and the reason the read is double-logged. */
  REPORT_EVIDENCE_VIEWED:   ['Report evidence read', TONES.GRAVE],
  ADMIN_PROMOTED:           ['Administrator promoted', TONES.GRAVE],
  ADMIN_REVOKED:            ['Administrator revoked', TONES.GRAVE],
  OWNER_BOOTSTRAPPED:       ['Platform owner created', TONES.GRAVE],
  OWNER_RETIRED:            ['Platform owner retired', TONES.GRAVE],
  OWNER_CREDENTIAL_RESET:   ['Owner credentials reset', TONES.GRAVE],

  MODERATE_REPORT:          ['Report resolved', TONES.NOTABLE],
  MODERATE_REPORT_SELF_REVIEW: ['Report resolved by its own subject', TONES.GRAVE],
  APPEAL_REVIEWED:          ['Appeal decided', TONES.NOTABLE],
  APPEAL_REOPENED:          ['Appeal reopened', TONES.NOTABLE],
  APPEAL_VIEWED:            ['Appeal opened', TONES.ROUTINE],
  APPEAL_TOKEN_ISSUED:      ['Appeal link re-issued', TONES.NOTABLE],
  ADMIN_CONVERSATION_OPENED: ['Moderation conversation opened', TONES.NOTABLE],
  USER_BLOCKED:             ['Person blocked', TONES.ROUTINE],
  USER_UNBLOCKED:           ['Block removed', TONES.ROUTINE],
  DATA_EXPORT_REQUESTED:    ['Data export requested', TONES.NOTABLE],
  DATA_EXPORT_DOWNLOADED:   ['Data export downloaded', TONES.NOTABLE],

  APPROVE_ORGANIZER:        ['Organizer approved', TONES.ROUTINE],
  DENY_ORGANIZER:           ['Organizer declined', TONES.ROUTINE],
  ACCEPT_ORGANIZER_AGREEMENT: ['Organizer agreement accepted', TONES.ROUTINE],
  ERROR_GROUP_STATUS_CHANGED: ['Error group triaged', TONES.ROUTINE],
  USERNAME_DEDUPED:         ['Duplicate username resolved', TONES.ROUTINE],
};

/**
 * Sentence-cased from the stored name when the action is not in the table.
 *
 * A fallback rather than a blank, because the trail outlives this file: a row
 * written by a release that knew an action this build does not must still be
 * readable. `SOME_NEW_THING` becomes "Some new thing", which is worse than a
 * hand-written label and far better than nothing.
 */
export function auditLabel(action) {
  if (!action || typeof action !== 'string') return 'Unknown action';
  const known = ACTIONS[action];
  if (known) return known[0];
  const words = action.toLowerCase().replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An unrecognised action is `routine`: loud is a claim, and this build cannot make it. */
export function auditTone(action) {
  return ACTIONS[action]?.[1] ?? TONES.ROUTINE;
}

/**
 * Date AND time.
 *
 * The table showed `toLocaleDateString()` alone, so every row of a busy
 * afternoon read `8/6/2026` and the ordering — which is the whole point of an
 * append-only log — was invisible. "Which of these happened first" is the
 * question this column exists to answer.
 */
export function auditTimestamp(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { date: '—', time: '', title: '' };
  const d = new Date(t);
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    /* The full precision, on hover, for the cases where seconds settle an
       argument about ordering. */
    title: d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' }),
  };
}
