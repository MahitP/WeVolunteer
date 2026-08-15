/**
 * Suggesting tags for an event an organizer is writing.
 *
 * ── Suggestions, not a taxonomy ──
 *
 * WeVolunteer deliberately has no canonical tag vocabulary. That is a recorded
 * product decision (`docs/questions-for-owner.md`, Q-2): organizers create their
 * own tags, and there is no rename, merge or approve surface anywhere. This does
 * not change that. It proposes words an organizer accepts, edits or ignores, and
 * nothing here writes a tag to anything.
 *
 * ── Why existing tags are preferred ──
 *
 * The one failure a suggester can cause is fragmentation: "Environment",
 * "Environmental" and "environmental-work" splitting one idea across three
 * filters and making all three worse at finding anything. So a proposal that
 * matches a tag already in use is replaced by that tag's existing spelling.
 *
 * That is not a taxonomy. Nothing is forbidden and nothing is renamed — a
 * genuinely new tag is passed through untouched. It is just a preference for the
 * word the community already uses over a synonym of it.
 *
 * ── Everything goes through the same normaliser as everything else ──
 *
 * `normaliseTag` is the server's, re-exported. A suggestion that would be
 * refused on save is dropped here rather than offered, so an organizer cannot
 * accept a chip and then be told on submit that it was never valid.
 */

import { normaliseTag, MAX_TAGS_PER_EVENT } from '../eventTags.js';
import { AIStatus } from './runtime/types.js';

/**
 * The shape the model is held to.
 *
 * An array of short strings and nothing else. Given room, a small model will
 * return explanations, numbering, or a nested object it invented — the grammar
 * is what makes the reply parse without any of that.
 */
export const TAG_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    tags: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_TAGS_PER_EVENT,
    },
  },
  required: ['tags'],
  additionalProperties: false,
});

const PROMPT = [
  'Suggest short topic tags for this volunteering opportunity.',
  'One or two words each, describing what the work is about.',
  'Do not include the words "volunteer", "volunteering" or "event".',
].join(' ');

/**
 * Tags that say nothing.
 *
 * On a volunteering platform every opportunity is volunteering, so a tag saying
 * so distinguishes nothing and costs a slot out of eight.
 *
 * ── This list is load-bearing, not tidying ──
 *
 * The prompt above asks the model not to use these words. Measured against the
 * 135M model on 2026-08-15, for a park restoration event, it returned:
 *
 *   ["volunteer", "volunteer", "event", "native plant restoration",
 *    "community park", "clean litter", "volunteer", "volunteer`, "]
 *
 * Five of the eight are the two words it was told to avoid, one is malformed,
 * and three are genuinely good. A model this small does not follow negative
 * instructions — it follows the most predictable words in the text, and those
 * are the ones being excluded. The grammar guarantees the reply parses; this
 * list and the deduplication are what make the result usable.
 */
const USELESS = new Set([
  'volunteer', 'volunteering', 'volunteers', 'volunteer work', 'volunteer opportunity',
  'event', 'events', 'opportunity', 'opportunities', 'help', 'helping', 'service',
  'community service', 'wevolunteer', 'other', 'general', 'misc', 'miscellaneous',
]);

/**
 * Clean up whatever the model returned.
 *
 * Exported and tested on its own, because this is where a bad suggestion is
 * stopped and it should not need a model to exercise.
 *
 * @param {string[]} raw        proposals, in the model's order
 * @param {object[]} vocabulary existing tags, most-used first: `{tag, label}`
 * @param {string[]} existing   tags already on the event, which are not re-offered
 */
export function refineTagSuggestions(raw, { vocabulary = [], existing = [] } = {}) {
  const known = new Map(vocabulary.map(v => [v.tag, v.label]));
  const already = new Set(
    existing.map(t => normaliseTag(typeof t === 'string' ? t : t?.label || '')?.tag).filter(Boolean),
  );

  /**
   * How many more tags this event can take, computed before the loop.
   *
   * Checked BEFORE appending, not after. Testing it afterwards meant a full
   * event was still offered one suggestion — accepting it would have produced a
   * nine-tag set and a 400 from a validator naming a limit the organizer had no
   * way to see they had passed.
   */
  const room = Math.max(0, MAX_TAGS_PER_EVENT - already.size);
  if (room === 0) return [];

  const out = [];
  const seen = new Set();

  for (const proposal of Array.isArray(raw) ? raw : []) {
    if (out.length >= room) break;

    /* The server's normaliser, so anything it would refuse is dropped here
       rather than offered and then rejected on save. */
    const normalised = normaliseTag(String(proposal || ''));
    if (!normalised) continue;

    if (USELESS.has(normalised.tag)) continue;
    if (already.has(normalised.tag)) continue;
    if (seen.has(normalised.tag)) continue;

    seen.add(normalised.tag);
    out.push({
      tag: normalised.tag,
      /* An existing tag keeps the spelling already in use; a new one keeps the
         model's. This is the whole of the anti-fragmentation behaviour. */
      label: known.get(normalised.tag) ?? normalised.label,
      existing: known.has(normalised.tag),
    });
  }

  return out;
}

/**
 * Ask the model for tags.
 *
 * Returns `[]` rather than throwing for every failure — no model, a model that
 * is not ready, a refusal, an unparseable reply. This is an optional
 * convenience on a form that works perfectly without it, and an organizer
 * writing an event should never see an error about a suggestion they did not
 * ask for.
 */
export async function suggestTags({ title, description, runtime, vocabulary = [], existing = [], signal } = {}) {
  if (!runtime || runtime.status !== AIStatus.READY) return [];

  const source = [title, description].filter(Boolean).join('. ').trim();
  if (source.length < 20) return [];

  try {
    const reply = await runtime.generate(
      [{ role: 'user', content: `${PROMPT}\n\nOPPORTUNITY:\n---\n${source}\n---` }],
      { schema: TAG_SCHEMA, signal, maxTokens: 120 },
    );

    const parsed = JSON.parse(String(reply || '').trim());
    return refineTagSuggestions(parsed?.tags, { vocabulary, existing });
  } catch {
    return [];
  }
}
