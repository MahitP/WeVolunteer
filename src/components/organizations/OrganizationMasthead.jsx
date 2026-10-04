import { Building2 } from 'lucide-react';
import { avatarColorValue } from '../../utils/avatarColors';
/**
 * Imported HERE, by the component, and not only by the pages that use it.
 *
 * The invitation page rendered this masthead as unstyled text — no plate, no
 * emblem, no rule — because the stylesheet was imported by `OrganizationPage`
 * and `OrganizationForm` and nothing else, and the invitation page reaches the
 * masthead without going through either. A component whose layout is its whole
 * point should carry its own stylesheet rather than trusting each caller to
 * remember; Vite deduplicates the repeated import.
 */
import './OrganizationExperience.css';

/**
 * The plate at the top of an organization.
 *
 * ── The one idea ──
 *
 * A club is not a record in a list; it is a thing with a name, a mark, and a
 * date it started. So the top of the page is built like an engraved plate rather
 * than a card of fields: the club's emblem on a plate of its OWN colour, a
 * charter line of vital statistics set in the utility face, the name at display
 * size, and then exactly one primary action with one sentence under it saying
 * what pressing it will do.
 *
 * ── Why the club's colour reaches the page and not just the avatar ──
 *
 * `organizations.avatar_color` already exists, is already validated against a
 * fixed eight-value palette on the server, and is already published by
 * `formatOrganization` — and until now it tinted a 22-pixel circle and nothing
 * else. It is the only piece of self-expression a club has, so it is what makes
 * one club's page feel like that club's rather than like a template with a
 * different name in it. Used in exactly two places here: the emblem plate, and a
 * three-pixel spine down the leading edge. Restraint is the point — a whole band
 * in a pastel would be a bright slab in dark mode, where these tokens are
 * deliberately not re-tuned.
 *
 * ── Why the charter line is in the mono face ──
 *
 * `--font-mono` appears in this application on figures and on a certificate
 * code: the register of something recorded rather than something written. A
 * club's founding year and its two counts are exactly that, and setting them
 * that way — uppercase, letter-spaced, above the name — is what stops this
 * masthead reading as the event page's four info pills with different labels.
 *
 * ── Shared with the invitation page on purpose ──
 *
 * `OrganizationInvite` renders this same component from the public projection,
 * so somebody arriving with a link and no account sees the club presented the
 * way a member does. Everything the projection omits is optional here; nothing
 * is faked in its absence.
 */
export default function OrganizationMasthead({
  organization,
  /** The primary action, share control and menu. Composed by the caller. */
  action,
  /** One sentence under the action. See `joinPolicySentence`. */
  note,
  /** Rendered under the note — a standing state such as a ban notice. */
  children,
  /** Small text before the counts, e.g. the year the club started. */
  charterLead,
  /** `h1` on the public page, which owns its heading; `h2` inside the shell. */
  as: Heading = 'h2',
}) {
  const accent = avatarColorValue(organization?.avatarColor);
  const members = organization?.memberCount ?? 0;
  const events = organization?.eventCount ?? 0;

  return (
    <section
      className="org-plate"
      /* The club's colour, or nothing at all. Omitted rather than defaulted, so
         a club that never chose one falls back to `--brand-tint` through the
         property's own fallback instead of to a hardcoded value. */
      style={accent ? { '--org-accent': accent } : undefined}
      aria-labelledby="org-plate-name"
    >
      <div className="org-plate-spine" aria-hidden="true" />

      <div className="org-plate-body">
        <div className="org-plate-emblem">
          {/* Upload, then emoji, then the building glyph — the order `users`
              resolves an avatar in, so the two never disagree about which
              picture wins. `alt=""`: the name is beside it, and announcing the
              logo would read the name twice. */}
          {organization?.imageUrl
            ? <img src={organization.imageUrl} alt="" className="org-plate-emblem-img" />
            : <span className="org-plate-emblem-mark" aria-hidden="true">
              {organization?.avatar || <Building2 size={34} />}
            </span>}
        </div>

        <div className="org-plate-identity">
          {/**
            * The charter line.
            *
            * A `<p>` of separated facts rather than a list, because it is read as
            * one line. The separators are decorative and are hidden from the
            * reader, so a screen reader hears "42 members. 11 opportunities."
            * and not "42 members middle dot 11 opportunities".
            */}
          <p className="org-charter">
            {charterLead && (
              <>
                <span>{charterLead}</span>
                <span className="org-charter-sep" aria-hidden="true">·</span>
              </>
            )}
            <span>{members} {members === 1 ? 'member' : 'members'}</span>
            {events > 0 && (
              <>
                <span className="org-charter-sep" aria-hidden="true">·</span>
                <span>{events} {events === 1 ? 'event' : 'events'}</span>
              </>
            )}
          </p>

          <Heading id="org-plate-name" className="org-plate-name">{organization?.name}</Heading>

          {organization?.description && (
            <p className="org-plate-summary">{organization.description}</p>
          )}

          {organization?.tags?.length > 0 && (
            <ul className="chips org-plate-tags">
              {organization.tags.map(tag => <li key={tag} className="chip">{tag}</li>)}
            </ul>
          )}
        </div>
      </div>

      {(action || note) && (
        <div className="org-plate-action">
          {action}
          {/**
            * The sentence, and why it is here rather than in a tooltip.
            *
            * This page's whole job is to answer "can I join this, and how". A
            * badge reading "Invitation only" states a setting; a sentence saying
            * "Ask somebody in it for the link" states what to do about it. It
            * sits directly under the control it describes, which is where
            * somebody looks after reading the button.
            */}
          {note && <p className="org-plate-note">{note}</p>}
        </div>
      )}

      {children}
    </section>
  );
}
