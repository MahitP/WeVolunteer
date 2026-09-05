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
/* The platform's name, so the visibility copy does not hardcode it. This is
   the CLIENT half of the policy module, so a client import is safe here —
   `server/organizationPolicy.js` still imports nothing at all, which is what
   makes it re-exportable to the browser at all. */
import { APP_NAME } from './config';

export {
  JOIN_POLICIES,
  INVITE_POLICIES,
  JOIN_AFFORDANCES,
  VISIBILITIES,
  DEFAULT_JOIN_POLICY,
  DEFAULT_INVITE_POLICY,
  DEFAULT_VISIBILITY,
  NOTE_MAX,
  normaliseJoinPolicy,
  normaliseInvitePolicy,
  normaliseVisibility,
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
    /**
     * Two second-order facts, and the second one is a safety warning.
     *
     * A manager switching TO this setting is the person who needs to hear that
     * links they handed out while the club was open are now the way in —
     * nothing rotates them on a policy change (a link on a printed flyer has to
     * keep working), so a link that was posted publicly under "anybody may
     * join" becomes a credential the moment this is chosen.
     */
    note: 'Signed-in students can still find you in search and are told they need a link, '
      + 'rather than being unable to find you at all. Any invitation link you have already '
      + 'shared becomes a way in — check where you have posted them, and regenerate any you '
      + 'put somewhere public. Whether you have a page somebody without an account can open '
      + 'is the separate setting below.',
  },
  request: {
    label: 'Request to join',
    consequence: 'Students ask to join, and a manager accepts or declines.',
  },
});

/**
 * Whether the club has a page a stranger can open.
 *
 * ── Written in terms of who can SEE, never of who can join ──
 *
 * The mistake this copy exists to prevent is a manager reading "public" as
 * "anybody can join". They are separate settings on purpose — a public club
 * that admits by invitation is the combination a school club actually asks for
 * — so each sentence here says what changes about LOOKING and explicitly leaves
 * joining to the setting above it.
 */
export const VISIBILITY_COPY = Object.freeze({
  public: {
    label: 'Anyone can see this page',
    consequence: 'This organization has a web address that works without an account, so you '
      + 'can put it on a poster or in a bio.',
    /**
     * The disclosure list, and it has to be COMPLETE.
     *
     * "never … never" makes this read as an inventory, which is exactly how a
     * safety statement about children is read. It is asserted field-for-field
     * against `publicOrganization`'s allowlist in
     * `src/organizationPolicy.copy.test.js`, because a list that drifts from
     * the projection is worse than no list: a manager who read it would have
     * been told something untrue about what they published.
     */
    note: 'It shows your name, description, logo, tags, how many members you have, how many '
      + 'opportunities you have run, and what is coming up — never who is in it, and never '
      + 'where an event is.',
  },
  unlisted: {
    label: `Only people signed in to ${APP_NAME}`,
    consequence: `Somebody without an account sees nothing at all. Anybody with a ${APP_NAME} `
      + 'account can still find this organization in search, and your invitation links still '
      + 'work for anybody you send them to.',
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
      /* "will see … and decide", not "reads every request and decides". There
         is no expiry, no reminder and no escalation on a request, so the
         stronger wording is a guarantee of a reply that the product cannot
         keep — and the audience reads it as one. `pending` below already got
         this right; these two are aligned to it. */
      return `A manager of ${club} will see your request and decide.`;
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
