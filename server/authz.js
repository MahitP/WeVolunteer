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
 * This module is pure: it imports nothing from db.js, so it is unit-testable
 * with no fixtures and cannot decay into a data-access layer.
 */

export const ROLES = ['student', 'organizer', 'admin', 'super_admin', 'partner'];

export const CAPABILITIES = {
  student: [
    'event.view', 'event.apply', 'application.withdraw',
    'self.read', 'self.write', 'portfolio.write', 'message.send', 'qr.present',
  ],
  organizer: [
    'event.view', 'event.create', 'event.edit.own', 'applicant.review',
    'attendance.mark', 'attendance.scan', 'announcement.post',
    'message.send', 'self.read', 'self.write', 'service.verify.own_event',
    'geocode.use',
  ],
  admin: [
    'event.view', 'event.moderate', 'organizer.approve', 'user.suspend',
    'report.resolve', 'audit.read', 'analytics.school',
    'service.verify.external', 'capability.grant',
    'attendance.mark', 'attendance.view',
    'self.read', 'self.write', 'geocode.use',
  ],
  super_admin: ['*'],
  partner: ['analytics.public'],
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
 */
export function principalFor(userRow, { grants = [], aal = 1, actorId = null, effectiveRole = null } = {}) {
  if (!userRow) return null;
  return {
    userId: userRow.id,
    actualRole: userRow.role,
    effectiveRole: effectiveRole || userRow.role,
    actorId,
    grants,
    aal,
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
