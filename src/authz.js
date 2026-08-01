/**
 * Client mirror of the server capability table.
 *
 * Re-exported from the server module rather than copied, because two copies of
 * an authorization table drift, and the direction they drift in is "the UI shows
 * a button the API rejects".
 *
 * This is UX only. Every capability is re-checked server-side; hiding a control
 * here is a convenience, never a security boundary.
 */
import { can as decide, principalFor, CAPABILITIES, SUPER_ONLY, ROLES, ALL_CAPABILITIES } from '../server/authz.js';

export { CAPABILITIES, SUPER_ONLY, ROLES, ALL_CAPABILITIES };

/** `user` is the object from /api/auth/me — `{ id, role, … }`. */
export function can(user, capability) {
  if (!user) return false;
  return decide(principalFor({ id: user.id, role: user.role }, { grants: user.grants || [] }), capability);
}
