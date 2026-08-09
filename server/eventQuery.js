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

import { normaliseTag, MAX_TAGS_PER_EVENT } from './eventTags.js';

/** Sorts the client offers, mapped to a deterministic SQL ordering. */
const SORTS = {
  // NULL min_start sorts before every real date in SQLite, so unscheduled
  // events would otherwise lead the list.
  soonest: 'agg.min_start IS NULL, agg.min_start ASC',
  deadline: 'e.application_deadline ASC',
  spots: 'spots_remaining DESC',
  hours: 'agg.total_hours DESC',
  // COLLATE NOCASE approximates localeCompare well enough for titles and, unlike
  // it, can use an index.
  alpha: 'e.title COLLATE NOCASE ASC',
  distance: 'distance_miles IS NULL, distance_miles ASC'
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
    mine: false
  };

  const bool = (v) => v === 'true' || v === '1' || v === true;

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
    if (!SORTS[query.sort]) {
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
export function eventQueryFragments({ lat, lng }) {
  const EARTH_RADIUS_MILES = 3958.8;

  const distanceExpr = lat != null
    ? `(${EARTH_RADIUS_MILES} * acos(min(1.0,
         cos(radians(@lat)) * cos(radians(e.latitude)) * cos(radians(e.longitude) - radians(@lng))
         + sin(radians(@lat)) * sin(radians(e.latitude))
       )))`
    : 'NULL';

  return {
    // A slot's hours carry a 0.1 floor, matching formatSlot, so a five-minute
    // shift does not count as zero and vanish from a minHours filter.
    aggCte: `
      agg AS (
        SELECT e.id AS event_id,
               MIN(s.start_datetime) AS min_start,
               MAX(s.end_datetime)   AS max_end,
               COALESCE(SUM(s.max_spots), 0) AS total_spots,
               COALESCE(SUM(
                 max(0.1, ROUND((julianday(s.end_datetime) - julianday(s.start_datetime)) * 24, 2))
               ), 0) AS total_hours
        FROM events e
        LEFT JOIN slots s ON s.event_id = e.id
        GROUP BY e.id
      ),
      acc AS (
        SELECT event_id, COUNT(*) AS accepted
        FROM applications WHERE status = 'accepted'
        GROUP BY event_id
      )
    `,
    distanceSelect: `${distanceExpr} AS distance_miles`,
    spotsSelect: 'MAX(0, agg.total_spots - COALESCE(acc.accepted, 0)) AS spots_remaining'
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
export function buildEventWhere(filters, userId) {
  const clauses = [];
  const params = {};

  // Browse never shows drafts, completed or cancelled events unless asked.
  if (filters.scope === 'listable') clauses.push(`e.status IN ('open', 'closed')`);
  else if (filters.scope === 'open') clauses.push(`e.status = 'open'`);

  if (filters.q) {
    // instr on lowered text rather than LIKE: no wildcard characters in user
    // input can change the shape of the match.
    clauses.push(`(
      instr(lower(e.title), lower(@q)) > 0
      OR instr(lower(e.description), lower(@q)) > 0
      OR instr(lower(e.location), lower(@q)) > 0
      OR instr(lower(u.name), lower(@q)) > 0
    )`);
    params.q = filters.q;
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
    clauses.push('MAX(0, agg.total_spots - COALESCE(acc.accepted, 0)) > 0');
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
  if (filters.from) { clauses.push('agg.min_start >= @from'); params.from = `${filters.from}T00:00:00.000Z`; }
  if (filters.to) { clauses.push('agg.min_start <= @to'); params.to = `${filters.to}T23:59:59.999Z`; }

  if (filters.minHours != null) {
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
    clauses.push(`(3958.8 * acos(min(1.0,
      cos(radians(@lat)) * cos(radians(e.latitude)) * cos(radians(e.longitude) - radians(@lng))
      + sin(radians(@lat)) * sin(radians(e.latitude))
    ))) <= @maxDistance`);
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

/** `ORDER BY` for the chosen sort, always with a stable tiebreak. */
export function buildEventOrder(sort) {
  // e.id last, unconditionally: two events that tie on the sort key have no
  // inherent order, and without a tiebreak `offset` is unsound — a row can
  // appear on two pages or on none.
  return `ORDER BY ${SORTS[sort] || SORTS.soonest}, e.id ASC`;
}
