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
import { can as decide, principalFor, CAPABILITIES, SUPER_ONLY, ROLES, ROLE, ALL_CAPABILITIES } from '../server/authz.js';

/**
 * `ROLE` is re-exported for the same reason the server has it: a few decisions
 * genuinely are about which KIND of account something is, not what it may do,
 * and those need a way to name a role without hardcoding the string.
 *
 * The Administrator Roster's promotion lookup is one — "this person is already
 * an administrator" and "only students can be promoted" are statements about the
 * target's role, and there is no capability that expresses either. See the
 * header above `ROLE` in server/authz.js: the rule the completeness guard
 * enforces is "role names live in one file", not "roles are never named".
 */
export { CAPABILITIES, SUPER_ONLY, ROLES, ROLE, ALL_CAPABILITIES };

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
/**
 * ── Why the persona preview is threaded through too ──
 *
 * The server narrows a previewing owner's capabilities on every request. If this
 * mirror did not, the owner would be shown their real administrative navigation
 * while every one of those pages 403'd — the drift this module exists to prevent,
 * in its most confusing form, on the one feature whose entire purpose is to show
 * somebody an accurate picture of another role's experience.
 *
 * `role` in the payload stays the REAL role deliberately, so "signed in as" and
 * every other consumer keeps telling the truth; the preview arrives beside it and
 * is applied here.
 *
 * This still cannot grant anything. `decide` intersects the effective role with
 * `actualRole` exactly as the server does — it is the same function — so a
 * `preview` field forged in a response, or set by hand in a debugger, can only
 * ever take controls away from the person doing it. The server would refuse the
 * request regardless.
 */
export function can(user, capability) {
  if (!user) return false;
  const persona = user.preview?.persona;
  return decide(
    principalFor(
      { id: user.id, role: user.role },
      {
        grants: user.grants || [],
        withheld: user.withheld || [],
        effectiveRole: persona || user.role,
      }
    ),
    capability
  );
}
