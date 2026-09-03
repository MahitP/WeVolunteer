/**
 * An organization's public handle: the part of `/organizations/@robotics` that
 * identifies the club.
 *
 * ── Why the handle is the slug column, and not a new one ──
 *
 * `organizations.slug` has always been a URL-safe unique identifier with a
 * case-insensitive unique index, resolved by `loadOrganization`, and already
 * carried in every response. A second column would mean two identifiers, two
 * uniqueness rules and two ways for a link to be wrong. So the handle IS the
 * slug; what changes is that it stopped being derived on every rename and became
 * a thing a manager owns.
 *
 * ── Why renaming no longer moves the address ──
 *
 * It used to: a rename recomputed the slug, and `OrganizationForm` promised as
 * much. That was defensible while the slug was a private convenience and wrong
 * the moment it became something a club prints on a flyer. It was also already
 * breaking three things:
 *
 *   - Stored notification payloads bake `/organizations/<slug>` into rows that
 *     outlive the rename, so every historical notification for a renamed club
 *     dead-linked.
 *   - `pendingInvite` keys a remembered invitation on the slug, so a rename
 *     between "open the link" and "finish signing up" silently dropped the
 *     token.
 *   - `?organization=<slug>` filters on the portfolio and certificate pages are
 *     the kind of URL people bookmark.
 *
 * Freezing it fixes all three. The cost is that name and handle can now diverge,
 * which is why the handle became editable in the same change — an address you
 * cannot change and did not choose is worse than one that moves.
 *
 * ── Why the reserved list is derived and not typed out ──
 *
 * `/organizations/new` is a real page. Before this file existed, a club named
 * "New" was created with the handle `new` and a permanently unreachable page:
 * the router matched the literal first. Same for "Invite". A hand-written
 * `['new', 'invite']` would fix today and rot the day somebody adds
 * `/organizations/settings`, so the list is read out of the route allowlist the
 * build already keeps in step with the router.
 */
import { CLIENT_ROUTE_PATTERNS } from './clientRoutes.js';

/**
 * Every literal that occupies the same slot as a handle.
 *
 * `/organizations/new` contributes `new`; `/organizations/:key/edit` contributes
 * nothing, because `edit` is a second segment and a handle can never be read in
 * its place. `invite` comes from `/organizations/invite/:token`, which is three
 * segments deep and cannot collide at all under the canonical `@` form — it is
 * reserved anyway, because the legacy bare path `/organizations/:key` is still
 * served for existing links and there `invite` genuinely does shadow.
 */
export const RESERVED_HANDLES = Object.freeze(
  [...new Set(
    CLIENT_ROUTE_PATTERNS
      .map(pattern => pattern.split('/').filter(Boolean))
      .filter(parts => parts[0] === 'organizations' && parts.length > 1)
      .map(parts => parts[1])
      .filter(segment => !segment.startsWith(':')),
  )].sort(),
);

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 40;

/**
 * The stored shape.
 *
 * Lowercase letters, digits and single hyphens, starting with a letter. No
 * leading `@`: the `@` is punctuation the URL and the interface add, exactly as
 * `users.username` is stored bare and rendered `@name`. Storing it would mean
 * two spellings of the same handle and a uniqueness index that cannot see they
 * are the same.
 *
 * Starting with a letter keeps a handle from being mistaken for an internal id
 * — every id in this schema is `<prefix>-<random>` and several are all-digits
 * after the prefix — and it is the same rule `validateUsername` applies for the
 * same reason.
 */
const HANDLE_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function normaliseHandle(value) {
  return String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Validates a handle a person typed. Returns the `{ ok, error, field }` shape
 * `validateOrganization` and `validateUsername` both use, so a route reports it
 * without translating.
 *
 * Uniqueness is NOT checked here: this is a pure function, and the only honest
 * answer to "is it taken" comes from the database under the unique index. The
 * route asks separately.
 */
export function validateHandle(value) {
  /* Typed before it is coerced. `String(true)` is `'true'`, which passes every
     other rule below — so a JSON body carrying `handle: true` would have set a
     club's address to the word "true". Everything else non-string happens to
     fail the shape check by accident; a boolean is the one that does not, and
     relying on accidents is how the next one gets through. */
  if (value !== undefined && value !== null && typeof value !== 'string') {
    return { ok: false, field: 'handle', error: 'A web address has to be text.' };
  }
  const clean = normaliseHandle(value);
  if (!clean) return { ok: false, field: 'handle', error: 'Choose a web address for this organization.' };
  if (clean.length < HANDLE_MIN) {
    return { ok: false, field: 'handle', error: `A web address needs at least ${HANDLE_MIN} characters.` };
  }
  if (clean.length > HANDLE_MAX) {
    return { ok: false, field: 'handle', error: `A web address can be at most ${HANDLE_MAX} characters.` };
  }
  if (!HANDLE_SHAPE.test(clean)) {
    return {
      ok: false,
      field: 'handle',
      error: 'Use lowercase letters, numbers and hyphens, starting with a letter.',
    };
  }
  if (RESERVED_HANDLES.includes(clean)) {
    return { ok: false, field: 'handle', error: 'That web address is reserved. Try another.' };
  }
  return { ok: true, value: clean };
}

/** The canonical public path for a handle. */
export const handlePath = (handle) => `/organizations/@${normaliseHandle(handle)}`;

/**
 * True when a URL segment is written in the canonical `@handle` form.
 *
 * The canonical route accepts ONLY this form. That is what makes the reserved
 * list belt-and-braces rather than the only defence: `@new` cannot be confused
 * with `new`, so a club that slipped through with a reserved handle before this
 * change is still reachable at its canonical address.
 */
export const isHandleForm = (segment) => String(segment ?? '').startsWith('@');
