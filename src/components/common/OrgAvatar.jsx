import React from 'react';
import { Building2 } from 'lucide-react';
import { avatarColorValue } from '../../utils/avatarColors';

/**
 * An organization's face, resolved the same way everywhere.
 *
 * ── Why this exists ──
 *
 * The three-way fallback — uploaded logo, then chosen emoji on its colour, then
 * a building glyph — was written out once on the organization's own page and
 * nowhere else. Search results and the Discover list each hardcoded
 * `<Building2 />`, so a club that uploaded a logo saw it on its own page and on
 * no other surface in the product. The data was on the wire the whole time:
 * every organization endpoint selects `o.*` and runs `formatOrganization`,
 * which publishes `avatar`, `imageUrl` and `avatarColor`.
 *
 * One component rather than a copied expression, because "resolve an
 * organization's identity" is a rule, and a rule written in four places is four
 * places for it to drift — which is exactly what happened.
 *
 * `alt=""` on the image: every caller renders the organization's name beside
 * it, so announcing the logo would read the name twice.
 */
export default function OrgAvatar({ organization, size = 18, className = '' }) {
  const color = avatarColorValue(organization?.avatarColor);

  return (
    <span
      className={`avatar ${className}`.trim()}
      style={color ? { '--avatar-bg': color } : undefined}
      aria-hidden="true"
    >
      {organization?.imageUrl
        ? <img src={organization.imageUrl} alt="" className="avatar-img" />
        : (organization?.avatar || <Building2 size={size} />)}
    </span>
  );
}
