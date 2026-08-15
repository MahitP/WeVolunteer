import { can } from '../../authz.js';

/**
 * Renders children only when `user` holds `cap`.
 *
 * Replaces the role ternaries that were inline in App.jsx, where adding a role
 * meant editing ~15 conditions and missing one meant a blank screen.
 */
export function Can({ user, cap, capAny, fallback = null, children }) {
  /* `capAny` mirrors the server's `requireCapAny`: any ONE of them is enough.
     Both may be given; both must then pass, which is the only reading that
     cannot silently widen a route by adding a field to it. */
  if (cap && !can(user, cap)) return fallback;
  if (capAny?.length && !capAny.some(c => can(user, c))) return fallback;
  if (!cap && !capAny?.length) return fallback;
  return children;
}

/** Hook form, for logic that is not JSX. */
export function useCan(user) {
  return (cap) => can(user, cap);
}
