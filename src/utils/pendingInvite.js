/**
 * The invitation somebody was holding when they were sent to sign in.
 *
 * ── The flow this exists for ──
 *
 * A visitor with no account opens a club's invitation link, presses Join, and is
 * told they need an account. If they then sign up and land on the dashboard, the
 * link has failed at the last step: they are in the product and nowhere near the
 * club they came for.
 *
 * ── Why this is not a `returnTo` ──
 *
 * A `returnTo` parameter is a general redirect primitive: it accepts a path and
 * navigates there, and keeping it safe means maintaining a validator for ever
 * and getting it right every time. This is not one.
 *
 * What is stored is a SLUG, produced by our own server in answer to our own
 * request, and the consumer interpolates it into a fixed path prefix —
 * `/organizations/<slug>`. There is no input that can make it navigate anywhere
 * else, so there is nothing to validate and no open-redirect surface to get
 * wrong. The token rides along so the Join press works on arrival; the server
 * re-resolves it there and refuses it if it has since been replaced.
 *
 * ── Why `sessionStorage` and not `localStorage` ──
 *
 * It is per-tab and it goes away when the tab does. An invitation somebody
 * abandoned three weeks ago should not still be waiting to redirect them, and a
 * shared school computer should not carry one between two students' sessions.
 *
 * Every access is wrapped: `sessionStorage` is not merely empty in a private
 * window or with site data blocked — reading the accessor itself throws. A
 * failure here must degrade to "no pending invitation", never to a broken
 * signup.
 */
const KEY = 'wev_pending_invite';

/** A stored value we are willing to act on. */
function usable(value) {
  return Boolean(
    value
    && typeof value.slug === 'string'
    && value.slug.length > 0
    && value.slug.length < 128
    /* The token is optional: somebody may have arrived at a club's PUBLIC
       address rather than through an invitation link, in which case they need
       no token to press Join and the record exists only to bring them back to
       the right club after signing up. `null` as well as `undefined`, because
       the public page passes an explicit `token={null}` and a record stored
       with one would otherwise read back as unusable — losing the redirect
       for exactly the reader who came in by the friendlier route. */
    && (value.token === undefined || value.token === null
      || /^[0-9a-f]{64}$/.test(value.token)),
  );
}

/** Remember where somebody was heading, before sending them to sign in. */
export function rememberPendingInvite({ slug, token, name } = {}) {
  const value = { slug, token, name };
  if (!usable(value)) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
    return true;
  } catch {
    /* Private mode, blocked site data, a full quota. The invitation is lost and
       the signup still works, which is the right way round. */
    return false;
  }
}

/** Read it, without changing anything. */
export function peekPendingInvite() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return usable(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The invitation to send somebody to, once.
 *
 * ── Why "once" is a flag and not a delete ──
 *
 * Two consumers need this entry and they need it at different moments. Signing
 * in has to know WHERE to go, and it must do that exactly once — a second
 * sign-in in the same tab should land on the dashboard like any other, not be
 * dragged back to a club somebody joined an hour ago. The organization page then
 * needs the TOKEN, after the navigation, so its Join press carries it.
 *
 * Deleting the entry on redirect would serve the first and starve the second.
 * Two keys would be two things to keep in step. So the redirect is marked spent
 * and the token survives it, and a failed write leaves the entry unspent — which
 * at worst redirects twice, and never loses the token.
 */
export function consumePendingRedirect() {
  const value = peekPendingInvite();
  if (!value || value.redirected) return null;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...value, redirected: true }));
  } catch { /* the redirect still happens; at worst it happens again */ }
  return value;
}

/**
 * The invitation token this tab is holding for one club, if any.
 *
 * Read by the organization page so a reader who arrived through a link renders
 * Join rather than "Invitation required". The server is still the authority: the
 * token travels with the press and is refused there if it has since been
 * replaced, at which point the page reloads into the honest state. Optimism here
 * is free because it cannot grant anything.
 */
export function inviteTokenFor(slug) {
  const value = peekPendingInvite();
  return value && value.slug === slug ? (value.token ?? null) : null;
}

/**
 * Done with it.
 *
 * Called once the invitation has served its purpose — the person joined, or they
 * are already a member — so a tab does not carry a spent token around for the
 * rest of a session.
 */
export function clearPendingInvite() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
