/**
 * Filter, sort and distance logic for the event list, in SQL.
 *
 * This moved off the client. BrowseEvents previously received every event and
 * did all of this in JavaScript, which is why the endpoint had to return the
 * whole table: a search over "the pages loaded so far" is a wrong answer, so the
 * client could not paginate while it owned the filtering. With the predicates
 * here, the server returns only matching rows and pagination finally means
 * something.
 *
 * Kept as its own module so the predicate and ordering logic can be tested
 * against a database directly, rather than only through the route.
 *
 * Every filter mirrors the client behaviour it replaces, including the details
 * that look like accidents but are not:
 *   • distance is in MILES (helpers.js uses R = 3958.8), not kilometres
 *   • an event with no coordinates is EXCLUDED by a distance filter and sorted
 *     LAST by distance, matching `distance != null` and `?? Infinity`
 *   • per-slot hours carry a 0.1 floor, as formatSlot does
 */
import { hoursBetween, greatest, least, substringPosition } from './db/dialectSql.js';

import { normaliseTag, MAX_TAGS_PER_EVENT } from './eventTags.js';

/** Sorts the client offers, mapped to a deterministic SQL ordering. */
const SORTS = {
  // NULL min_start sorts before every real date in SQLite, so unscheduled
  // events would otherwise lead the list.
  soonest: 'agg.min_start IS NULL, agg.min_start ASC',
  deadline: 'e.application_deadline ASC',
  spots: 'spots_remaining DESC',
  hours: 'agg.total_hours DESC',
  // A case-insensitive collation approximates localeCompare well enough for
  // titles and, unlike it, can use an index. Spelled lower-case: that is the one
  // token both engines resolve to their own collation, and the dialect ratchet
  // counts the two spellings separately.
  alpha: 'e.title COLLATE nocase ASC',
  /**
   * `NULLS LAST` rather than a leading `distance_miles IS NULL`.
   *
   * Both spellings mean "events with no coordinates go to the bottom", and the
   * `IS NULL` form is the one SQLite needs if you cannot assume `NULLS LAST` —
   * its ASC default is NULLS FIRST. But `distance_miles` is a SELECT alias, and
   * PostgreSQL resolves an output alias in ORDER BY only as a bare reference,
   * never inside an expression, so `distance_miles IS NULL` failed there with
   * "column distance_miles does not exist" and the nearest-first sort 500'd.
   *
   * `NULLS LAST` is understood by SQLite 3.30+ (this runs 3.51) and states the
   * intent directly instead of encoding it as a boolean sort key.
   */
  distance: 'distance_miles ASC NULLS LAST',
  /**
   * `relevance` is the only sort whose ORDER BY is built per request.
   *
   * The others are constants over columns. This one orders by the position an
   * event holds in the fused ranking that `discoverSearch.js` produced, which is
   * data rather than schema — so `buildEventOrder` takes the candidate list and
   * assembles a CASE from it. With no candidates (no query, or Pinecone
   * unavailable) it degrades to `soonest`, which is the default a student sees
   * anyway, so a relevance sort never becomes an error.
   */
  relevance: null
};

export const EVENT_SORTS = Object.keys(SORTS);
export const EVENT_STATUS_SCOPES = ['listable', 'open', 'all'];

/**
 * Validates and normalises the query string.
 *
 * @returns {{ok: true, value: object} | {ok: false, field: string, error: string}}
 */
export function parseEventFilters(query = {}) {
  const out = {
    q: '',
    category: null,
    /**
     * Selected tag keys, already normalised. Empty means "no tag filter".
     *
     * An ARRAY rather than a single value because the tag facet is multi-select,
     * and the values inside it are OR-ed — see `buildWhere`.
     */
    tags: [],
    /**
     * 'all' by default, NOT 'listable'.
     *
     * The endpoint has always returned every status, and the client filtered
     * `listable` itself — so the dashboards and the calendar rely on completed
     * and cancelled events being present to render service history. Defaulting
     * to 'listable' here would have silently emptied those screens. BrowseEvents
     * asks for 'listable' explicitly.
     */
    scope: 'all',
    openOnly: false,
    favoritesOnly: false,
    from: null,
    to: null,
    minHours: null,
    place: null,
    closingSoon: false,
    lat: null,
    lng: null,
    maxDistance: null,
    sort: 'soonest',
    /**
     * `mine=true` restricts to events the caller is actually involved in.
     *
     * This is what lets the app stop loading the whole table. The client keeps a
     * local index — the calendar resolves every application to its event, the
     * dashboards filter for their own — and that index only ever needs events the
     * user hosts or has applied to, which is bounded by their own activity rather
     * than by the district's history. Browse is a separate, filtered, paged query.
     */
    mine: false,
    /**
     * Event ids proposed by semantic search, in relevance order.
     *
     * NOT parsed from the query string — a client cannot ask for specific ids,
     * because that would be a way to probe for events by guessing. The route
     * fills this in from `discoverSearch.js` after the filters are validated.
     */
    semanticIds: null,
    /**
     * True when the caller asked for suggestions rather than a browse.
     *
     * Parsed here — unlike `semanticIds`, which a client may not supply — because
     * it is a request for a MODE, not for particular rows. It cannot name an
     * event, so it cannot be used to probe for one.
     */
    recommended: false,
    /**
     * Whether `semanticIds` NARROWS the result or merely widens the text match.
     *
     * Discover widens: an event matching the typed words is shown whether or not
     * the vector search proposed it. Recommendations narrow: the suggestion IS
     * the list, so anything outside it does not belong. One flag rather than two
     * code paths, so both go through the same predicates.
     */
    restrictToSemanticIds: false,
    /**
     * "Show me opportunities like this one" — an event id, not a row filter.
     *
     * Parsed here because, like `recommended`, it names a MODE rather than a
     * result: the caller is asking about an event it can already see, and the
     * events it gets back are chosen by the index and then filtered by the same
     * predicates as any other listing.
     */
    similarTo: null
  };

  const bool = (v) => v === 'true' || v === '1' || v === true;

  if (query.recommended != null) out.recommended = bool(query.recommended);

  /* An id, bounded and shape-checked. It is looked up in the index, never
     interpolated into SQL — `semanticIdParams` binds every id it is given. */
  if (query.similarTo != null && String(query.similarTo).trim()) {
    const raw = String(query.similarTo).trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(raw)) out.similarTo = raw;
  }

  if (query.q != null && String(query.q).trim()) out.q = String(query.q).trim().slice(0, 200);
  if (query.category && query.category !== 'All') out.category = String(query.category);

  /**
   * `tags` arrives as a repeated query parameter or a comma-separated list.
   *
   * Both, because Express gives `?tags=a&tags=b` as an array and `?tags=a,b` as a
   * string, and a client built against either shape should work. Every value goes
   * through `normaliseTag`, so the filter matches the same normalised keys the
   * writer stored — a URL carrying `?tags=NHS` finds events tagged `#nhs`.
   *
   * Unusable values are DROPPED rather than rejected, unlike on the write path. A
   * filter is a view: a stale or hand-edited URL should show what it can rather
   * than answer 400, and an empty result is already the honest answer for a tag
   * nobody used. The write path errors instead, because there an organizer needs
   * to know their tag did not save.
   */
  const rawTags = Array.isArray(query.tags)
    ? query.tags
    : (query.tags != null && String(query.tags).trim() ? String(query.tags).split(',') : []);
  if (rawTags.length) {
    const keys = new Set();
    for (const raw of rawTags.slice(0, MAX_TAGS_PER_EVENT)) {
      const normalised = normaliseTag(String(raw));
      if (normalised) keys.add(normalised.tag);
    }
    out.tags = [...keys];
  }
  if (query.place && query.place !== 'All') out.place = String(query.place);

  if (query.scope != null) {
    if (!EVENT_STATUS_SCOPES.includes(String(query.scope))) {
      return { ok: false, field: 'scope', error: `scope must be one of: ${EVENT_STATUS_SCOPES.join(', ')}` };
    }
    out.scope = String(query.scope);
  }

  out.mine = bool(query.mine);
  out.openOnly = bool(query.openOnly);
  out.favoritesOnly = bool(query.favoritesOnly);
  out.closingSoon = bool(query.closingSoon);

  for (const key of ['from', 'to']) {
    if (query[key]) {
      // Accepts the `YYYY-MM-DD` a date input produces. Rejecting anything else
      // keeps a malformed value from silently matching nothing.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(query[key]))) {
        return { ok: false, field: key, error: `${key} must be a YYYY-MM-DD date.` };
      }
      out[key] = String(query[key]);
    }
  }

  if (query.minHours != null && String(query.minHours) !== '') {
    const n = Number(query.minHours);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, field: 'minHours', error: 'minHours must be zero or greater.' };
    }
    out.minHours = n;
  }

  if (query.sort != null) {
    /**
     * `hasOwnProperty`, not truthiness.
     *
     * `relevance` maps to null — its ORDER BY is assembled per request from the
     * candidate list rather than being a constant — so a truthiness test would
     * reject the one sort that is spelled differently from the others while
     * accepting anything the object happens to inherit.
     */
    if (!Object.prototype.hasOwnProperty.call(SORTS, query.sort)) {
      return { ok: false, field: 'sort', error: `sort must be one of: ${EVENT_SORTS.join(', ')}` };
    }
    out.sort = String(query.sort);
  }

  // Coordinates travel together; one without the other cannot produce a distance.
  const hasLat = query.lat != null && String(query.lat) !== '';
  const hasLng = query.lng != null && String(query.lng) !== '';
  if (hasLat !== hasLng) {
    return { ok: false, field: hasLat ? 'lng' : 'lat', error: 'lat and lng must be supplied together.' };
  }
  if (hasLat) {
    const lat = Number(query.lat);
    const lng = Number(query.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return { ok: false, field: 'lat', error: 'lat must be between -90 and 90.' };
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return { ok: false, field: 'lng', error: 'lng must be between -180 and 180.' };
    }
    out.lat = lat;
    out.lng = lng;
  }

  if (query.maxDistance != null && String(query.maxDistance) !== '') {
    const n = Number(query.maxDistance);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, field: 'maxDistance', error: 'maxDistance must be greater than zero.' };
    }
    if (out.lat == null) {
      return { ok: false, field: 'maxDistance', error: 'maxDistance needs lat and lng.' };
    }
    out.maxDistance = n;
  }

  if (out.sort === 'distance' && out.lat == null) {
    return { ok: false, field: 'sort', error: 'Sorting by distance needs lat and lng.' };
  }

  return { ok: true, value: out };
}

/**
 * The shared aggregate and distance expressions.
 *
 * `spots_remaining` and `total_hours` are derived, not stored, so they have to be
 * computed here for the WHERE and ORDER BY to be able to reference them —
 * filtering on a value the client used to calculate after the fact is the whole
 * point of this module.
 *
 * The haversine is written with `min(1.0, …)` inside acos: floating-point error
 * can push the cosine a hair above 1 for two nearly identical points, and acos
 * of that is NaN, which would silently drop an event a user is standing next to.
 */
/**
 * The half of the WHERE clause that can be folded into the aggregate.
 *
 * ── Why the aggregate needs a WHERE at all ──
 *
 * `agg` used to have none. It folded every event and every slot in the database,
 * plus one correlated count per event, and only then did the outer query discard
 * almost all of it — so a search for one word cost the same as listing
 * everything. `postgres-scale-measurements.md` recorded that as this endpoint's
 * scaling limit and said the fix was structural rather than an index.
 *
 * Measured at 10,000 events with `bin/events-query-probe.mjs`: a category filter
 * 57.2ms -> 18.2ms, a text search 62.6 -> 23.5, `scope=open` 60.6 -> 32.2, a
 * search matching nothing 52.7 -> 17.0. The unfiltered default browse is
 * unchanged at 64-66ms, which is the number that had to not regress.
 *
 * ── Why this asks `buildEventWhere` rather than filtering the filters ──
 *
 * The first version of this deleted a hard-coded list of "aggregate-dependent"
 * filter keys before rebuilding the clause. That list was wrong on its first
 * outing — it named `hasSpots`, which is not a filter, and missed `openOnly`,
 * which is — and the CTE then referenced `agg` from inside the statement
 * producing it. A list of which filters touch the aggregate is a second
 * definition of something `buildEventWhere` already knows, and it drifted
 * immediately.
 *
 * So `buildEventWhere` takes `aggregateAvailable` instead and simply omits the
 * clauses it cannot honour. `openOnly` is the case that proves the design: it
 * contributes three predicates, only one of which touches the aggregate, and
 * this keeps the other two rather than dropping the whole filter.
 *
 * ── Why `needsUsers` ──
 *
 * Only the text search references the organizer (`u.name`). Joining `users`
 * inside the aggregate unconditionally cost the default browse about 10%, for a
 * column nothing in that request reads. Measured both ways; this is the version
 * with no regression.
 */
export function buildAggScope(filters, userId, db = null) {
  const { where } = buildEventWhere(filters, userId, db, { aggregateAvailable: false });
  return { where, needsUsers: Boolean(filters.q) };
}

export function eventQueryFragments({ lat, lng, db = null, aggScope = null }) {
  const EARTH_RADIUS_MILES = 3958.8;

  const distanceExpr = lat != null
    ? `(${EARTH_RADIUS_MILES} * acos(${least(db, '1.0', `
         cos(radians(@lat)) * cos(radians(e.latitude)) * cos(radians(e.longitude) - radians(@lng))
         + sin(radians(@lat)) * sin(radians(e.latitude))
       `)}))`
    : 'NULL';

  return {
    // A slot's hours carry a 0.1 floor, matching formatSlot, so a five-minute
    // shift does not count as zero and vanish from a minHours filter.
    /**
     * The accepted-application count is a correlated subquery inside `agg`, not
     * a second CTE joined beside it.
     *
     * It used to be `acc AS (SELECT event_id, COUNT(*) … GROUP BY event_id)`,
     * and the query plan showed what that cost: SQLite MATERIALIZED the whole
     * thing — a full scan of every application row — and then built an
     * `AUTOMATIC COVERING INDEX` over the materialised result to join it, on
     * every single execution. Two throwaway temp structures per request, to
     * answer a per-event count that `idx_applications_event(event_id, status)`
     * already answers directly.
     *
     * As a correlated subquery it is a covering-index seek per event and no
     * temp structure at all. Measured at 10,000 events / 20,000 slots /
     * 60,000 applications, folding this in and dropping the separate COUNT
     * query (see eventRoutes.js) together took the endpoint from 186ms to 79ms.
     */
    /**
     * The fold is restricted to the events that already survive the event-only
     * predicates — see `buildAggScope` for the measurements and the reasoning.
     *
     * With no scope supplied the CTE is exactly what it always was, so every
     * caller that has not been converted keeps the previous behaviour rather
     * than silently losing its filters.
     */
    aggCte: `
      agg AS (
        SELECT e.id AS event_id,
               MIN(s.start_datetime) AS min_start,
               MAX(s.end_datetime)   AS max_end,
               COALESCE(SUM(s.max_spots), 0) AS total_spots,
               COALESCE(SUM(
                 ${greatest(db, '0.1', hoursBetween(db, 's.start_datetime', 's.end_datetime'))}
               ), 0) AS total_hours,
               (SELECT COUNT(*) FROM applications a2
                 WHERE a2.event_id = e.id AND a2.status = 'accepted') AS accepted
        FROM events e
        ${aggScope?.needsUsers ? 'JOIN users u ON e.organizer_id = u.id' : ''}
        LEFT JOIN slots s ON s.event_id = e.id
        ${aggScope?.where ?? ''}
        GROUP BY e.id
      )
    `,
    distanceSelect: `${distanceExpr} AS distance_miles`,
    /* `greatest`, not `MAX`: SQLite overloads `max` as both the aggregate and
       the scalar, PostgreSQL keeps them apart and answers
       `function max(integer, bigint) does not exist`. */
    spotsSelect: `${greatest(db, '0', 'agg.total_spots - COALESCE(agg.accepted, 0)')} AS spots_remaining`
  };
}

/**
 * Builds the WHERE clause and its named parameters.
 *
 * Named parameters throughout: this clause is assembled from a variable number
 * of predicates, and positional placeholders would have to be counted by hand
 * across every branch — the kind of bookkeeping that silently binds the wrong
 * value once a filter is added in the middle.
 */
export function buildEventWhere(filters, userId, db = null, { aggregateAvailable = true } = {}) {
  const clauses = [];
  const params = {};

  // Browse never shows drafts, completed or cancelled events unless asked.
  if (filters.scope === 'listable') clauses.push(`e.status IN ('open', 'closed')`);
  else if (filters.scope === 'open') clauses.push(`e.status = 'open'`);

  if (filters.q) {
    // A position test on lowered text rather than LIKE: no wildcard characters
    // in user input can change the shape of the match. The engines spell the
    // function differently, so it comes from the dialect layer.
    const lexical = `
      ${substringPosition(db, 'lower(e.title)', 'lower(@q)')}
      OR ${substringPosition(db, 'lower(e.description)', 'lower(@q)')}
      OR ${substringPosition(db, 'lower(e.location)', 'lower(@q)')}
      OR ${substringPosition(db, 'lower(u.name)', 'lower(@q)')}
    `;
    params.q = filters.q;

    /**
     * ── The semantic half, added as an OR and nothing more ──
     *
     * `filters.semanticIds` is a list of event ids Pinecone proposed for this
     * query. Widening the text predicate is the ENTIRE integration on the read
     * path, and that is deliberate: every other clause in this function, the
     * sort, the `COUNT(*) OVER ()`, the LIMIT/OFFSET and the serialiser are
     * untouched, so a semantically-found event is subject to exactly the same
     * rules as a lexically-found one. There is no second code path to keep in
     * step and no way for a candidate to arrive with fewer checks applied.
     *
     * It is an OR rather than a replacement because the substring match is not
     * the weaker half. Somebody typing `Chess` wants the event called Chess
     * Club, and an embedding is not reliably better at that than an exact
     * match is — see `shouldUseSemantic`, which keeps the shortest and most
     * literal queries away from the vendor entirely.
     *
     * Positional names because SQLite has no array binding, the same reason
     * the tag facet spells its own IN list out.
     */
    const semantic = semanticIdParams(filters.semanticIds, params);
    clauses.push(semantic ? `((${lexical}) OR ${semantic})` : `(${lexical})`);
  }

  /**
   * Recommendations restrict rather than widen — see `restrictToSemanticIds`.
   *
   * Written as its own clause so it AND-s with everything else: a suggested
   * event still has to survive the status scope, the date bounds, the open-only
   * test and every other filter the caller sent. There is no path by which an id
   * from the vector index reaches a response without passing them.
   */
  if (filters.restrictToSemanticIds) {
    const restrict = semanticIdParams(filters.semanticIds, params);
    /* An empty candidate list must match NOTHING rather than everything. */
    clauses.push(restrict || '1 = 0');
  }

  if (filters.category) { clauses.push('e.category = @category'); params.category = filters.category; }

  /**
   * Tag filtering: OR *within* the facet, AND with everything else.
   *
   * ── Why OR and not AND ──
   *
   * Every other control in the browse toolbar is a different DIMENSION — a date,
   * a place, a category — so AND-ing them is what "narrow this down" means and is
   * the model the whole query is built on. Multiple values of ONE dimension is a
   * different question, and the faceted-search convention (and the one users
   * arrive with) is that ticking a second tag widens within that facet while the
   * facet as a whole still narrows the result set.
   *
   * AND-within-facet was considered and rejected on behaviour: organizer-created
   * tags are free text, so requiring an event to carry all of `#nhs`, `#food` and
   * `#weekend` returns nothing almost every time, and a filter that usually
   * answers "no results" reads as broken rather than as precise.
   *
   * ── Why EXISTS and not a JOIN ──
   *
   * A join to `event_tags` multiplies the row set by the number of matching tags,
   * which would break the `COUNT(*)` this same WHERE clause feeds for pagination
   * and would need a DISTINCT that defeats the index. `EXISTS` is a
   * semi-join: it stops at the first match, returns each event once, and uses
   * `idx_event_tags_tag` directly.
   *
   * Placeholders are generated positionally rather than as a named parameter
   * because SQLite has no array binding — `IN (@tags)` binds one value, silently
   * matching only the first tag. Each key gets its own `@tag0`, `@tag1`, … which
   * keeps every value bound rather than interpolated.
   */
  if (filters.tags?.length) {
    const names = filters.tags.map((_, i) => `@tag${i}`);
    filters.tags.forEach((tag, i) => { params[`tag${i}`] = tag; });
    clauses.push(
      `EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = e.id AND et.tag IN (${names.join(', ')}))`
    );
  }
  if (filters.place) { clauses.push('e.location = @place'); params.place = filters.place; }

  /**
   * "Open" is three conditions, not one: posted as open, still has a free spot,
   * and the deadline has not passed. The client checked all three; checking only
   * the status would offer students full events to apply to.
   */
  if (filters.openOnly) {
    clauses.push(`e.status = 'open'`);
    /* The only half of `openOnly` that reads the aggregate. Omitted when this
       clause is being built FOR the aggregate — the other two predicates are
       pure `events` and are kept, which is the whole point of gating the
       individual clause rather than dropping the filter. */
    if (aggregateAvailable) {
      clauses.push(`${greatest(db, '0', 'agg.total_spots - COALESCE(agg.accepted, 0)')} > 0`);
    }
    clauses.push('e.application_deadline > @now');
    params.now = new Date().toISOString();
  }

  /**
   * Any application status counts, and attendance is included separately.
   *
   * Withdrawn and rejected applications still belong in the index: the dashboards
   * show them as history, and omitting them would silently blank a student's past.
   * Attendance is checked too because credited hours are the record that matters
   * most, and losing one to a missing join would be the worst possible bug here.
   */
  if (filters.mine) {
    clauses.push(`(
      e.organizer_id = @me
      OR EXISTS (SELECT 1 FROM applications a WHERE a.event_id = e.id AND a.user_id = @me)
      OR EXISTS (SELECT 1 FROM attendance t WHERE t.event_id = e.id AND t.user_id = @me)
      OR EXISTS (SELECT 1 FROM user_favorites f2 WHERE f2.event_id = e.id AND f2.user_id = @me)
    )`);
    params.me = userId;
  }

  if (filters.favoritesOnly) {
    clauses.push('EXISTS (SELECT 1 FROM user_favorites f WHERE f.event_id = e.id AND f.user_id = @favUser)');
    params.favUser = userId;
  }

  // Date bounds apply to the first shift, which is what the card shows as the
  // event's date.
  if (filters.from && aggregateAvailable) { clauses.push('agg.min_start >= @from'); params.from = `${filters.from}T00:00:00.000Z`; }
  if (filters.to && aggregateAvailable) { clauses.push('agg.min_start <= @to'); params.to = `${filters.to}T23:59:59.999Z`; }

  if (filters.minHours != null && aggregateAvailable) {
    clauses.push('agg.total_hours >= @minHours');
    params.minHours = filters.minHours;
  }

  if (filters.closingSoon) {
    clauses.push('e.application_deadline BETWEEN @soonFrom AND @soonTo');
    params.soonFrom = new Date().toISOString();
    params.soonTo = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  /**
   * Coordinates are NOT bound here unless a WHERE clause actually uses them.
   *
   * node:sqlite rejects a named parameter that appears in the object but not in
   * the statement. The distance expression lives in the SELECT list, so a
   * `sort=distance` request with no `maxDistance` has lat/lng used by the row
   * query and not by the COUNT query — binding them to both made COUNT throw
   * "Unknown named parameter 'lat'" and the whole request 500. The caller adds
   * them to the row query's parameters explicitly.
   */
  if (filters.maxDistance != null) {
    // An event with no coordinates has no distance, so it cannot satisfy a
    // distance filter — the same as the client's `distance != null` test.
    clauses.push('e.latitude IS NOT NULL AND e.longitude IS NOT NULL');
    clauses.push(`(3958.8 * acos(${least(db, '1.0', `
      cos(radians(@lat)) * cos(radians(e.latitude)) * cos(radians(e.longitude) - radians(@lng))
      + sin(radians(@lat)) * sin(radians(e.latitude))
    `)})) <= @maxDistance`);
    params.maxDistance = filters.maxDistance;
    // Used by the clause immediately above, so they belong in these params.
    params.lat = filters.lat;
    params.lng = filters.lng;
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

/**
 * Binds a candidate id list and returns the `IN` fragment, or '' for no list.
 *
 * The parameter names are shared with `buildEventOrder` on purpose: the
 * relevance sort orders by position within this same list, and generating the
 * names twice is how the two would drift apart.
 *
 * Bounded at MAX_SEMANTIC_IDS. The list arrives from a bounded top-K, but a
 * predicate built by string concatenation should carry its own ceiling rather
 * than trust its caller's.
 */
const MAX_SEMANTIC_IDS = 100;

export function semanticIdParams(ids, params) {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  const capped = ids.slice(0, MAX_SEMANTIC_IDS).filter((id) => typeof id === 'string' && id);
  if (!capped.length) return '';
  const names = capped.map((_, i) => `@sem${i}`);
  capped.forEach((id, i) => { params[`sem${i}`] = id; });
  return `e.id IN (${names.join(', ')})`;
}

/**
 * `ORDER BY` for the chosen sort, always with a stable tiebreak.
 *
 * @param {string} sort one of EVENT_SORTS
 * @param {string[]} [semanticIds] the fused ranking, when sorting by relevance
 */
export function buildEventOrder(sort, semanticIds = null) {
  // e.id last, unconditionally: two events that tie on the sort key have no
  // inherent order, and without a tiebreak `offset` is unsound — a row can
  // appear on two pages or on none.
  const tiebreak = 'e.id ASC';

  if (sort === 'relevance') {
    const ids = Array.isArray(semanticIds) ? semanticIds.slice(0, MAX_SEMANTIC_IDS) : [];
    if (!ids.length) return `ORDER BY ${SORTS.soonest}, ${tiebreak}`;

    /**
     * Position in the candidate list, as a CASE.
     *
     * The alternative — sorting in JavaScript after the query — cannot work
     * here: the page is chosen by LIMIT/OFFSET inside SQL, so an ordering
     * applied afterwards would reorder one page rather than choose which rows
     * belong on it.
     *
     * Events the semantic half never proposed (they matched the words instead)
     * sort after every candidate rather than being dropped, and then by date
     * among themselves.
     */
    const whens = ids.map((_, i) => `WHEN @sem${i} THEN ${i}`).join(' ');
    return `ORDER BY CASE e.id ${whens} ELSE ${MAX_SEMANTIC_IDS} END ASC, ${SORTS.soonest}, ${tiebreak}`;
  }

  return `ORDER BY ${SORTS[sort] || SORTS.soonest}, ${tiebreak}`;
}

/* ── The two-phase page ───────────────────────────────────────────────────── */

/**
 * Sorts whose ORDER BY reads only EVENT columns, plus `soonest`, which reads a
 * per-event MIN over slots that a correlated subquery can supply directly.
 *
 * `spots` and `hours` are absent on purpose: both order by the fold itself
 * (`spots_remaining`, `agg.total_hours`), so the page cannot be chosen before
 * the fold exists. `distance` is absent because the distance expression needs
 * the SELECT list's bound parameters, and `relevance` because its CASE is built
 * from a candidate list that already bounds the result to a few hundred ids.
 */
const PHASE1_ORDER = {
  soonest: null,   // supplied by MIN_START_EXPR below
  deadline: 'e.application_deadline ASC',
  alpha: 'e.title COLLATE nocase ASC',
};

/** A per-event `MIN(start_datetime)` as a correlated seek, not a fold. */
const MIN_START_EXPR = '(SELECT MIN(s2.start_datetime) FROM slots s2 WHERE s2.event_id = e.id)';

/**
 * Whether this request's page can be chosen BEFORE the aggregate is computed.
 *
 * ── The problem being solved ──
 *
 * The browse query folds `agg` over every event that survives the event-only
 * predicates: a MIN, a MAX, two SUMs over slots and a correlated `COUNT(*)`
 * over `applications`, per event. Then `LIMIT 60` throws almost all of it away.
 * At 50,000 events that is fifty thousand application counts computed to
 * display sixty.
 *
 * Nothing outside the page needs those values — they are display fields on an
 * event card. So when the page can be chosen without them, it should be, and
 * the fold should run over sixty ids instead of fifty thousand.
 *
 * ── When it CANNOT be split, and why each case is real ──
 *
 * `openOnly` filters on `spots_remaining`; the date range filters on
 * `agg.min_start`/`agg.max_end`; `minHours` filters on `agg.total_hours`. A
 * predicate that reads the fold has to run after it. The `spots` and `hours`
 * sorts order by the fold for the same reason.
 *
 * Rather than enumerate those filters here — the mistake that produced a 500
 * the first time this query was restructured, because the hard-coded list named
 * a filter that did not exist and missed one that did — this ASKS the WHERE
 * clause that `buildEventWhere` actually produced whether it mentions the
 * aggregate. One definition, and it cannot drift from the builder.
 */
export function canSplitEventPage(filters, where) {
  const sort = filters.sort || 'soonest';
  if (!(sort in PHASE1_ORDER)) return false;
  /* `agg.` covers the CTE's columns; `spots_remaining` is the SELECT alias the
     openOnly predicate uses. Either means the fold has to come first. */
  return !/\bagg\.|spots_remaining/.test(where);
}

/**
 * Phase 1: the ids on this page, and the total, without touching the fold.
 *
 * `COUNT(*) OVER ()` is evaluated across the whole filtered set before
 * LIMIT/OFFSET, exactly as it is in the single-phase query, so the total is the
 * same number and costs nothing extra.
 *
 * The tiebreak is `e.id ASC`, unconditionally and identically to
 * `buildEventOrder` — without a total order `OFFSET` is unsound, and a page
 * chosen here with a different tiebreak than the one the outer query re-applies
 * would reorder rows within the page.
 */
export function buildEventPageCte(filters, aggScope, { paginated }) {
  const sort = filters.sort || 'soonest';
  const order = sort === 'soonest'
    ? `${MIN_START_EXPR} IS NULL, ${MIN_START_EXPR} ASC`
    : PHASE1_ORDER[sort];

  return `
    page AS (
      SELECT e.id AS event_id, COUNT(*) OVER () AS total_count
      FROM events e
      ${aggScope?.needsUsers ? 'JOIN users u ON e.organizer_id = u.id' : ''}
      ${aggScope?.where ?? ''}
      ORDER BY ${order}, e.id ASC
      ${paginated ? 'LIMIT @limit OFFSET @offset' : 'LIMIT @hardCap'}
    )
  `;
}

/**
 * The aggregate CTE, restricted to the page's ids.
 *
 * Takes the same fragment the single-phase query uses and joins `page` into its
 * FROM, so there is one definition of what the fold computes. Re-deriving it
 * here would be a second place for the hours floor and the accepted count to
 * drift.
 */
export function restrictAggToPage(aggCte) {
  return aggCte.replace('FROM events e', 'FROM events e JOIN page ON page.event_id = e.id');
}
