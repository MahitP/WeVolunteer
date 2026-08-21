/**
 * Organizer-created event tags.
 *
 * ── Why tags exist, and why they are not a wider enum ──
 *
 * `events.category` is five values behind a CHECK constraint — `School`, `5K`,
 * `Food Pantry`, `Fundraiser`, `Other`. The owner's recorded answer to Q-2 in
 * `docs/questions-for-owner.md` is "organizer-created tags, no fixed taxonomy",
 * and the reasoning there is that one category per event cannot express what most
 * school events actually are: a food drive run by the honour society is Food AND
 * School AND NHS, and an enum forces the organizer to pick one and lose the rest.
 *
 * `category` is deliberately KEPT and untouched. The Impact Dashboard aggregates
 * on it, `weighting.js` reads it for the Auto Select draw, and every existing
 * filter and test depends on it. Tags are additive metadata for discovery, not a
 * replacement, and nothing in this module writes to `events`.
 *
 * ── Tags are for DISCOVERY, not for recording hours ──
 *
 * Worth stating because the two get conflated. A tag says what an opportunity is
 * ABOUT, so somebody can find it. It is organizer-typed free text and carries no
 * verification, so it must never be the thing that decides what a student's hours
 * COUNT TOWARD — that is a separate concern with a different trust model, and
 * turning every tag into an hours category would let an organizer type `#NHS` and
 * thereby appear to certify hours against an external organization's
 * requirements, which this platform cannot substantiate.
 *
 * ── Normalisation: one concept, one row ──
 *
 * The user requirement is explicit — `#NHS`, `#nhs` and `# NHS` must not become
 * three separate concepts. So every tag is stored twice:
 *
 *   `tag`   the normalised form. Lower-cased, `#` stripped, whitespace collapsed.
 *           This is what is indexed, filtered and grouped on.
 *   `label` what the organizer actually typed, minus the `#` and tidied. This is
 *           what a reader sees, so `AnimalShelter` does not come back as
 *           `animalshelter`.
 *
 * The pair is what lets the same concept be found regardless of how it was typed
 * while still rendering the way its author wrote it. First writer wins on the
 * label for a given event; across events the same normalised tag may legitimately
 * display differently, which is a cosmetic inconsistency and strictly better than
 * either flattening everybody's capitalisation or splitting the concept.
 */

/** The most tags one event may carry. */
export const MAX_TAGS_PER_EVENT = 8;

/** The longest a single tag may be, measured on the normalised form. */
export const MAX_TAG_LENGTH = 30;

/**
 * What a tag may contain: letters, digits, single spaces and hyphens.
 *
 * Unicode letter classes rather than `a-z`, so a district that tags in Spanish or
 * Korean is not told its language is invalid. Deliberately EXCLUDES everything
 * else — punctuation, emoji, control characters, `<`, `&`, quotes — which is not
 * an XSS defence (React escapes text nodes, and nothing renders a tag as HTML)
 * but keeps the vocabulary readable and keeps a tag from being used as a place to
 * smuggle a payload toward some future consumer that is less careful, such as a
 * CSV export opened in a spreadsheet.
 */
const ALLOWED = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;

/**
 * The normalised key for a tag, or null if it is not a usable tag.
 *
 * ── The order of these four steps is the whole function ──
 *
 * It has to absorb every way a person writes a tag, and the three spellings named
 * in the requirement each need a different step to survive:
 *
 *   `'#NHS'`      the hash has to go
 *   `'# NHS'`     the hash goes, and then the space it left behind
 *   `'  #NHS  '`  the outer whitespace goes FIRST, or the hash is no longer
 *                 leading and the strip does not match it
 *
 * So: collapse whitespace, trim, strip leading hashes, trim again. An earlier
 * revision stripped the hash first and rejected `'  #NHS  '` outright — the `#`
 * survived into the charset check, which does not permit it. Trimming twice looks
 * redundant and is not: the second pass exists for the space a removed hash
 * leaves behind.
 */
export function normaliseTag(raw) {
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    .replace(/\s+/g, ' ')     // collapse runs of whitespace, including tabs and newlines
    .trim()
    .replace(/^#+/, '')       // a leading hash is how people write tags; it is not part of one
    .trim();

  if (!cleaned) return null;
  if (!ALLOWED.test(cleaned)) return null;

  const key = cleaned.toLocaleLowerCase();
  if (key.length > MAX_TAG_LENGTH) return null;

  return { tag: key, label: cleaned };
}

/**
 * Validates and de-duplicates a submitted list of tags.
 *
 * Returns the SAME `{ok, value} | {ok, field, error}` shape every other validator
 * in this codebase uses (`validation.js`, `accountValidation.js`,
 * `parseEventFilters`), so a route handler treats it identically.
 *
 * ── Why a rejected tag is an error and not silently dropped ──
 *
 * An organizer who types a 40-character tag and sees it vanish learns nothing and
 * tries again. Naming the offending value is the difference between a form that
 * teaches and one that appears broken. The exception is a duplicate, which is
 * de-duplicated silently: typing `NHS` twice means the same thing as typing it
 * once and there is nothing to correct.
 */
export function validateTags(input) {
  if (input === undefined || input === null) return { ok: true, value: [] };

  if (!Array.isArray(input)) {
    return { ok: false, field: 'tags', error: 'Tags must be a list.' };
  }

  /* Checked BEFORE the loop, on the raw length. A request carrying ten thousand
     tags should be refused on its shape rather than after normalising all of
     them, which is work done on behalf of a caller acting in bad faith. */
  if (input.length > MAX_TAGS_PER_EVENT) {
    return {
      ok: false,
      field: 'tags',
      error: `An event can have at most ${MAX_TAGS_PER_EVENT} tags.`,
    };
  }

  const seen = new Map();
  for (const raw of input) {
    if (typeof raw !== 'string') {
      return { ok: false, field: 'tags', error: 'Each tag must be text.' };
    }
    /* Bounded before normalising so a megabyte-long string is refused rather than
       lower-cased first. `MAX_TAG_LENGTH * 4` leaves room for a hash, stray
       whitespace and multi-byte letters while staying nowhere near a size worth
       processing. */
    if (raw.length > MAX_TAG_LENGTH * 4) {
      return { ok: false, field: 'tags', error: `Tags must be ${MAX_TAG_LENGTH} characters or fewer.` };
    }

    const normalised = normaliseTag(raw);
    if (!normalised) {
      const shown = raw.trim().slice(0, 40) || '(empty)';
      return {
        ok: false,
        field: 'tags',
        error: `"${shown}" is not a usable tag. Use letters, numbers, spaces or hyphens, `
          + `up to ${MAX_TAG_LENGTH} characters.`,
      };
    }

    // First spelling wins the label; a repeat is the same tag, not an error.
    if (!seen.has(normalised.tag)) seen.set(normalised.tag, normalised);
  }

  return { ok: true, value: [...seen.values()] };
}

/**
 * Replaces an event's tags, inside the caller's transaction.
 *
 * Delete-then-insert rather than a diff. The set is at most eight rows, the
 * primary key makes the delete a single index range, and a diff would be more
 * code for no measurable gain — while introducing the possibility of the table
 * and the request disagreeing about what is present. The caller owns the
 * transaction so this cannot half-apply.
 */
export async function replaceEventTags(db, eventId, tags) {
  await db.prepare('DELETE FROM event_tags WHERE event_id = ?').run(eventId);
  if (!tags.length) return;

  const insert = await db.prepare('INSERT INTO event_tags (event_id, tag, label) VALUES (?, ?, ?)');
  for (const { tag, label } of tags) await insert.run(eventId, tag, label);
}

/**
 * The tags for one event, ready to render.
 *
 * Ordered by label so a card's chips do not reshuffle between requests — an
 * unordered read is a list that appears to change every refresh.
 */
export async function tagsForEvent(db, eventId) {
  return (await db
    .prepare('SELECT tag, label FROM event_tags WHERE event_id = ? ORDER BY label COLLATE nocase'))
    .all(eventId);
}

/**
 * The tags for many events at once, as `{ [eventId]: [{tag, label}] }`.
 *
 * One query for a page of events rather than one per event. The list endpoint
 * returns up to a page of results and `tagsForEvent` in a loop would make tags
 * cost a query each — the N+1 that turns a 50-event page into 51 round trips
 * against a synchronous SQLite driver, on the endpoint the browse screen calls on
 * every keystroke.
 *
 * Returns an empty object for an empty id list rather than building `IN ()`,
 * which is a syntax error in SQLite.
 */
export async function tagsForEvents(db, eventIds) {
  if (!eventIds.length) return {};

  const placeholders = eventIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT event_id, tag, label FROM event_tags
        WHERE event_id IN (${placeholders})
        ORDER BY label COLLATE nocase`
    )
    .all(...eventIds);

  const byEvent = {};
  for (const row of rows) {
    (byEvent[row.event_id] ||= []).push({ tag: row.tag, label: row.label });
  }
  return byEvent;
}

/**
 * The tags in use, most-used first, for the filter bar and the input's suggestions.
 *
 * ── Why suggestions rather than a managed vocabulary ──
 *
 * The requirement is that organizers are never restricted to a predefined list.
 * Suggesting what already exists makes reuse the easy path — which is what stops
 * `#foodrive`, `#food-drive` and `#fooddrive` accumulating — without making any
 * of them mandatory. There is deliberately no tag-administration surface: nothing
 * renames, merges or deletes a tag globally, because that is a taxonomy-management
 * product and the answer to Q-2 was that this platform should not have one.
 *
 * `label` is picked with `MAX` so a suggestion renders with a real spelling rather
 * than the normalised key. It is an arbitrary choice among the spellings in use,
 * which is acceptable for a suggestion and is why the authoritative value carried
 * back is `tag`.
 *
 * Counts come from `event_tags` alone and are not filtered by event status: a
 * suggestion list is a vocabulary, not a result count, and joining to `events` to
 * exclude cancelled ones would make the list flicker as events close.
 */
/**
 * How many tags the browse filter bar offers.
 *
 * Fifteen, because the bar is a row of chips above a list of events and fifty
 * of them wrapped into a wall a reader had to scroll past to reach what they
 * came for. The cut is by USAGE — `tagVocabulary` counts rows in `event_tags`
 * and breaks ties on the key — so the ones that survive are the ones organizers
 * actually use, and the same fifteen come back every time rather than a
 * different fifteen per request.
 *
 * It is a DISPLAY cap and not a filtering one: `GET /api/events/tags?limit=`
 * still serves the wider vocabulary, and a tag chosen from a link keeps working
 * whether or not it made the fifteen.
 */
export const BROWSE_TAG_LIMIT = 15;

export async function tagVocabulary(db, { limit = 50 } = {}) {
  return await db
    .prepare(
      `SELECT tag, MAX(label) AS label, COUNT(*) AS uses
         FROM event_tags
        GROUP BY tag
        ORDER BY uses DESC, tag ASC
        LIMIT ?`
    )
    .all(Math.min(Math.max(1, Number(limit) || 50), 200));
}
