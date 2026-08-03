/**
 * Capability-based authorization.
 *
 * Before this module, authorization was ~40 copies of `req.user.role !== 'admin'`
 * spread across route files. That pattern has one fatal property: adding a role
 * silently DENIES it everywhere, because 'super_admin' !== 'admin' is true. The
 * platform owner would have been locked out of every admin route, and no test
 * would have failed.
 *
 * Route files now ask for a named capability and never look at a role string.
 * `authz.completeness.test.js` enforces that.
 *
 * ── The cascade rule (read this before writing an if/else-if over can()) ──
 *
 * `super_admin` holds the '*' wildcard, so `can()` returns TRUE for every
 * capability it is asked about. A chain of `else if (can(...))` branches is
 * therefore NOT a set of mutually exclusive cases: a wildcard principal matches
 * whichever branch happens to be tested first. Two rules follow, and both are
 * load-bearing:
 *
 *   1. Order branches MOST-PRIVILEGED-FIRST. Testing the narrow capability
 *      first (say `application.withdraw`, held by students) captures the
 *      wildcard in the narrow branch, and super_admin silently gets a student's
 *      scoped view of the data — a content bug no status-code assertion can
 *      see, because the response is still a 200.
 *
 *   2. End the cascade in an EXPLICIT deny/empty branch, never a bare `else`.
 *      "No recognised capability" must default to seeing and doing nothing. A
 *      trailing `else` that grants unscoped access hands every future role
 *      full reach on the day it is added — which is the exact class of bug
 *      this module exists to eliminate, just inverted.
 *
 * Worked examples: applicationRoutes.js's GET /api/applications scoping and
 * messageRoutes.js's user-search scoping.
 *
 * This module is pure: it imports nothing at all — no db.js, no utils.js, no
 * config.js — so it is unit-testable with no fixtures, cannot decay into a
 * data-access layer, and stays cheap for `src/authz.js` to mirror into the
 * client bundle. `authz.test.js`'s module-hygiene test enforces that.
 */

export const ROLES = ['student', 'organizer', 'admin', 'super_admin', 'partner'];

export const CAPABILITIES = {
  student: [
    'event.view', 'event.apply', 'application.withdraw',
    'self.read', 'self.write', 'portfolio.write', 'message.send', 'qr.present',
    // A student reading their own volunteer statistics (Task 7d). Organizers
    // cannot reach GET /api/stats/volunteer today (the handler denies anyone
    // whose role is not 'student'), so this stays a student-only capability
    // rather than being widened to organizer as well.
    'stats.self',
  ],
  organizer: [
    'event.view', 'event.create', 'event.edit.own', 'applicant.review',
    'attendance.mark', 'attendance.view', 'attendance.scan', 'announcement.post',
    'message.send', 'self.read', 'self.write', 'service.verify.own_event',
    'geocode.use',
    // An organizer reading statistics for the events they run (Task 7d).
    'analytics.own_events',
  ],
  admin: [
    'event.view', 'event.moderate', 'organizer.approve', 'user.suspend',
    'report.resolve', 'audit.read', 'analytics.school',
    'service.verify.external', 'capability.grant',
    'attendance.mark', 'attendance.view',
    'self.read', 'self.write', 'geocode.use',
    // Deliberate widening (Task 7d, same pattern as attendanceRoutes.js's
    // attendance.mark correction in Task 7b): GET /api/stats/organizer denies
    // admin today (`role !== 'organizer'`), which is an inconsistency with the
    // rest of admin's platform-wide oversight capabilities — an admin can see
    // every application and every event, but not one organizer's own stats
    // page. `analytics.own_events` closes that gap.
    'analytics.own_events',
  ],
  super_admin: ['*'],
  // `event.view` and `geocode.use`: neither route these gate (GET
  // /api/organizers/:id/profile, GET /api/geocode) has ever had a partner-
  // specific restriction — today's role checks only ever named 'student' or
  // 'admin'/'organizer', so partner already passes both. Granting the
  // capabilities keeps that unchanged now that the routes ask `can()` instead
  // of comparing role strings.
  partner: ['analytics.public', 'event.view', 'geocode.use'],
};

/**
 * Capabilities only super_admin may hold.
 *
 * Declared explicitly rather than left implicit under the '*' wildcard, because
 * `can()` refuses any capability not named somewhere in this file. Without this
 * list a typo ('error.raed') would resolve TRUE for super_admin and 403 for
 * everyone else — the worst kind of authorization bug, because it looks like it
 * works when the person testing it is the owner.
 */
export const SUPER_ONLY = [
  'error.read', 'error.write',
  'analytics.platform',
  'impersonation.start',
  'admin.create',
];

export const ALL_CAPABILITIES = [...new Set([
  ...Object.values(CAPABILITIES).flat().filter(c => c !== '*'),
  ...SUPER_ONLY,
])].sort();

const CAPABILITY_SET = new Set(ALL_CAPABILITIES);
const SUPER_ONLY_SET = new Set(SUPER_ONLY);

/**
 * Builds the request principal from a users row.
 *
 * `effectiveRole` is separate from `actualRole` so impersonation (v2.0) is a
 * change of the effective role only — never a second role on the account.
 *
 * `aal` and `aalAction` travel together and are meaningless apart. AAL2 is
 * never a general property of a session — it is always "this request proved
 * identity, for THIS action" — so the field naming the action defaults to null
 * and is always present, rather than appearing only on re-verified requests.
 * An always-present field is one `requireAAL2` can compare without first
 * asking whether assurance resolution ran at all.
 */
export function principalFor(
  userRow,
  { grants = [], aal = 1, aalAction = null, actorId = null, effectiveRole = null } = {}
) {
  if (!userRow) return null;
  return {
    userId: userRow.id,
    actualRole: userRow.role,
    effectiveRole: effectiveRole || userRow.role,
    actorId,
    grants,
    aal,
    aalAction,
    impersonating: Boolean(actorId),
  };
}

/** Deny-by-default authorization decision. */
export function can(principal, capability) {
  if (!principal || !capability) return false;
  if (!CAPABILITY_SET.has(capability)) return false;   // unknown/typo → deny, always

  const role = principal.effectiveRole;
  if (!ROLES.includes(role)) return false;

  const roleCaps = CAPABILITIES[role] || [];
  if (roleCaps.includes('*')) return true;             // super_admin
  if (roleCaps.includes(capability)) return true;

  // Per-user grants (Task 4) extend a role, but can never reach a super-only
  // capability — otherwise `capability.grant` would be a path to root.
  if (SUPER_ONLY_SET.has(capability)) return false;
  return Array.isArray(principal.grants) && principal.grants.includes(capability);
}

/**
 * The only authorization primitive route files may use.
 *
 * Must be mounted AFTER authenticateToken, which is what populates
 * req.principal. A missing principal is a 401 (not authenticated), never a 403,
 * because the two mean different things to a client: one says "sign in", the
 * other says "you cannot do this".
 */
export function requireCap(capability) {
  if (!ALL_CAPABILITIES.includes(capability)) {
    // Thrown at module load, not per request, so a typo fails the boot and the
    // test suite rather than quietly 403ing in production.
    throw new Error(`requireCap: unknown capability '${capability}'`);
  }
  return function capabilityGate(req, res, next) {
    if (!req.principal) return res.status(401).json({ error: 'Access token required' });
    if (!can(req.principal, capability)) return res.status(403).json({ error: 'Access denied' });
    return next();
  };
}

/**
 * Like `requireCap`, but passes if the principal holds ANY of the listed
 * capabilities.
 *
 * Exists for routes an admin and an organizer both legitimately reach through
 * two different capabilities (e.g. `event.moderate` for admin's platform-wide
 * reach, `applicant.review` for the organizer who owns the event). A single
 * `requireCap` would 403 whichever side's capability was not named, at the
 * middleware layer, before any per-row ownership check could run.
 *
 * The returned middleware is deliberately also named `capabilityGate` — the
 * same name `requireCap` uses — so a single detector (Task 8's completeness
 * test) recognises both as coverage without special-casing either.
 */
export function requireCapAny(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    // A gate with nothing to check admits everyone, which is never intended —
    // fail the boot rather than silently no-op the route's authorization.
    throw new Error('requireCapAny: capabilities must be a non-empty array');
  }
  for (const capability of capabilities) {
    if (!ALL_CAPABILITIES.includes(capability)) {
      // Thrown at module load, not per request, so a typo fails the boot and
      // the test suite rather than quietly 403ing in production.
      throw new Error(`requireCapAny: unknown capability '${capability}'`);
    }
  }
  return function capabilityGate(req, res, next) {
    if (!req.principal) return res.status(401).json({ error: 'Access token required' });
    if (!capabilities.some((capability) => can(req.principal, capability))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    return next();
  };
}

/**
 * Requires a fresh proof of identity for this action.
 *
 * Mounted after authenticateToken and after any requireCap — capability first
 * ("may this kind of actor ever do this"), then assurance ("prove it is still
 * you"). Reversing them tells an unauthorised caller that re-verifying might
 * help, which it never would.
 *
 * ── Why `code: 'reauth_required'` and not a bare 403 ──
 *
 * A bare 403 says "you may never do this". This one says "prove yourself and
 * try again", and those are different instructions for the client: one is a
 * dead end, the other is a prompt. Conflating them means the UI either offers
 * re-verification for genuinely forbidden actions or offers nothing for
 * recoverable ones.
 *
 * ── Why the action is compared, not merely the level ──
 *
 * Assurance is never a property of a session, only of a request: a grant
 * proves identity for ONE action. Checking `aal >= 2` alone would let a
 * verification obtained to change an email address delete the account instead.
 * `aalAction` is what `authenticateToken` resolved this request's grant to be
 * for, and it must be this route's action.
 *
 * This gate is not the authority on params, and does not pretend to be —
 * `consumeChallenge`, inside the handler's transaction, re-checks the action,
 * the params, the session and single use before the work is allowed to land.
 * This is the cheap early refusal that keeps the handler from starting.
 *
 * `action` is validated against the sensitive-action registry at the CALL SITE
 * in route files, not here: importing sensitiveActions.js would cost this
 * module its zero-imports property, which authz.test.js asserts and which is
 * what lets src/authz.js mirror the table into the client bundle.
 *
 * Pure: reads a value already resolved onto the principal and performs no I/O.
 */
export function requireAAL2(action) {
  // Thrown at module load, not per request. A gate built with no action would
  // compare `undefined` against `principal.aalAction` and refuse every caller
  // forever — a route that is 403 for everyone, discovered in production.
  if (!action) throw new Error('requireAAL2: an action is required');
  return function assuranceGate(req, res, next) {
    if (!req.principal) return res.status(401).json({ error: 'Access token required' });
    if (req.principal.aal < 2 || req.principal.aalAction !== action) {
      return res.status(403).json({ error: 'Identity verification required', code: 'reauth_required', action });
    }
    return next();
  };
}
