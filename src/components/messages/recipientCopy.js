import { can } from '../../authz.js';

/**
 * What the "New message" dialog tells each kind of account it can do.
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
      + 'someone about a report, open the conversation from the Moderation Center — '
      + 'that way it is recorded against the case.',
    placeholder: 'Search volunteers who applied to your events…',
    empty: 'Nobody matched. Administrators reach a person about a report from the '
      + 'Moderation Center, not from here.',
  },
  {
    cap: 'applicant.review',
    description: 'You can message volunteers who have applied to your events.',
    placeholder: 'Search your applicants…',
    empty: 'Nobody matched. You can message a volunteer once they have applied to one '
      + 'of your events.',
  },
  {
    cap: 'application.withdraw',
    description: 'You can message the organizer of an event you have applied to.',
    placeholder: 'Search organizers of events you applied to…',
    empty: 'Nobody matched. You can message an organizer once you have applied to one '
      + 'of their events.',
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
};

/** The copy for `user`. Never null — callers render this unconditionally. */
export function recipientCopyFor(user) {
  return ENTRIES.find((e) => can(user, e.cap)) ?? NONE;
}
