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

/**
 * `user` is the object from /api/auth/me — `{ id, role, withheld, … }`.
 *
 * ── Why `withheld` is threaded through ──
 *
 * An organizer who has not accepted the Organizer Agreement holds none of the
 * capabilities that reach a student (server/organizerAgreement.js). The server
 * computes that list per request and refuses accordingly.
 *
 * Without it here, the two tables disagree in the one direction this module's
 * header names as the failure mode: the nav would offer "New event", "Calendar"
 * and "Messages" to an organizer for whom all three 403. That is not a security
 * hole — the server is the boundary either way — but it is precisely the
 * "UI shows a button the API rejects" drift the re-export exists to prevent, and
 * it would land on an organizer who has been given no clue why.
 *
 * `|| []` rather than a required field: any payload that predates the field, or
 * any caller passing a bare `{ id, role }`, degrades to the ungated answer. That
 * is the correct direction for a UX mirror — over-offering a control the server
 * will refuse, never hiding one it would have allowed.
 */
export function can(user, capability) {
  if (!user) return false;
  return decide(
    principalFor(
      { id: user.id, role: user.role },
      { grants: user.grants || [], withheld: user.withheld || [] }
    ),
    capability
  );
}
