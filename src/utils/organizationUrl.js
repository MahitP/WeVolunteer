/**
 * Where an organization lives.
 *
 * ── One builder, because the `@` is easy to forget ──
 *
 * The canonical address is `/organizations/@robotics`. The `@` is punctuation
 * the URL adds — `organizations.slug` stores `robotics`, and the server strips
 * the prefix on the way in — so every link in the product has to add it, and
 * eight call sites each adding it by hand is eight chances for one of them not
 * to. A link written without it still resolves, which is exactly what makes the
 * omission invisible: it is not a broken page, it is a page at a
 * non-canonical address that a signed-out reader is refused.
 *
 * Nothing here validates the handle. It is a value the server produced, and a
 * client-side check would be a second copy of `validateHandle` that could only
 * ever disagree with it.
 */

/** The canonical path for an organization, from anything carrying a `slug`. */
export function organizationPath(organization) {
  const slug = typeof organization === 'string' ? organization : organization?.slug;
  if (!slug) return '/organizations';
  return `/organizations/@${encodeURIComponent(String(slug).replace(/^@+/, ''))}`;
}

/** A sub-page of an organization — `edit`, and whatever comes next. */
export const organizationSubPath = (organization, segment) =>
  `${organizationPath(organization)}/${segment}`;
