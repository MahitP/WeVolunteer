/**
 * What one event looks like to Pinecone: its id, the text that gets embedded,
 * the metadata that gets filtered on, and the hash that decides whether any of
 * it needs sending again.
 *
 * ── This is the privacy boundary for the search integration ──
 *
 * Pinecone receives event LISTING content and nothing else. Every field below is
 * already visible to every authenticated user of this application: `GET
 * /api/events` applies no per-viewer visibility filter, because eligibility
 * (`events.audience`, organization bans) is enforced when somebody APPLIES, not
 * when they browse — see `server/eventEligibility.js`. So nothing here is
 * disclosed to the vendor that an ordinary student could not already read.
 *
 * What is deliberately withheld:
 *
 *   · **No user data of any kind.** No student, no application, no attendance,
 *     no favourite, no search history. Recommendations are built from event
 *     text, never from a person — see `recommendations.js`.
 *   · **No organizer name.** It is the one field on an event that is reliably a
 *     real person's name, and it buys nothing semantically: the existing SQL
 *     search already matches `u.name` exactly, which is how anybody actually
 *     looks for "Ms. Alvarez's events". Sending it would put a named adult into
 *     a third-party index to duplicate a search that already works.
 *   · **No `instructions`.** Organizers write meeting points, door codes and
 *     phone numbers there. It is shown only to accepted volunteers, so it is the
 *     one long text field on an event that is NOT already public.
 *
 * ── Embedded text versus metadata ──
 *
 * A field is embedded if a human might describe it in words ("outdoors",
 * "animals", "tutoring"). A field is metadata if a filter would use it (a
 * status, a category key, a timestamp). Dates and numbers are deliberately kept
 * OUT of the embedded text: they embed poorly, and — more importantly — they
 * would change the content hash whenever they moved, forcing a re-embed for a
 * change no semantic query can perceive.
 */
import crypto from 'node:crypto';

import { DOCUMENT_VERSION } from './pineconeConfig.js';

/**
 * The text field name the index embeds. Bound into the index at creation time
 * as `field_map.text`, so it cannot be renamed without a new index.
 */
export const TEXT_FIELD = 'text';

/**
 * A deterministic id, so the same event is always the same record.
 *
 * A random id per indexing run would mean every backfill duplicates the entire
 * corpus, every update leaves an orphan behind, and deletion is impossible
 * without a separate lookup table. `event:<uuid>` is stable, is derived from the
 * only identifier the database guarantees, and stays far inside Pinecone's
 * 512-character ceiling for a record id.
 */
export function vectorIdFor(eventId) {
  return `event:${eventId}`;
}

/** The inverse, for reconciliation: which database row does this record claim? */
export function eventIdFromVectorId(vectorId) {
  const raw = String(vectorId ?? '');
  return raw.startsWith('event:') ? raw.slice('event:'.length) : null;
}

/** Description text is trimmed before embedding — see `buildEmbedText`. */
const MAX_DESCRIPTION = 1200;

/**
 * The text that becomes the vector.
 *
 * Ordered most-distinguishing first. Embedding models weight the whole passage,
 * but a title that leads reads better in the reranker's window and in any
 * debugging output, and the description — the longest and least precise part —
 * is truncated so one organizer's essay cannot dominate the passage.
 *
 * Labels ("Category:", "Tags:") are included on purpose. They give the model
 * something to attach the value to, so that the category `Animals` reads as a
 * kind of opportunity rather than as a loose word in a bag.
 *
 * @param {object} event a row from `events`
 * @param {object} [extra]
 * @param {string[]} [extra.tags] normalised tag keys from `event_tags`
 * @param {string} [extra.organizationName] from `organizations`, when the event has one
 */
export function buildEmbedText(event, { tags = [], organizationName = null } = {}) {
  const parts = [];
  const push = (label, value) => {
    const text = String(value ?? '').trim();
    if (text) parts.push(label ? `${label}: ${text}` : text);
  };

  push(null, event?.title);
  push('Category', event?.category);
  /**
   * Sorted, and the sort is load-bearing.
   *
   * The tag list reaches this function from `GROUP_CONCAT`, whose ordering is
   * unspecified — SQLite and PostgreSQL are both free to return the same tags in
   * a different order on a different day. Joining them as they arrive would make
   * the embedded text, and therefore the content hash, unstable for an event
   * that has not changed: every sync would re-embed the corpus and spend the
   * monthly token allowance producing vectors identical to the stored ones.
   * That is the exact failure the hash exists to prevent, so determinism is
   * established here rather than assumed of the query.
   */
  if (tags.length) push('Tags', [...tags].sort().join(', '));
  push('Organization', organizationName);
  push('Location', event?.location);

  const description = String(event?.description ?? '').trim();
  if (description) push('About', description.slice(0, MAX_DESCRIPTION));

  return parts.join('\n');
}

/**
 * An ISO timestamp as epoch seconds, or null.
 *
 * Pinecone filters numerically with `$gte`/`$lte` but has no date type, so a
 * timestamp has to be a number to be range-filtered at all. Seconds rather than
 * milliseconds purely to keep the numbers small and readable in the console.
 */
function epochSeconds(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The filterable metadata, kept deliberately small.
 *
 * Pinecone allows 40 KB of filterable metadata per record. This uses a few
 * hundred bytes, and the restraint is the point: metadata is a candidate-quality
 * optimisation, not a copy of the row. Every one of these is a field the
 * retrieval step wants to narrow on BEFORE spending its top-K.
 *
 * ── What is missing, and why ──
 *
 * **Remaining spots.** It changes on every application and withdrawal. Indexing
 * it would mean re-upserting an event dozens of times a day to keep a number
 * that the authoritative query recomputes anyway. Discover's "only show me
 * events with space" filter runs in SQL, where the number is correct rather than
 * eventually correct.
 *
 * **`hours_closed_out_at`.** It is a post-completion bookkeeping fact with no
 * bearing on whether an event should be found, and it is precisely the field
 * that must not be confused with the lifecycle — see the note on `status`.
 *
 * **Anything derived from a viewer.** Metadata describes the event, never the
 * person searching. A per-user field would make the index a copy of the
 * permission model, which is the thing this design most wants to avoid.
 */
export function buildMetadata(event, { tags = [], startsAt = null } = {}) {
  const meta = {
    /* The event lifecycle as stored: open → closed → completed, plus cancelled.
       `closed` means SIGN-UPS are closed and is NOT a synonym for completed —
       the distinction the whole product depends on. It is indexed so that a
       search can skip the years of completed history that a district
       accumulates, which is where most of the corpus ends up living. */
    status: String(event?.status ?? 'open'),
    category: String(event?.category ?? 'Other'),
    audience: String(event?.audience ?? 'everyone'),
    documentVersion: DOCUMENT_VERSION,
  };

  if (event?.organization_id) meta.organizationId = String(event.organization_id);

  const deadline = epochSeconds(event?.application_deadline);
  if (deadline != null) meta.deadlineAt = deadline;

  /* The first shift's start, which is what a card shows as "the date" and what
     every date filter in `eventQuery.js` compares against. Passed in rather than
     read here, because it is an aggregate over `slots` and this module does no
     database work. */
  const starts = epochSeconds(startsAt);
  if (starts != null) meta.startsAt = starts;

  /* Tags are an array of short keys — one of the few array types Pinecone
     filters with `$in`, which is exactly how the tag facet queries. */
  if (tags.length) meta.tags = tags.slice(0, 32).map(String);

  return meta;
}

/** The complete record, ready for an ndjson upsert. */
export function buildRecord(event, extra = {}) {
  return {
    _id: vectorIdFor(event.id),
    [TEXT_FIELD]: buildEmbedText(event, extra),
    ...buildMetadata(event, extra),
  };
}

/**
 * A hash of everything that would change the stored record.
 *
 * ── This is the main free-tier protection ──
 *
 * Embedding is charged per token, with 5,000,000 tokens a month on Starter. A
 * backfill that re-embeds the whole corpus every time it runs would spend that
 * on work with no effect: the vectors would be identical. So nothing is sent
 * unless this hash differs from the one stored beside the event, which makes
 * re-running the backfill free and makes an ordinary event edit cost exactly one
 * event's worth of tokens.
 *
 * It covers the embedded text AND the metadata, because a status change moves no
 * words but must still reach the index — that is how a cancelled event stops
 * being offered. Metadata-only changes are cheap for us and cheap for Pinecone;
 * what matters is that neither kind of change can be silently skipped.
 *
 * The document version is folded in so that changing what this module embeds
 * invalidates every hash at once, and the next sync re-sends the corpus without
 * anybody having to remember to force it.
 */
export function contentHash(event, extra = {}) {
  const canonical = JSON.stringify({
    v: DOCUMENT_VERSION,
    text: buildEmbedText(event, extra),
    meta: sortedMetadata(buildMetadata(event, extra)),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Key order must not change the hash.
 *
 * `JSON.stringify` preserves insertion order, so two records that differ only in
 * the order their metadata was built would hash differently and re-embed for
 * nothing. Sorting makes the hash a function of the content alone.
 */
function sortedMetadata(meta) {
  const out = {};
  for (const key of Object.keys(meta).sort()) {
    out[key] = Array.isArray(meta[key]) ? [...meta[key]].sort() : meta[key];
  }
  return out;
}

/**
 * Should this event be in the index at all?
 *
 * Cancelled events are removed rather than indexed: nobody should ever be
 * recommended one, and leaving them in spends storage and top-K on records whose
 * only possible use is to be filtered out again downstream.
 *
 * Completed events ARE kept. They are how "what did the food pantry do last
 * spring" is answerable, and the status filter can exclude them per-query — a
 * decision the query makes, not the index.
 */
export function shouldIndex(event) {
  if (!event?.id) return false;
  return event.status !== 'cancelled';
}
