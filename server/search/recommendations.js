/**
 * "Because you saved the food pantry shift" — recommendations built from what a
 * student has already done in this application, and from nothing else.
 *
 * ── The privacy rule, first, because it shapes everything below ──
 *
 * **No user identifier, and no user's history, is ever sent to Pinecone.**
 *
 * The taste profile is assembled HERE, from this database, and what crosses the
 * network is a paragraph of EVENT text — words that are already in the index,
 * describing opportunities every authenticated user can already browse. Pinecone
 * is asked "what is like this?" and is never told who is asking or why. There is
 * no per-user vector, no user namespace, and nothing stored on the vendor that
 * describes a person.
 *
 * That is not caution for its own sake. This population is mostly minors, and a
 * per-user embedding is a behavioural profile of a child held by a third party.
 * The recommendation quality difference does not come close to justifying it,
 * and the design below gets most of the value without ever creating one.
 *
 * ── No new tracking ──
 *
 * Every signal used already exists because the product needs it for something
 * else: favourites exist so students can save things, applications exist because
 * that is the product, attendance exists because hours are the point. Nothing
 * here logs a view, a click, a hover or a search. A recommender that needs a
 * surveillance layer to work is not one this application should have.
 *
 * ── Explainability is not decoration ──
 *
 * Every recommendation carries the reason it was made, and the reason is a fact
 * from the database rather than a rationalisation. A student who is shown an
 * opportunity should be able to see why, and an organizer asking why their event
 * is not being suggested should get a real answer.
 */
import { semanticCandidates } from './discoverSearch.js';
import { pineconeEnabled } from './pineconeConfig.js';

/**
 * How many of the student's own events shape the profile.
 *
 * Recent rather than all: interests change over four years of school, and a
 * profile averaged over everything a senior ever did is a description of nobody.
 * Six is enough for a stable signal and few enough that one outlier cannot
 * dominate the paragraph.
 */
const PROFILE_EVENTS = 6;

/** The signals, in the order they say the most about intent. */
const SIGNAL_SQL = `
  SELECT e.id, e.title, e.category, e.location, e.status,
         (SELECT GROUP_CONCAT(et.tag) FROM event_tags et WHERE et.event_id = e.id) AS tag_list,
         src.signal, src.at
    FROM (
      /* Saving something is the clearest statement of interest a student can
         make without committing to it, so it is weighted first by being listed
         first. The at column breaks ties within a signal, not across them. */
      SELECT event_id, 'favorite' AS signal, 1 AS rank, '' AS at
        FROM user_favorites WHERE user_id = @me
      UNION ALL
      SELECT event_id, 'applied' AS signal, 2 AS rank, applied_at AS at
        FROM applications WHERE user_id = @me AND status <> 'withdrawn'
      UNION ALL
      SELECT event_id, 'attended' AS signal, 3 AS rank, '' AS at
        FROM attendance WHERE user_id = @me AND present = 1
    ) src
    JOIN events e ON e.id = src.event_id
   ORDER BY src.rank ASC, src.at DESC
   LIMIT @limit
`;

/**
 * The events this student has engaged with, most telling first.
 *
 * Used for two things: to build the profile, and to make sure none of them is
 * recommended back. Being shown the thing you already signed up for is the
 * failure mode that makes a recommender feel broken.
 */
async function engagedEvents(db, userId, limit = PROFILE_EVENTS) {
  try {
    return await db.prepare(SIGNAL_SQL).all({ me: userId, limit });
  } catch {
    return [];
  }
}

/** Every event id this student is already involved with, at any status. */
async function engagedIds(db, userId) {
  try {
    const rows = await db.prepare(`
      SELECT event_id FROM user_favorites WHERE user_id = @me
      UNION SELECT event_id FROM applications WHERE user_id = @me
      UNION SELECT event_id FROM attendance WHERE user_id = @me
      UNION SELECT id AS event_id FROM events WHERE organizer_id = @me
    `).all({ me: userId });
    return new Set(rows.map((r) => r.event_id));
  } catch {
    return new Set();
  }
}

/**
 * The query text, built from event content only.
 *
 * Titles, categories and tags — not descriptions. A description is long enough
 * that six of them would swamp the profile with one organizer's prose style
 * rather than the subject matter, and the subject matter is the whole signal.
 */
export function buildProfileText(events) {
  const categories = new Set();
  const tags = new Set();
  const titles = [];

  for (const e of events) {
    if (e?.category) categories.add(String(e.category));
    for (const t of String(e?.tag_list ?? '').split(',')) {
      const tag = t.trim();
      if (tag) tags.add(tag);
    }
    if (e?.title) titles.push(String(e.title));
  }

  const parts = [];
  if (categories.size) parts.push(`Categories: ${[...categories].join(', ')}`);
  if (tags.size) parts.push(`Tags: ${[...tags].slice(0, 12).join(', ')}`);
  if (titles.length) parts.push(`Similar to: ${titles.slice(0, PROFILE_EVENTS).join('; ')}`);
  return parts.join('\n');
}

/**
 * Why this event is being suggested, in the student's own history.
 *
 * Derived from the strongest signal that produced the profile, because that is
 * the honest answer — the recommendation came from the whole profile, and the
 * strongest contributor is the part of it a person will recognise.
 */
export function explain(signalEvents) {
  const byCategory = signalEvents.find((e) => e?.category);
  const favourite = signalEvents.find((e) => e?.signal === 'favorite');
  const attended = signalEvents.find((e) => e?.signal === 'attended');

  if (favourite?.title) return { reason: 'saved', detail: favourite.title };
  if (attended?.category) return { reason: 'attended_category', detail: attended.category };
  if (byCategory?.category) return { reason: 'category', detail: byCategory.category };
  return { reason: 'popular', detail: null };
}

/**
 * Recommended event ids for one student, in order, with the reason.
 *
 * Returns IDS, never events — the caller hydrates them through the authoritative
 * query, exactly as Discover does, so a recommendation is subject to every
 * filter, status rule and serialisation rule an ordinary listing is. A
 * recommender that assembled its own event objects would be a second read path
 * with its own bugs.
 *
 * ── Cold start ──
 *
 * A student with no history gets `{ ids: [], reason: 'cold_start' }` and the
 * caller falls back to a database query — soonest, open, with places left, which
 * is a genuinely good answer for a new student and costs no vendor call at all.
 * The cold-start path deliberately does not invent a profile from a school or a
 * year group: guessing that a ninth-grader wants what other ninth-graders want
 * is a stereotype dressed as personalisation, and it is not needed to make the
 * page useful.
 */
export async function recommendationsFor(db, userId, { limit = 20 } = {}) {
  if (!userId) return { ids: [], reason: 'anonymous', explanation: null };

  const signals = await engagedEvents(db, userId);
  if (!signals.length) {
    return { ids: [], reason: 'cold_start', explanation: { reason: 'popular', detail: null } };
  }

  if (!pineconeEnabled()) {
    return { ids: [], reason: 'disabled', explanation: explain(signals) };
  }

  const profile = buildProfileText(signals);
  if (!profile) {
    return { ids: [], reason: 'no_profile', explanation: explain(signals) };
  }

  /* `listable` so that history is not recommended: an event whose sign-ups have
     closed is still worth finding by search, and is never worth suggesting. */
  const found = await semanticCandidates(profile, { scope: 'listable' }, { topK: limit * 3 });
  if (!found.ok) {
    return { ids: [], reason: found.reason ?? 'unavailable', explanation: explain(signals) };
  }

  const already = await engagedIds(db, userId);
  const ids = found.ids.filter((id) => !already.has(id)).slice(0, limit);

  return {
    ids,
    reason: ids.length ? 'personalised' : 'exhausted',
    explanation: explain(signals),
  };
}

/**
 * The words a reason turns into.
 *
 * Kept on the server beside the logic that chooses them so that a new reason
 * cannot ship without its sentence — a client-side map would silently render an
 * unknown key as nothing, which is how a recommendation ends up with no
 * explanation at all.
 */
export function explanationText({ reason, detail } = {}) {
  switch (reason) {
    case 'saved':
      return detail ? `Because you saved “${detail}”` : 'Because of an opportunity you saved';
    case 'attended_category':
      return detail ? `Because you volunteered in ${detail}` : 'Because of your past volunteering';
    case 'category':
      return detail ? `Because you’re interested in ${detail}` : 'Based on your interests';
    case 'popular':
    default:
      return 'Popular with volunteers right now';
  }
}
