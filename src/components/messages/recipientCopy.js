import { can } from '../../authz.js';

/**
 * What every messaging surface tells each kind of account.
 *
 * Originally just the "New message" dialog, which is why the file is named for
 * the recipient picker. It now also carries the three EMPTY STATES, because they
 * had the same defect for the same reason and fixing them anywhere else would
 * have meant a second cascade that could disagree with this one about who the
 * reader is.
 *
 * ── The defect ──
 *
 * One sentence was shown to everybody: "You can message the organizer of an
 * event you have applied to." That is true of a student and of nobody else.
 *
 * An organizer saw it backwards — they message the volunteers who applied to
 * THEIR events, which is the opposite direction. An administrator saw it
 * backwards too, and then searched a list that is almost always empty for them
 * (see below). A partner saw a promise the server will never fulfil: the search
 * cascade has no branch for them, so their results are unconditionally `[]`.
 *
 * A dialog that tells three of four audiences the wrong thing is worse than one
 * that says nothing, because they act on it and then think the search is broken.
 *
 * ── Derived from capabilities, in the server's own order ──
 *
 * `GET /api/messages/users/search` picks its query with a capability cascade,
 * and this mirrors it rather than guessing from a role name — role strings in
 * client code fail the build (`authz.completeness.test.js` guard 3), and the
 * reason behind that guard applies here in full: `can()` answers true for EVERY
 * capability when the principal is super_admin, so a cascade that is not
 * ordered most-privileged-first silently hands the owner somebody else's copy.
 *
 * The one place this cascade is deliberately FINER than the server's: the server
 * runs a single branch for `applicant.review || event.moderate`, because an
 * organizer and an administrator want the same query. They do not want the same
 * sentence, so `event.moderate` is split out and tested first.
 */

/**
 * The administrator case is the one worth explaining.
 *
 * The staff branch of the search joins `events e ON a.event_id = e.id WHERE
 * e.organizer_id = ?` — applicants to events THE CALLER ORGANIZES. An
 * administrator typically organizes none, so the picker searches an empty set
 * however careful their spelling.
 *
 * That is not a bug in the query. Contacting somebody about a report goes
 * through `POST /api/messages/admin/conversations/resolve`, gated on
 * `report.resolve` and opened from the Moderation Center, which is also what
 * writes the `ADMIN_CONVERSATION_OPENED` audit row. Reaching an arbitrary
 * student from a general-purpose search box is exactly what that endpoint's
 * own header says must not be possible.
 *
 * So the honest thing to tell an administrator is where the door actually is.
 */
const ENTRIES = [
  {
    cap: 'event.moderate',
    description:
      'You can message volunteers who applied to events you organize. To contact '
      + 'someone about a report, open the conversation from the Admin area — '
      + 'that way it is recorded against the case.',
    placeholder: 'Search volunteers who applied to your events…',
    empty: 'Nobody matched. Administrators reach a person about a report from the '
      + 'Admin area, not from here.',
    /**
     * An administrator's threads are moderation conversations, opened from a
     * report. Calling them "volunteer opportunity conversations" — which is what
     * every account used to be told — describes the one kind of thread an
     * administrator does not have.
     */
    listEmpty: 'No conversations yet. One appears here when you contact somebody about a report.',
    noneSelected: {
      title: 'Select a conversation',
      body: 'Moderation conversations you have opened appear on the left. Each one is '
        + 'recorded against the report it came from.',
    },
    threadEmpty: {
      title: 'Start the conversation',
      body: 'Say why you are getting in touch. This person can see everything you write '
        + 'here, and so can any administrator reviewing the report afterwards.',
    },
  },
  {
    cap: 'applicant.review',
    description: 'You can message volunteers who have applied to your events.',
    placeholder: 'Search your applicants…',
    empty: 'Nobody matched. You can message a volunteer once they have applied to one '
      + 'of your events.',
    listEmpty: 'No conversations yet. One appears here when you message a volunteer who '
      + 'applied to one of your events, or when one of them messages you.',
    noneSelected: {
      title: 'Select a conversation',
      body: 'Choose a volunteer on the left to talk about the shift they applied for.',
    },
    threadEmpty: {
      title: 'Start the conversation',
      body: 'Confirm the details, answer questions, and let them know what to bring.',
    },
  },
  /**
   * ── A member reaches TWO groups, and this used to name one ──
   *
   * Every sentence here said "organizer" and only "organizer", which was
   * accurate while the schema had no shape for a student↔student thread. It
   * does now (migration 035), so the copy described a narrower product than the
   * one behind it: a student who wanted to message a friend was told, in the
   * dialog for doing exactly that, that they could message organizers.
   *
   * Both audiences are named in the same breath rather than in two sentences.
   * "Friends" is first because it is the one that changed and the one a member
   * is more likely to be looking for; the organizer half is unchanged in
   * substance so that nobody reads the new wording as a replacement.
   *
   * The friendship condition is stated ("you are friends with", "once you are
   * friends") rather than left implied, because the alternative reading —
   * message anyone you can find — is both wrong and the one a search box invites.
   */
  {
    cap: 'application.withdraw',
    description: 'You can message your friends, and the organizer of an event you have '
      + 'applied to.',
    placeholder: 'Search friends and organizers…',
    empty: 'Nobody matched. You can message someone once you are friends, or once you '
      + 'have applied to one of their events.',
    listEmpty: 'No conversations yet. One appears here when you message a friend or the '
      + 'organizer of an event you have applied to, or when they message you.',
    noneSelected: {
      title: 'Select a conversation',
      body: 'Choose someone on the left — a friend, or an organizer you can ask about a '
        + 'shift you applied for.',
    },
    threadEmpty: {
      title: 'Start the conversation',
      body: 'Say hello, or ask about the shift, the place, or what to bring. Messages to '
        + 'an organizer are read by an adult at the organization.',
    },
  },
];

/**
 * Ends in an explicit fallback, never a bare last entry.
 *
 * A partner holds none of the three capabilities and the server has no branch
 * for them, so their search cannot return anything. Saying so is the only
 * honest option; letting them fall through to a student's sentence would send
 * them looking for a feature that does not exist for their account.
 */
const NONE = {
  description: 'Messaging is not available for this account.',
  placeholder: 'Search…',
  empty: 'Messaging is not available for this account.',
  listEmpty: 'Messaging is not available for this account.',
  noneSelected: {
    title: 'Messaging is not available',
    body: 'This account cannot start or receive conversations.',
  },
  threadEmpty: {
    title: 'Messaging is not available',
    body: 'This account cannot start or receive conversations.',
  },
};

/** The copy for `user`. Never null — callers render this unconditionally. */
export function recipientCopyFor(user) {
  return ENTRIES.find((e) => can(user, e.cap)) ?? NONE;
}
