import { can } from '../../authz.js';

/**
 * Renders children only when `user` holds `cap`.
 *
 * Replaces the role ternaries that were inline in App.jsx, where adding a role
 * meant editing ~15 conditions and missing one meant a blank screen.
 */
export function Can({ user, cap, fallback = null, children }) {
  return can(user, cap) ? children : fallback;
}

/** Hook form, for logic that is not JSX. */
export function useCan(user) {
  return (cap) => can(user, cap);
}
