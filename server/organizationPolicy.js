/**
 * Who may join an organization, who may hand out its link, and what the button
 * in front of a given reader should therefore say.
 *
 * ── Why this is a module with no imports ──
 *
 * The vocabulary is needed in three places that must not be able to disagree:
 * the validator that accepts a manager's setting, the join handler that enforces
 * it, and the browser, which renders the words. `server/organizationTags.js`
 * already exists for exactly this reason — the organization form needs the tag
 * rules in the client, and `organizations.js` imports `node:crypto`. Same shape
 * here: nothing but data and pure functions, so the client bundle can import it
 * the way `src/eventTags.js` and `src/organizationTags.js` already do.
 *
 * ── Why the affordance is computed HERE and not in the page ──
 *
 * There are seven things the primary control can say, and which one is right
 * depends on the policy, the membership row, an active ban, the organization's
 * status, and whether the caller presented a valid invitation link. A client
 * holding its own copy of that rule would be a second implementation of the
 * membership policy, and the direction it would drift is the one the codebase
 * already names as the failure: the UI offers a button the API rejects.
 *
 * So the server computes `joinAffordance` once, ships the answer, and the page
 * renders it — exactly as `viewer.canPost` already works.
 */

/**
 * How somebody becomes a member.
 *
 *   open     anyone who can see the organization may join it outright.
 *   invite   joining requires this organization's invitation link. The
 *            organization is still listed in browse and in search: discovering
 *            a club and being allowed into it are different questions, and one
 *            that vanished from search would look broken rather than private.
 *   request  a student asks, and a manager accepts or declines.
 */
export const JOIN_POLICIES = Object.freeze(['open', 'invite', 'request']);

/**
 * Who may hand out the invitation link.
 *
 *   helpers  managers and student organizers — exactly `canHelpRun`.
 *   members  anybody in the organization.
 *
 * Deliberately two values and not three. The rank vocabulary already treats
 * managers and student organizers as one tier for the club's routine work —
 * that is what `canHelpRun` exists to express — and sharing a link is more
 * routine than posting an event. A `managers` tier here would be the only place
 * in the product where a student organizer is trusted less than a manager for an
 * everyday act.
 *
 * This governs SHARING only. Creating, rotating and switching the link off is
 * always `canManage`, because those three are decisions about the club's front
 * door rather than about passing its address on.
 */
export const INVITE_POLICIES = Object.freeze(['helpers', 'members']);

/**
 * Whether the club's page opens to somebody with no account.
 *
 * ── Why this is a second axis and not a fourth join mode ──
 *
 * `join_policy` answers "who may become a member". This answers "who may LOOK".
 * Folding them into one enum produces states nobody wants to name — an `open`
 * club that cannot be found, an `unlisted` club anyone may join — and the useful
 * combination is precisely the one a single enum cannot express: findable, with
 * a door. That is a `public` club whose `join_policy` is `invite`, and it is what
 * a school club actually asks for.
 *
 *   public    the canonical handle opens without a session, and the club appears
 *             in public discovery.
 *   unlisted  the handle needs a session. Members and managers see no
 *             difference; a stranger sees nothing at all.
 *
 * Two values, not three. "Members only" would be a third that changes nothing a
 * manager can observe: an unlisted club is already invisible to a stranger, and
 * to a signed-in non-member it is exactly as visible as the directory already
 * makes it.
 */
export const VISIBILITIES = Object.freeze(['public', 'unlisted']);

/**
 * How long the optional note on a request or an invitation may be.
 *
 * ── One bound with one name, and it lives here ──
 *
 * A student writing "why I want to join" and a manager writing "why we thought
 * of you" are the same kind of value: one line, written once, read by the other
 * party, never editable and never repliable. Two constants would be two numbers
 * to keep in step for no reason anybody could state.
 *
 * It is declared in THIS module rather than beside either feature because both
 * `organizationJoinRequests.js` and `organizationInvitations.js` import
 * `node:crypto`, so neither can be pulled into the browser bundle — and the
 * dialogs that draw the character counter need the number. This module imports
 * nothing at all, which is exactly what makes it re-exportable to the client
 * (see `src/organizationPolicy.js` and `serverModuleBoundary.test.js` for what
 * happens when a re-exported server module is not that pure).
 *
 * Three hundred characters, because the bound is what stops a note from
 * becoming something it must not become. `message.send` is a capability with a
 * Report button and a conversation behind it, and a club's front door is not
 * the place to build a second one without either.
 */
export const NOTE_MAX = 300;

/**
 * The default for a NEW organization, which is deliberately not the value
 * migration 063 backfills onto existing ones.
 *
 * A club created today is created in a product that offers a public page, by
 * somebody looking at the setting. Every club that already existed was created
 * when the page required a session, and nobody running one agreed to publish it
 * — so the migration takes the safe direction and creation takes the useful one.
 * The asymmetry is the privacy argument, and it is stated in both places.
 */
export const DEFAULT_VISIBILITY = 'public';

export const DEFAULT_JOIN_POLICY = 'open';
export const DEFAULT_INVITE_POLICY = 'helpers';

/**
 * A stored value, made safe to branch on.
 *
 * Migration 062 deliberately carries no CHECK constraint (SQLite cannot add one
 * without rebuilding `organizations`), so a value outside the vocabulary is
 * reachable — by a hand-edited row, by a restore from a future version, or by a
 * bug. Both normalisers therefore fail CLOSED: an unrecognised join policy is
 * read as `invite`, which is the mode that admits the fewest people, and an
 * unrecognised invite policy is read as `helpers`, which is the narrower of the
 * two. A wrong value can only ever make the product stricter.
 */
export function normaliseJoinPolicy(value) {
  if (value === 'open' || value === 'request') return value;
  /* Anything else — including `'invite'` itself, NULL, and a typo. */
  return 'invite';
}

export function normaliseInvitePolicy(value) {
  return value === 'members' ? 'members' : 'helpers';
}

/**
 * Fails closed towards NOT publishing.
 *
 * Only the exact string `'public'` opens a club to a stranger. Anything else —
 * a typo, a NULL from a row that predates the column, a value from a future
 * version — is read as `unlisted`, so a wrong value can only ever publish less.
 * The opposite default would mean a bad row silently exposes a club that never
 * chose to be exposed.
 */
export function normaliseVisibility(value) {
  return value === 'public' ? 'public' : 'unlisted';
}

/** True when a stranger with no session may read this club's public projection. */
export const isPubliclyVisible = (org) =>
  normaliseVisibility(org?.visibility) === 'public' && org?.status === 'active';

/**
 * Every state the primary control can be in.
 *
 * Exported so the client can name them without spelling literals, and so a test
 * can assert the set is exhausted rather than assert seven strings.
 */
export const JOIN_AFFORDANCES = Object.freeze([
  /** Press Join and you are in. */
  'join',
  /** Press Request to join, and wait for a manager. */
  'request',
  /** You have already asked, and nobody has decided yet. */
  'pending',
  /** This club admits by link only, and you do not have one. */
  'invite_required',
  /** You are already in. */
  'member',
  /** A standing ban. The appeal route is the only thing on offer. */
  'banned',
  /** Archived, or an account that cannot hold membership at all. */
  'unavailable',
]);

/**
 * What this reader may do about membership, and why.
 *
 * Pure: it is handed facts and returns a description. Every input is something
 * the caller has already read from the database, so this can be unit tested
 * without one — the property that lets the affordance table be exercised
 * exhaustively rather than through seven route tests.
 *
 * @param {object}  args
 * @param {string}  args.joinPolicy    the organization's stored `join_policy`
 * @param {string}  args.status        the organization's `status`
 * @param {boolean} args.isMember      does a membership row exist
 * @param {boolean} args.isBanned      is there an unlifted ban
 * @param {boolean} args.hasPendingRequest
 * @param {boolean} args.canJoinAtAll  does the principal hold `organization.join`
 * @param {boolean} args.hasInvite     did the caller present a valid link for
 *                                     THIS organization
 * @returns {{ action: string, policy: string }}
 */
export function joinAffordance({
  joinPolicy,
  status = 'active',
  isMember = false,
  isBanned = false,
  hasPendingRequest = false,
  canJoinAtAll = true,
  hasInvite = false,
} = {}) {
  const policy = normaliseJoinPolicy(joinPolicy);

  /**
   * Order matters, and this is the order.
   *
   * Membership first, because a member who was somehow also banned should be
   * shown the state they are actually in rather than an appeal form for a club
   * they are standing in. Then the ban, which overrides every offer. Then a
   * pending request, because "you already asked" answers the question before the
   * policy does. Only then does the policy get to speak.
   */
  if (isMember) return { action: 'member', policy };
  if (isBanned) return { action: 'banned', policy };
  if (status !== 'active' || !canJoinAtAll) return { action: 'unavailable', policy };
  if (hasPendingRequest) return { action: 'pending', policy };

  if (policy === 'open') return { action: 'join', policy };
  if (policy === 'request') return { action: 'request', policy };
  /* invite */
  return { action: hasInvite ? 'join' : 'invite_required', policy };
}

/**
 * Whether the affordance means "this press creates a membership row".
 *
 * One predicate rather than `action === 'join'` written at each call site: the
 * join route, the page and the tests all have to agree about it, and a fourth
 * caller added later should not have to rediscover which of the seven values is
 * the one that admits somebody.
 */
export const affordanceAdmits = (action) => action === 'join';
