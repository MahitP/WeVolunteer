/**
 * The presentation an account that is not an ordinary member carries.
 *
 * ── What "distinguished" means here ──
 *
 * Two kinds of account on this platform are not students with a service record:
 * the account that runs WeVolunteer, and a community partner — an outside
 * organization the programme works with. Both used to be rendered either as an
 * ordinary member profile (which described them wrongly) or as a bare page of
 * facts (which described them thinly). Neither said what the account is, and a
 * reader who arrived at one had no way to tell.
 *
 * So they get their own treatment: a banner, an explicit label, one line the
 * account holder writes themselves, and a short list of the things worth knowing
 * about them. It is deliberately built out of the same tokens, radii and type as
 * the rest of the product — a partner's page should read as part of
 * WeVolunteer, not as a landing page that wandered in.
 *
 * ── Additive, never a replacement ──
 *
 * The distinction sits ABOVE a member profile; it does not stand in for one.
 * The person who runs this platform is a high-school student who volunteers, so
 * their hours, skills, hobbies and history are real and belong on their profile
 * exactly as anybody else's do. A page that swapped them out for a job title
 * would be hiding a genuine service record behind a role name.
 *
 * ── Driven by data, never by a name ──
 *
 * `distinction` arrives from the server as a pure function of `users.role` (see
 * `distinctionFor` in server/profileSerializer.js). Nothing in this file, or in
 * any caller, compares a username: an account that changes hands, a second
 * owner, or a tenth partner all get the right presentation with nothing to
 * remember and nothing to edit.
 */
import { Crown, Handshake, Sparkles } from 'lucide-react';

/**
 * The icon per kind. A lookup rather than a conditional, so a third kind added
 * to the server's table renders something sensible here instead of nothing —
 * `Sparkles` is the fallback, not a case.
 */
const KIND_ICON = { owner: Crown, partner: Handshake };

/**
 * The banner: who this account is, in its own words.
 *
 * `data-kind` rather than a class per kind, so the stylesheet carries one rule
 * with two attribute selectors instead of a class name that has to be
 * constructed — a constructed class name is invisible to
 * `noDanglingClasses.test.js`, which is the guard that keeps this stylesheet
 * honest.
 */
export function DistinctionBanner({ distinction, headline, highlights = [], about }) {
  if (!distinction?.kind) return null;
  const Icon = KIND_ICON[distinction.kind] ?? Sparkles;

  /**
   * `aria-labelledby` promotes this to a named region, deliberately.
   *
   * The sibling cards are unnamed sections, and that is right for them — they
   * are one heading and a list. This one is now several blocks about the same
   * subject, so a screen-reader user benefits from being able to reach it and
   * leave it as a unit. Naming it is what makes it a landmark rather than an
   * anonymous one, which is the failure mode of `role="region"` with no name.
   */
  const headingId = `distinction-${distinction.kind}-label`;

  return (
    <section
      className="card distinction"
      data-kind={distinction.kind}
      aria-labelledby={headingId}
    >
      <div className="distinction-head">
        <span className="distinction-mark" aria-hidden="true"><Icon size={20} /></span>
        <div className="stack-xs distinction-titles">
          {/* The label is the accessible heading for the section, so a screen
              reader announces what kind of account this is rather than reaching
              a decorative icon and an unlabelled region. */}
          <h2 className="distinction-label" id={headingId}>{distinction.label}</h2>
          <p className="distinction-blurb">{distinction.blurb}</p>
        </div>
      </div>

      {/**
        * The account's OWN line, before the platform's explanation of the role.
        *
        * Ordering is the whole argument here. A reader who has arrived at this
        * page wants to know who this is, and the person's own sentence answers
        * that better than a definition does. The definition is the thing they
        * fall back to when the sentence assumes knowledge they do not have, so
        * it sits underneath, quieter, and is skippable.
        */}
      {headline && <p className="distinction-headline">{headline}</p>}

      {/**
        * `about` is the account holder's own paragraph (`bio`). It is exempt
        * from the privacy setting on an institutional account — see the note in
        * server/profileSerializer.js — because an organization's description of
        * itself vanishing behind a toggle written for a fourteen-year-old is
        * not privacy, it is a page that fails to say what it is for.
        *
        * Absent when the server withheld it or the holder never wrote one, and
        * in both cases nothing is drawn: an empty section would imply they left
        * it blank, which is the rule the whole profile follows.
        */}
      {about && <p className="distinction-about">{about}</p>}

      {highlights.length > 0 && (
        <div className="distinction-block">
          {/* `h3`, under the `h2` above. The visual difference between the two
              is small — 1.0625rem against .9375rem — and that is not a reason to
              flatten them: the heading order is what a screen reader navigates
              by, and this genuinely is a sub-block of the section. */}
          <h3 className="distinction-block-head">{distinction.highlightsLabel}</h3>
          <ul className="distinction-highlights">
            {highlights.map((h, i) => (
              <li key={`${i}-${h}`} className="distinction-highlight">
                <Sparkles size={13} aria-hidden="true" /> <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/**
        * What the role actually means, in the platform's words rather than the
        * account holder's.
        *
        * Last, and visually quietest, because it is reference rather than news:
        * a reader who knows what a community partner is should not have to
        * scroll past the definition to reach the person. It is also the only
        * text on this card the account cannot edit, which is why it is the only
        * one that may describe what the role can and cannot DO.
        */}
      {distinction.description && (
        <p className="distinction-role-note">{distinction.description}</p>
      )}
    </section>
  );
}

/**
 * The compact form — one pill, for a search result or a profile header where
 * the full banner would be four lines of chrome around a name.
 */
export function DistinctionTag({ distinction }) {
  if (!distinction?.kind) return null;
  const Icon = KIND_ICON[distinction.kind] ?? Sparkles;
  return (
    <span className="tag distinction-tag" data-kind={distinction.kind}>
      <Icon size={12} aria-hidden="true" /> {distinction.label}
    </span>
  );
}
