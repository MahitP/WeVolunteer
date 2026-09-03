/**
 * Client mirror of the server's membership policy.
 *
 * Re-exported rather than copied, for the reason `src/organizationTags.js` and
 * `src/authz.js` both give at length: two copies of a rule drift, and the
 * direction they drift in is "the UI offers something the API rejects". The
 * settings form has to name the three join modes and the two invite modes, and
 * the page has to name the seven affordances; all of those come from here.
 *
 * `server/organizationPolicy.js` imports nothing at all — no `node:` module, no
 * `process` read — which is what makes this safe to pull into the browser
 * bundle. See `src/serverModuleBoundary.test.js` for what happens when a
 * re-exported server module is not that pure.
 *
 * `joinAffordance` is deliberately NOT re-exported. The server computes it and
 * ships the answer; a client that could compute it would eventually be the
 * second implementation of the policy, which is the whole thing this file is
 * arranged to prevent.
 */
export {
  JOIN_POLICIES,
  INVITE_POLICIES,
  JOIN_AFFORDANCES,
  DEFAULT_JOIN_POLICY,
  DEFAULT_INVITE_POLICY,
  normaliseJoinPolicy,
  normaliseInvitePolicy,
} from '../server/organizationPolicy.js';

/**
 * What each join setting means, in the words a manager reads.
 *
 * ── Why the consequence and not the name ──
 *
 * A settings screen that says `membership_mode = INVITE_ONLY` has told the
 * manager the value and not the effect. Each entry here carries a short label
 * for the control and one sentence of consequence beneath it, because the
 * decision being made — who can get into a club full of children — is one
 * somebody should understand before they save it, not after a student tells
 * them the Join button stopped working.
 *
 * `note` is the second-order consequence, shown only where it is not obvious:
 * that an invitation-only club is still findable, which is the thing managers
 * most often assume the setting changes.
 */
export const JOIN_POLICY_COPY = Object.freeze({
  open: {
    label: 'Anyone',
    consequence: 'Students can join this organization straight away.',
  },
  invite: {
    label: 'Invitation only',
    consequence: 'Students need this organization’s invitation link to join.',
    note: 'It still appears in search. People without the link are told they need one, '
      + 'rather than being unable to find you.',
  },
  request: {
    label: 'Request to join',
    consequence: 'Students ask to join, and a manager accepts or declines.',
  },
});

/** The same, for who may hand the invitation link on. */
export const INVITE_POLICY_COPY = Object.freeze({
  helpers: {
    label: 'Managers and student organizers',
    consequence: 'The people who help run this organization can share the link.',
  },
  members: {
    label: 'Any member',
    consequence: 'Everybody in this organization can share the link.',
  },
});

/**
 * The sentence the page puts under the primary action.
 *
 * One line, in the second person where the reader is the one it applies to.
 * Written per affordance rather than per policy, because "you need an
 * invitation" and "this club admits by invitation" are the same policy and
 * different sentences depending on whether the reader has one.
 */
export function joinPolicySentence(affordance, { policy, organizationName } = {}) {
  const club = organizationName || 'this organization';
  switch (affordance) {
    case 'join':
      return policy === 'invite'
        ? 'You have an invitation, so you can join now.'
        : `Anyone can join ${club}.`;
    case 'request':
      return 'A manager reads every request and decides.';
    case 'pending':
      return 'A manager will look at your request. You can take it back at any time.';
    case 'invite_required':
      return `${club} admits members by invitation. Ask somebody in it for the link.`;
    case 'member':
      return 'You are told when this organization posts a new opportunity.';
    case 'unavailable':
      return 'This organization is not taking new members.';
    default:
      return '';
  }
}
