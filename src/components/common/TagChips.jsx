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
export default function TagChips({
  tags = [],
  limit = 3,
  onSelect = null,
  className = '',
}) {
  const [expanded, setExpanded] = useState(false);

  if (!tags.length) return null;

  const shown = expanded ? tags : tags.slice(0, limit);
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
        </li>
      )}

      {expanded && tags.length > limit && (
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
