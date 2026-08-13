/**
 * The rules for an organization's tags.
 *
 * ── Why this is its own module ──
 *
 * These rules lived in `organizations.js`, which imports `node:crypto`. The
 * browser needs them — the organization form is the only place tags are typed,
 * and a form that enforces different rules from the route is a form that either
 * refuses valid input or accepts input the API will reject. Re-exporting them
 * through `src/organizationTags.js` is what stops that drift, and pulling
 * `node:crypto` into the client bundle to get them is not a trade worth making.
 *
 * So: this file imports nothing, exactly as `eventTags.js` does and for the same
 * reason. Keep it that way.
 *
 * ── Why organizations are not held to the event charset ──
 *
 * Event tags are restricted to `[\p{L}\p{N} -]` because they are a discovery
 * vocabulary: three spellings of one thing is the failure, so the charset is
 * narrow on purpose and organizers are nudged toward reusing what exists.
 *
 * An organization tag names a real body, and real bodies are punctuated:
 * "Food & Water", "St. Judes", "501(c)(3)", "Kids/Teens". Every one of those is
 * accepted by the route and refused by the event normaliser, which is what the
 * form was using — so half of what the API allows could not be typed, and a
 * chapter could not write its own name.
 *
 * The length limit is the constraint that matters here, and it is checked on the
 * cleaned text so a tag cannot be padded past it with whitespace.
 */

/** The most tags one organization may carry. */
export const MAX_ORG_TAGS = 8;

/**
 * The longest a single organization tag may be.
 *
 * Per tag, never across the collection — see `normaliseOrgTags`.
 */
export const MAX_ORG_TAG_LENGTH = 40;

/**
 * The stored form of a typed tag: whitespace collapsed, hash removed.
 *
 * ── The bug this closes ──
 *
 * Organization tags were stored as typed, and `#` search compares what it finds
 * against `normaliseTag(query).tag`, which collapses internal whitespace and
 * strips a leading hash. Anything stored with either — `"#NHS"`, or
 * `"Food  Drive"` with two spaces, both of which the route accepted — could
 * therefore never be matched by any search, by anyone, ever. The tag saved, the
 * chip rendered, and the organization was simply unfindable by it.
 *
 * The cleaning here is deliberately identical to `normaliseTag`'s, minus the
 * charset test. Two normalisers that agree about `#` and whitespace and disagree
 * about nothing else is the property that makes a tag reachable.
 *
 * Trimming twice is not redundant: the second pass takes the space a removed
 * hash leaves behind, so `'  # NHS '` cleans to `'NHS'` rather than `' NHS'`.
 */
export function cleanOrgTag(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+/, '')
    .trim();
}

/**
 * One tag, as the chip editor wants it: a match key and the spelling to show.
 *
 * The key is lowercased so `NHS` and `nhs` are one tag; the label keeps the
 * capitalisation somebody typed, because an organization's own name is not the
 * platform's to re-case.
 *
 * Returns null for anything unusable, which is the shape `TagInput` already
 * expects from `normaliseTag`. Callers that need to explain a refusal to a
 * person use `normaliseOrgTags`, which names the offending value.
 */
export function normaliseOrgTag(raw) {
  const cleaned = cleanOrgTag(raw);
  if (!cleaned) return null;
  if (cleaned.length > MAX_ORG_TAG_LENGTH) return null;
  return { tag: cleaned.toLocaleLowerCase(), label: cleaned };
}

/**
 * Turns whatever the editor sent into a clean list of tag labels.
 *
 * ── The bug this exists to make impossible ──
 *
 * The check used to be one `.some()` doing three jobs:
 *
 *     payload.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 40)
 *
 * with a single message about the 40-character limit. `TagInput` is shared with
 * the event editor and emits `{tag, label}` OBJECTS, so every real submission
 * failed on the FIRST clause and was reported against the THIRD — an organizer
 * was told their perfectly short tags were too long. Submitting no tags worked,
 * because `.some()` over an empty array is false, which is precisely what hid
 * the fault: the feature looked merely broken rather than mistyped.
 *
 * So this accepts both shapes. The client sends strings now, but a validator
 * that only understands one shape is a validator that breaks again the next
 * time a shared control is reused, and the object form carries strictly more
 * information than it needs rather than less.
 *
 * ── What it guarantees ──
 *
 *   · every tag is cleaned by `cleanOrgTag`, so a stored tag is always
 *     reachable by the `#` search that looks for it
 *   · every tag is a non-empty string
 *   · every tag is at most `MAX_ORG_TAG_LENGTH`, measured per tag on the
 *     cleaned text
 *   · duplicates are dropped, matched case-insensitively, first spelling wins
 *   · the count limit is applied AFTER de-duplication, so "Food Drive" twice
 *     does not consume two of somebody's eight slots
 *   · a refusal names the offending tag, because an organizer with eight tags
 *     and one mistake should not have to bisect their own input
 *
 * Duplicates are dropped rather than refused: two spellings of one thing is a
 * typo, and stopping the whole submission for it teaches people to avoid the
 * control.
 */
export function normaliseOrgTags(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, field: 'tags', error: 'Tags must be a list.' };
  }

  const seen = new Set();
  const value = [];

  for (const entry of raw) {
    /* `{tag, label}` from the shared editor, or a plain string. Anything else
       is a shape nobody meant to send. */
    const text = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' && typeof entry.label === 'string' ? entry.label : null);

    if (text === null) {
      return { ok: false, field: 'tags', error: 'Each tag must be text.' };
    }

    const cleaned = cleanOrgTag(text);
    if (!cleaned) {
      return { ok: false, field: 'tags', error: 'A tag cannot be blank.' };
    }
    if (cleaned.length > MAX_ORG_TAG_LENGTH) {
      return {
        ok: false,
        field: 'tags',
        error: `"${cleaned}" is too long — each tag must be ${MAX_ORG_TAG_LENGTH} characters or fewer.`,
      };
    }

    const key = cleaned.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    value.push(cleaned);
  }

  if (value.length > MAX_ORG_TAGS) {
    return { ok: false, field: 'tags', error: `Please use ${MAX_ORG_TAGS} tags or fewer.` };
  }

  return { ok: true, value };
}
