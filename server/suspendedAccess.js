/**
 * The only things a suspended session may reach.
 *
 * ── Why a suspended session exists ──
 *
 * It did not, until now. A suspended account was refused at sign-in and refused
 * again by `authenticateToken`, so the entire product answer to "why can I not
 * get in" was one sentence on a login form pointing at an email address.
 * Everything else the person was told existed only in the notice sent at the
 * moment they were suspended — lose it, or never receive it, and there was
 * nowhere to look. On a platform whose users are mostly minors, that is the part
 * that fails them.
 *
 * So the session is granted, and then this module makes it almost worthless: it
 * carries enough to read the decision, appeal it, and leave.
 *
 * ── Deny by default, exact match ──
 *
 * This is an allowlist, and it is compared by exact method and exact path. No
 * prefixes. A prefix entry for `/api/appeals` would have quietly included
 * `/api/appeals/token/:token` and every admin appeal route mounted beneath it,
 * which is how an allowlist becomes an opening rather than a limit.
 *
 * The consequence is that a new route is unreachable to a suspended session
 * until somebody adds it here deliberately — which is the direction this should
 * fail in. `suspendedAccess.test.js` pins the whole set, so growing it is a
 * visible act in a diff rather than a line nobody reads.
 *
 * ── What is NOT here, and why ──
 *
 *   - Anything that reads or writes platform data. A suspension that still let
 *     someone browse events or read messages is not a suspension.
 *   - The realtime socket. `socketServer.js` refuses any account whose status is
 *     not `active`, which is stricter than `isSuspended` and deliberately left
 *     that way: a suspended person gets no live feed at all.
 *   - `/api/auth/sign-out-others`. Signing other devices out is account
 *     management, and there is nothing on those devices to protect that this
 *     account can still reach.
 *   - Anything under `/api/admin`. A suspended administrator is a suspended
 *     account first; the capability gates behind this would allow them through.
 */

/**
 * `method` is upper-case; `path` is the full mounted path, matched exactly.
 *
 * Written as literal strings rather than derived from the routers, because the
 * point is that this list is short enough to read and audit in one sitting.
 */
export const SUSPENDED_ALLOWED = Object.freeze([
  /**
   * Who am I, and what happened to me. This is the request that carries the
   * suspension notice to the screen the person is looking at, so without it the
   * whole feature is a blank page.
   */
  { method: 'GET', path: '/api/auth/me' },

  /**
   * The way out. A locked-out person who cannot sign out is stuck with a session
   * they cannot use and cannot clear — on a shared school computer that is also
   * the next student's problem.
   */
  { method: 'POST', path: '/api/auth/logout' },

  /**
   * Due process. The Community Guidelines promise an appeal, and an appeal the
   * suspended person cannot actually submit is a promise made to nobody.
   *
   * `GET /api/appeals/mine` is here as well as the POST: seeing that an appeal
   * was received, and where it got to, is most of what the person wants after
   * sending one. Without it the screen can only say "we hope that worked".
   */
  { method: 'POST', path: '/api/appeals' },
  { method: 'GET', path: '/api/appeals/mine' },
]);

/**
 * Whether a suspended session may perform this request.
 *
 * Takes the method and path rather than the request object so it can be unit
 * tested without constructing an Express request, and so the caller is explicit
 * about which path it is asking on — `req.path` is relative to the mount point
 * and `req.originalUrl` carries the query string, and passing the wrong one is
 * exactly the mistake that would turn an exact match into a near miss.
 */
export function suspendedMayReach(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') return false;
  const wanted = method.toUpperCase();
  return SUSPENDED_ALLOWED.some((r) => r.method === wanted && r.path === path);
}
