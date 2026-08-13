import React, { useState } from 'react';

/**
 * An event's tags, as compact chips.
 *
 * ── Why there is an overflow limit ──
 *
 * An event may carry up to eight tags (MAX_TAGS_PER_EVENT), and eight chips wrap
 * to three lines on a phone — enough to push the title, the date and the "spots
 * remaining" count out of a card that a student is scanning a list of. So a card
 * shows a few and counts the rest.
 *
 * The overflow control EXPANDS rather than linking away. A `+3` that navigates
 * somewhere is a trap in a list; a `+3` that does nothing is a lie. It is a real
 * button, so it is reachable by keyboard and announces its own state.
 *
 * ── Why the label and not the normalised key ──
 *
 * `label` is what the organizer typed (`AnimalShelter`); `tag` is the lower-cased
 * key used for filtering (`animalshelter`). Rendering the key would show every
 * reader a flattened spelling nobody chose. See server/eventTags.js.
 *
 * ── Why `#` is decoration ──
 *
 * The hash is prepended here and is `aria-hidden`, so a screen reader reads
 * "AnimalShelter" rather than "hash AnimalShelter" eight times. It is not stored:
 * the normaliser strips it precisely so `#NHS` and `NHS` are one concept.
 */
/**
 * ── `expandable`, and why a card does not get it ──
 *
 * Expanding in place is right where the chips ARE the surface — the tag row on
 * a details page has room to grow. On a card in a scannable list it is the
 * behaviour the preview limit exists to prevent: twelve tags become three lines
 * and push the title, the date and the seat count out of view, which is exactly
 * what a reader scanning twenty cards does not want.
 *
 * So a card renders the overflow as a COUNT rather than a control. That is not
 * the "+3 that does nothing" this file's header warns about: the card is itself
 * a link to the event, the full list is on the other side of it, and the count
 * is marked up as text rather than dressed as a button somebody could press in
 * vain.
 *
 * Default `true`, so every existing caller behaves exactly as before.
 */
export default function TagChips({
  tags = [],
  limit = 4,
  onSelect = null,
  className = '',
  expandable = true,
}) {
  const [expanded, setExpanded] = useState(false);

  if (!tags.length) return null;

  /* `limit` is a maximum, never a minimum: a negative or non-numeric value
     would otherwise make `slice` count from the end and show the LAST tags. */
  const cap = Number.isFinite(limit) && limit >= 0 ? limit : tags.length;
  const shown = expanded && expandable ? tags : tags.slice(0, cap);
  const hidden = tags.length - shown.length;

  /**
   * A list, because it is one.
   *
   * `aria-label` names it rather than a visible heading: on a card the chips sit
   * under a title and a heading for three words of metadata is more furniture
   * than the metadata. A screen reader still gets "Tags, list, 3 items".
   */
  return (
    <ul className={`tag-chips ${className}`.trim()} aria-label="Tags">
      {shown.map(({ tag, label }) => (
        <li key={tag}>
          {onSelect ? (
            /* Interactive only where filtering exists. On a card with no filter
               to drive, a clickable chip promises something that does not
               happen — so the default is inert text. */
            <button
              type="button"
              className="tag-chip tag-chip-action"
              onClick={() => onSelect(tag)}
              aria-label={`Filter by ${label}`}
            >
              <span aria-hidden="true">#</span>{label}
            </button>
          ) : (
            <span className="tag-chip">
              <span aria-hidden="true">#</span>{label}
            </span>
          )}
        </li>
      ))}

      {hidden > 0 && (
        <li>
          {expandable ? (
            <button
              type="button"
              className="tag-chip tag-chip-more"
              onClick={() => setExpanded(true)}
              aria-expanded={false}
              /* Names the count, because "+3" alone is not a sentence. */
              aria-label={`Show ${hidden} more ${hidden === 1 ? 'tag' : 'tags'}`}
            >
              +{hidden}
            </button>
          ) : (
            /* A count, not a control — see the note on `expandable`. The label
               says where the rest are, so the number is not a dead end. */
            <span
              className="tag-chip tag-chip-more"
              aria-label={`and ${hidden} more ${hidden === 1 ? 'tag' : 'tags'}, shown when you open this event`}
            >
              +{hidden}
            </span>
          )}
        </li>
      )}

      {expandable && expanded && tags.length > cap && (
        <li>
          <button
            type="button"
            className="tag-chip tag-chip-more"
            onClick={() => setExpanded(false)}
            aria-expanded
            aria-label="Show fewer tags"
          >
            Show less
          </button>
        </li>
      )}
    </ul>
  );
}
