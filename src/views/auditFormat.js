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
  /* The owner browsing as another role. NOTABLE rather than routine: it is the
     only action on this platform that changes what a principal may do without
     anybody having acted on somebody else, so "the owner was a student between
     14:02 and 14:31" needs to be answerable from these rows. Not GRAVE — it can
     only ever REMOVE the owner's own access (see the narrowing rule in authz.js),
     so it is a thing to be able to account for, not a thing to be alarmed by. */
  PERSONA_PREVIEW_START:    ['Started previewing as another role', TONES.NOTABLE],
  PERSONA_PREVIEW_END:      ['Stopped previewing as another role', TONES.ROUTINE],
  ACCOUNT_SUSPENDED:        ['Account suspended', TONES.GRAVE],
  ACCOUNT_UNSUSPENDED:      ['Suspension lifted', TONES.NOTABLE],
  ACCOUNT_WARNED:           ['Formal warning issued', TONES.GRAVE],
  ACCOUNT_DELETED:          ['Account deleted', TONES.GRAVE],
  /* Reading the message bodies preserved with a safety report. The most
     invasive power on this platform, and the reason the read is double-logged. */
  REPORT_EVIDENCE_VIEWED:   ['Report evidence read', TONES.GRAVE],
  /* Manual badge awards and revocations. Routine rather than notable: a badge
     is a recognition, it carries no authority, and an administrator handing one
     out is ordinary work. They are logged at all because the alternative is a
     permanent record on a student's profile that nobody can attribute — and a
     revocation, in particular, is somebody taking a recognition back off a
     child's page, which they should have to put their name to. */
  BADGE_AWARDED:            ['Badge awarded', TONES.ROUTINE],
  BADGE_REVOKED:            ['Badge revoked', TONES.ROUTINE],
  ADMIN_PROMOTED:           ['Administrator promoted', TONES.GRAVE],
  /* Invitations. `ADMIN_INVITED` is grave because a pending invitation is
     administrator authority awaiting collection — the offer is the consequential
     act, not only its acceptance. Revocation is notable rather than grave: it
     only ever removes authority. */
  ADMIN_INVITED:            ['Administrator invited', TONES.GRAVE],
  ADMIN_INVITE_ACCEPTED:    ['Administrator invitation accepted', TONES.GRAVE],
  ADMIN_INVITE_REVOKED:     ['Administrator invitation revoked', TONES.NOTABLE],
  ADMIN_REVOKED:            ['Administrator revoked', TONES.GRAVE],
  OWNER_GRANTED:            ['Ownership granted', TONES.GRAVE],
  /* Promotion from the command line, distinct from `ADMIN_PROMOTED` which is the
     in-product action. Worth telling apart: one went through a step-up
     challenge and an owner's session, the other through a shell. */
  ADMIN_PROMOTED_CLI:       ['Administrator promoted (command line)', TONES.GRAVE],
  /* Clearing somebody's second factor from a shell. Grave, and the only action
     on this platform that removes an authentication factor without anybody
     proving possession of it — so it must be conspicuous in a year of rows. */
  TFA_RESET_CLI:            ['Two-factor authentication reset (command line)', TONES.GRAVE],
  /* Deliberately NOT grave, and the distinction is the whole reason it has its
     own action name. `TFA_RESET_CLI` above removes a factor somebody was using;
     this removes an authenticator secret that was generated and never confirmed,
     which the command refuses to run unless `tfa_enabled` is 0 — so no factor the
     account relied on is touched, and nobody's access changes. Notable because it
     is still a privileged write to a credential column from a shell; grave would
     make a year of rows harder to read by crying wolf. */
  TFA_STALE_SECRET_CLEARED: ['Unconfirmed authenticator secret cleared (command line)', TONES.NOTABLE],
  OWNER_REVOKED:            ['Ownership revoked', TONES.GRAVE],
  /* The names these two carried before the CLI scripts were standardised.
     Kept because the trail is append-only and immutable: rows written under the
     old names still exist and still have to read as something. */
  OWNER_BOOTSTRAPPED:       ['Ownership granted', TONES.GRAVE],
  OWNER_RETIRED:            ['Ownership revoked', TONES.GRAVE],
  OWNER_CREDENTIAL_RESET:   ['Owner credentials reset', TONES.GRAVE],

  /* An administrator removing somebody else's content. Notable rather than
     grave — it is reversible in the sense that the person can post again — but
     it is power exercised over another person's words, which is exactly what
     this trail is for. Neither route recorded anything at all before. */
  COMMENT_DELETED:          ['Comment deleted by a moderator', TONES.NOTABLE],
  EVENT_DELETED:            ['Event deleted by an administrator', TONES.NOTABLE],
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
  ACCEPT_STUDENT_ORGANIZER_AGREEMENT: ['Student organizer agreement accepted', TONES.ROUTINE],
  /* NOTABLE, not routine: this is a student handing another student the ability
     to see classmates' details and write on their service records. */
  ORGANIZATION_RANK_CHANGED: ['Organization rank changed', TONES.NOTABLE],
  ORGANIZATION_ROSTER_EXPORTED: ['Organization roster exported', TONES.NOTABLE],

  /* Club moderation. All five are NOTABLE and none is GRAVE, deliberately.
     GRAVE is reserved for what a person cannot undo and cannot escape — a
     platform-wide lockout, or somebody reading their messages. A ban from one
     organization is exclusion from one community: the account still works,
     every other club is still open, and there is an appeal route with a
     decision at the end of it. That is the weight COMMENT_DELETED and
     EVENT_DELETED carry — power exercised over somebody else — and it is the
     right rung for these.

     Removal is NOTABLE rather than routine for the reason the route that
     writes it gives: a plain removal used to leave no trace at all, and it is
     the same act as a ban minus the bar on returning. Somebody deciding another
     student is no longer in the club is not clerical work.

     The two reversals are NOTABLE for the same reason ACCOUNT_UNSUSPENDED is.
     They only ever restore access, which is why they are not grave — but a
     standing decision being undone is exactly what somebody auditing a year of
     club moderation is looking for. */
  ORGANIZATION_BANNED:      ['Banned from an organization', TONES.NOTABLE],
  ORGANIZATION_MEMBERSHIP_REMOVED: ['Removed from an organization', TONES.NOTABLE],
  ORGANIZATION_BAN_LIFTED:  ['Organization ban lifted', TONES.NOTABLE],
  ORGANIZATION_BAN_APPEAL_REVERSED: ['Organization ban appeal upheld; ban lifted', TONES.NOTABLE],
  ORGANIZATION_BAN_APPEAL_STANDS: ['Organization ban appeal denied; ban stands', TONES.NOTABLE],

  /* Creating or editing a badge DEFINITION, which is not the same act as
     awarding one and is why it has its own pair of names. It changes what the
     platform recognises rather than who it recognises, touches nobody's profile
     on its own, and is ordinary administrative work — so ROUTINE, matching
     BADGE_AWARDED above.

     These two are older than the rest of this block and were unlabelled the
     whole time. They rendered as raw SCREAMING_SNAKE in the Audit Explorer and
     the coverage guard could not see them, because `badgeRoutes.js` picks
     between them with a ternary and the guard's scan only matched a quote
     sitting directly after `action:`. The scan reads conditional forms now. */
  BADGE_DEFINED:            ['Badge definition created', TONES.ROUTINE],
  BADGE_DEFINITION_UPDATED: ['Badge definition updated', TONES.ROUTINE],
  ERROR_GROUP_STATUS_CHANGED: ['Error group triaged', TONES.ROUTINE],
  USERNAME_DEDUPED:         ['Duplicate username resolved', TONES.ROUTINE],

  /* GRAVE, and it is the only entry here that harms nobody in particular.
     The tone scale is about consequence, and this one rewrites the agreement
     every account on the platform is held to — including people who accepted a
     different version of it years earlier and will never be asked again. There
     is no bounded set of affected users to notify and no undo, which is the
     definition the scale uses for its top rung. */
  LEGAL_DOCUMENT_PUBLISHED: ['Legal document published', TONES.GRAVE],
};

/**
 * Whether an action was given a label by hand.
 *
 * Exported for `src/auditLabelCoverage.test.js`, which scans the server for every
 * action it can write and fails the build on any that reaches this file unnamed.
 *
 * It exists because the obvious way to write that guard does not work: comparing
 * `auditLabel(action)` against the fallback's output produces a false positive on
 * every good label that happens to read like the title-cased action —
 * `ACCOUNT_DELETED` → "Account deleted" is both the fallback AND the correct
 * label. Membership is the only question with a reliable answer, so ask it here
 * where the table is, rather than inferring it from the outside.
 */
export function hasAuditLabel(action) {
  return typeof action === 'string' && Object.hasOwn(ACTIONS, action);
}

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
