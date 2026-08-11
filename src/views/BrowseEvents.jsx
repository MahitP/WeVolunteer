/**
 * Opportunities — and, since v1.3.1, the whole of discovery.
 *
 * ── Why finding a person happens here ──
 *
 * There were two search boxes on two top-level destinations: this one, over
 * events, and "Find people", over members and organizations. That split asked a
 * reader to answer a question before they had typed anything — is "NHS" a club,
 * a person, or the food drive they run? — and the honest answer for a student is
 * usually "I don't know, that's why I'm searching".
 *
 * So there is one field, one query, and a `scope` control that FILTERS the
 * result rather than choosing where the query goes. "All" runs both searches at
 * once and shows people and organizations above the opportunity grid, because
 * they are the short list and the grid is the long one.
 *
 * ── What deliberately did not change ──
 *
 * The opportunities experience underneath. The category chips, the tag facet,
 * the advanced filters, the sort, the windowed grid and the paging are all
 * exactly as they were, and they are hidden only in the two scopes where they
 * would be filtering nothing. Folding discovery in must not cost a student the
 * screen they came for.
 */
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import EventCard from '../components/EventCard';
import { can } from '../authz';
import {
  Search, Sparkles, SlidersHorizontal, CalendarX2, Star, Filter, X, Plus,
  Building2, UserRound, MapPin, Users,
} from 'lucide-react';
import { formatHours, haversineDistance } from '../utils/helpers';
import { api } from '../utils/api';
import EmptyState from '../components/common/EmptyState';
import { useLocationContext } from '../contexts/LocationContext';
import { useWindowedRows } from '../hooks/useWindowedRows';
import { useDebounce } from '../hooks/useDebounce';
import DatePicker from '../components/common/DatePicker';
import { DistinctionTag } from '../components/profile/Distinction';
const CATEGORIES = ['All', 'School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];

/**
 * A coordinate rounded to the neighbourhood before it leaves the device.
 *
 * Two decimal places, about 1.1km. See the call site for why the filter can
 * afford it and why the displayed distance is computed separately.
 */
const coarsen = (deg) => Math.round(deg * 100) / 100;

/**
 * What the reader is looking for.
 *
 * A filter over one search, not a router for three. `all` is the default and
 * runs everything, so the control is something you reach for when the results
 * are too broad rather than something you must set before you begin.
 */
const SCOPES = [
  { id: 'all', label: 'Everything' },
  { id: 'events', label: 'Opportunities' },
  { id: 'people', label: 'People' },
  { id: 'organizations', label: 'Organizations' },
];

/** Two characters, matching the server's own `SEARCH_MIN` in directoryRoutes.js. */
const DIRECTORY_MIN = 2;

/**
 * What the live region says when a directory search settles.
 *
 * Exported for its test. The counts are pluralised independently and the empty
 * case is phrased as a negative rather than as "0 …", because this string is
 * read aloud and is the only signal a screen-reader user gets that the search
 * finished at all.
 */
export function discoveryAnnouncement(directory) {
  const people = directory?.users?.length ?? 0;
  const orgs = directory?.organizations?.length ?? 0;
  if (people === 0 && orgs === 0) return 'No people or organizations found';

  const parts = [];
  if (people > 0) parts.push(`${people} ${people === 1 ? 'person' : 'people'}`);
  if (orgs > 0) parts.push(`${orgs} ${orgs === 1 ? 'organization' : 'organizations'}`);
  return `${parts.join(' and ')} found`;
}
export default function BrowseEvents({
  currentUser,
  applications = [],
  onViewDetails,
  favorites = [],
  onToggleFavorite,
  /**
   * Records the events this screen has rendered.
   *
   * Browse queries the server directly, so it can show an event the app's local
   * index does not contain — one the user neither hosts nor has applied to.
   * Without this the event modal could not resolve it and the user would be told
   * "That event is no longer available" about something on screen.
   */
  onEventsSeen
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [sortBy, setSortBy] = useState('soonest');
  const [openOnly, setOpenOnly] = useState(true);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [recommendations, setRecommendations] = useState([]);

  // Advanced filters live behind a toggle so the default view stays calm
  const [showFilters, setShowFilters] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [minHours, setMinHours] = useState('');
  const [place, setPlace] = useState('All');
  const [closingSoon, setClosingSoon] = useState(false);
  const [maxDistance, setMaxDistance] = useState('');

  const { location, requestLocation, loading: locLoading, permissionDenied } = useLocationContext();

  const isStudent = currentUser?.role === 'student';

  /* ── Discovery: people and organizations, over the same query ────────────
     `directory.read` is what the endpoint requires, and a partner deliberately
     does not hold it (see server/authz.js). Everything below is gated on the
     capability rather than on the response, so a role that cannot search the
     directory never sees a control that would answer 403. */
  const canDiscover = can(currentUser, 'directory.read');

  /**
   * The scope lives in the URL.
   *
   * `/directory` was a shipped path and redirects to `/discover?find=people`, so
   * a bookmark or a link in a group chat still lands on the people results
   * rather than on an unexplained grid of events. It is also what makes a
   * search shareable at all.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const scopeParam = searchParams.get('find');
  const scope = canDiscover && SCOPES.some(s => s.id === scopeParam) ? scopeParam : 'all';
  const setScope = (next) => {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      if (next === 'all') params.delete('find');
      else params.set('find', next);
      return params;
    }, { replace: true });
  };

  /**
   * ── `@handle` and `#tag`, read from the one search field ──
   *
   * Discovery is one box over three kinds of thing, which is right for somebody
   * who does not know which kind they want and wrong for somebody who does.
   * The two sigils are what people already type when they do, so they cost no
   * explaining.
   *
   * `#tag` is routed through the EXISTING tag filter rather than a second
   * mechanism: the events endpoint already takes `tags` as normalised keys, the
   * facet chips below already set it, and a parallel path would be a second tag
   * system to keep in step with the first. `@handle` is people-only, so the
   * opportunity query is skipped entirely rather than run with a term that can
   * only fail to match.
   *
   * Normalisation matches the server's `normaliseTag`: strip the sigil,
   * collapse whitespace, lower-case. The comparison has to agree on both sides
   * or `#Food Drive` finds the organization and none of its events.
   */
  const searchIntent = useMemo(() => {
    const raw = query.trim();
    if (raw.startsWith('@')) return { kind: 'users', value: raw.slice(1).trim() };
    if (raw.startsWith('#')) {
      return { kind: 'tag', value: raw.slice(1).replace(/\s+/g, ' ').trim().toLocaleLowerCase() };
    }
    return { kind: 'all', value: raw };
  }, [query]);

  /**
   * A sigil narrows the sections, and outranks the scope control.
   *
   * `@handle` is a question about people; `#tag` is a question about tagged
   * things, and people are not tagged. Somebody who typed one of them has said
   * what they want more recently and more specifically than the tab they set
   * earlier, so the typed intent wins — and the tab is moved to match below, so
   * the two never disagree on screen.
   *
   * Declared after `searchIntent` and before the sections read it.
   */
  const sigil = searchIntent.kind;
  const showEvents = sigil === 'users' ? false : (scope === 'all' || scope === 'events');
  const showPeople = canDiscover && sigil !== 'tag' && (scope === 'all' || scope === 'people');
  const showOrganizations = canDiscover && sigil !== 'users'
    && (scope === 'all' || scope === 'organizations' || sigil === 'tag');

  const [directory, setDirectory] = useState(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const directoryAbort = useRef(null);

  /**
   * Debounced AND aborted, which are two different fixes.
   *
   * The debounce stops "volunteer" being nine requests. The abort stops a slow
   * response for "vol" landing after a fast one for "volunteer" and replacing
   * newer results with older ones — a correctness problem the debounce narrows
   * but does not close.
   */
  const runDirectory = useCallback((q, kind) => {
    directoryAbort.current?.abort();
    if (!canDiscover || kind === 'events' || q.trim().length < DIRECTORY_MIN) {
      setDirectory(null);
      setDirectoryLoading(false);
      return;
    }
    const controller = new AbortController();
    directoryAbort.current = controller;
    setDirectoryLoading(true);
    const type = kind === 'people' ? 'users' : kind === 'organizations' ? 'organizations' : 'all';
    api.searchDirectory(q.trim(), { type, signal: controller.signal })
      .then(res => { setDirectory(res); setDirectoryLoading(false); })
      .catch(err => {
        /* An abort is this component cancelling itself, not a failure to report.
           A real failure leaves the people section absent rather than replacing
           the opportunity grid with an error — the two searches fail
           independently and one of them working is still a useful page. */
        if (err.name === 'AbortError') return;
        setDirectory(null);
        setDirectoryLoading(false);
      });
  }, [canDiscover]);

  const debouncedDirectory = useDebounce(runDirectory, 250);

  /* ── Server-driven results ────────────────────────────────────────────────
     Every filter, the sort and the distance calculation run in SQL. They used
     to run here over the complete event list, which is precisely why the
     endpoint had to return the whole table: a text search over "the pages
     loaded so far" is a wrong answer, not a partial one. */
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [places, setPlaces] = useState(['All']);
  /**
   * Selected tag keys, and the vocabulary to offer.
   *
   * Keys (`nhs`), not labels, because the key is what the server filters on and
   * what a shareable URL should carry — a label would have to be re-normalised on
   * arrival and could not survive a spelling difference between organizers.
   */
  const [selectedTags, setSelectedTags] = useState([]);
  const [tagOptions, setTagOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [nextOffset, setNextOffset] = useState(null);

  const PAGE_SIZE = 60;


  /** Exactly what the server needs; `undefined` values are dropped by the api layer. */
  const serverFilters = useMemo(() => ({
    scope: 'listable',
    /* A sigil is a scope instruction, not text to match against a title. */
    q: searchIntent.kind === 'all' ? (searchIntent.value || undefined) : undefined,
    category: category !== 'All' ? category : undefined,
    /* Joined for the URL; the server also accepts a repeated parameter. Undefined
       rather than an empty string when nothing is selected, so the query does not
       carry a filter that means nothing. A `#tag` search adds its tag to
       whatever the facet chips already hold. */
    tags: (() => {
      const fromSigil = searchIntent.kind === 'tag' && searchIntent.value ? [searchIntent.value] : [];
      const all = [...new Set([...selectedTags, ...fromSigil])];
      return all.length ? all.join(',') : undefined;
    })(),
    place: place !== 'All' ? place : undefined,
    openOnly: openOnly || undefined,
    favoritesOnly: showFavoritesOnly || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
    minHours: minHours || undefined,
    closingSoon: closingSoon || undefined,
    /**
     * Coordinates travel only when they are actually needed, so a user who has
     * not granted location is never asked for it implicitly — and when they do
     * travel, they are coarsened to two decimal places first.
     *
     * Two decimal places is about 1.1km. That is accurate enough for "within
     * five miles" (the boundary blurs by well under a mile) and far too coarse
     * to say where somebody is. The exact position stays on the device, which
     * is where the displayed "1.8 mi away" is computed — so the number a
     * volunteer reads is exact while the number the server sees is a
     * neighbourhood.
     *
     * These are minors' positions, and the master plan required this. It had
     * not been implemented.
     */
    lat: (maxDistance || sortBy === 'distance') && location ? coarsen(location.latitude) : undefined,
    lng: (maxDistance || sortBy === 'distance') && location ? coarsen(location.longitude) : undefined,
    maxDistance: location ? (maxDistance || undefined) : undefined,
    sort: sortBy
  }), [searchIntent, category, place, openOnly, showFavoritesOnly, fromDate, toDate, minHours, closingSoon, maxDistance, sortBy, location, selectedTags]);

  /**
   * Debounced, and guarded against out-of-order responses.
   *
   * Typing fires a request per keystroke otherwise, and a slow early response can
   * land after a later one and show results for a query the user has already
   * changed. The generation check discards anything superseded.
   */
  const searchGeneration = useRef(0);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    const isCurrent = () => searchGeneration.current === generation;

    setLoading(true);
    setError('');

    const timer = setTimeout(async () => {
      try {
        const res = await api.fetchEventsFiltered({ ...serverFilters, limit: PAGE_SIZE, offset: 0 });
        if (!isCurrent()) return;
        setResults(res.events || []);
        setTotal(res.pagination?.total ?? (res.events || []).length);
        setNextOffset(res.pagination?.nextOffset ?? null);
        if (res.places) setPlaces(['All', ...res.places]);
        /* The vocabulary comes back with the results and is computed over every
           event rather than the current page — so ticking one tag does not remove
           the others from the bar. See the note in eventRoutes.js. */
        if (res.tags) setTagOptions(res.tags);
        onEventsSeen?.(res.events || []);
      } catch (err) {
        if (isCurrent()) setError(err.message || 'Could not load opportunities.');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }, query ? 300 : 0);   // only the text field needs debouncing

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverFilters]);

  useEffect(() => {
    debouncedDirectory(query, scope);
  }, [query, scope, debouncedDirectory]);

  useEffect(() => () => directoryAbort.current?.abort(), []);

  /**
   * Organizations to browse when nothing has been typed.
   *
   * People are deliberately NOT listed this way. An unprompted roster of every
   * child on the platform is not a thing to render by default, and it is the
   * whole reason the directory search has a two-character minimum; an
   * organization is a club that WANTS to be found.
   */
  /**
   * Fetched only in the scope that renders it.
   *
   * The effect used to run on every mount of this view, and this view is the
   * landing page a student opens most — so it was one wasted round trip per page
   * load, platform-wide, for a list only shown under the Organizations scope.
   * `showOrganizations` already means "this scope displays organizations", so
   * gating on it keeps the fetch and the render in step by construction.
   */
  const [browsedOrgs, setBrowsedOrgs] = useState(null);
  useEffect(() => {
    /* `scope === 'organizations'`, not `showOrganizations` — which is also true
       under the default 'all' scope, so gating on it saved nothing on the page
       students actually land on. The list below renders in this one scope. */
    if (scope !== 'organizations') return undefined;
    let cancelled = false;
    api.fetchOrganizations({ limit: 8 })
      .then(res => { if (!cancelled) setBrowsedOrgs(res.organizations || []); })
      .catch(() => { if (!cancelled) setBrowsedOrgs([]); });
    return () => { cancelled = true; };
  }, [scope]);

  const loadMore = async () => {
    if (nextOffset == null || loadingMore) return;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    try {
      const res = await api.fetchEventsFiltered({ ...serverFilters, limit: PAGE_SIZE, offset: nextOffset });
      // A filter change while this was in flight makes the page irrelevant.
      if (searchGeneration.current !== generation) return;
      setResults(prev => [...prev, ...(res.events || [])]);
      setNextOffset(res.pagination?.nextOffset ?? null);
      onEventsSeen?.(res.events || []);
    } catch (err) {
      setError(err.message || 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!isStudent) return;
    let cancelled = false;
    api.fetchRecommendations().then(recs => {
      if (!cancelled) setRecommendations(recs || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentUser?.id, isStudent]);

  /**
   * Recommendations arrive with only summary fields, so they are rendered from
   * that payload rather than looked up in a local event list — which is no longer
   * present here.
   */
  const recommended = useMemo(
    () => recommendations.filter(r => r && r.id).slice(0, 3),
    [recommendations]
  );
  const hasMatches = useMemo(() => recommended.some(e => (e.score || 0) > 0), [recommended]);

  const advancedCount = [fromDate, toDate, minHours, place !== 'All' ? place : '', closingSoon ? 'x' : '', maxDistance].filter(Boolean).length;

  /**
   * The distance a volunteer READS is computed here, not on the server.
   *
   * The server's `distance_miles` is measured from the coarsened centre we
   * send, so it can be off by up to about half a mile — invisible in a "within
   * 5 miles" filter, and wrong in a number printed on a card. Recomputing from
   * the exact position, which never left the device, keeps the card, the modal
   * and the dashboard all saying the same thing.
   *
   * Falls through to the server's value when there is no shared position, so
   * nothing regresses for a volunteer who has not opted in.
   */
  const filtered = useMemo(() => {
    if (!location) return results;
    return results.map(e => (
      e.latitude != null && e.longitude != null
        ? { ...e, distance: haversineDistance(location.latitude, location.longitude, e.latitude, e.longitude) }
        : e
    ));
  }, [results, location]);

  /**
   * Row windowing for the results grid.
   *
   * Still worth it even though pages are bounded: a user can press "Load more"
   * repeatedly, and each page is 60 cards.
   */
  const gridRef = useRef(null);
  const { start, end, padTop, padBottom } = useWindowedRows({ count: filtered.length, gridRef });
  const visibleEvents = useMemo(() => filtered.slice(start, end), [filtered, start, end]);

  /* Both conditions the `/events/new` route enforces, mirrored for display only.
     `requiresVerified` has no capability of its own — no capability expresses
     "approved yet" — so it stays a separate flag here exactly as it is in NAV. */
  const canCreate = can(currentUser, 'event.create') && Boolean(currentUser?.verified);
  /* Same shape, same reasoning: `/organizations/new` enforces both conditions
     itself, and so does every server route behind it. */
  const canCreateOrganization = can(currentUser, 'organization.create') && Boolean(currentUser?.verified);

  const hasFilters = query || category !== 'All' || !openOnly || showFavoritesOnly || selectedTags.length > 0 || advancedCount > 0;
  const clearFilters = () => {
    setQuery('');
    setCategory('All');
    setOpenOnly(true);
    setShowFavoritesOnly(false);
    setFromDate('');
    setToDate('');
    setMinHours('');
    setPlace('All');
    setClosingSoon(false);
    setMaxDistance('');
    /* Tags are a filter, so "Clear filters" has to clear them. Omitting this left
       an empty result set with a visible "no events match" and no visible reason,
       because the selected chips scroll out of view above the list. */
    setSelectedTags([]);
  };
  return <div className="stack-lg">
      {isStudent && <div className="row-between row-wrap">
          <p className="lead">
            {total} opportunit{total === 1 ? 'y' : 'ies'} posted ·{' '}
            <span className="strong">{formatHours(currentUser?.volunteeredHours || 0)}</span> credited to you so far
          </p>
        </div>}

      {/**
        * Posting an opportunity, where an organizer is already standing.
        *
        * It used to live only in the left rail as "New event", which put the
        * single most common organizer action — the reason they have an account —
        * behind reading a twelve-item list of mostly administrative pages. On a
        * phone the rail collapses to four items and a "More" sheet, so it was
        * often not on screen at all.
        *
        * `canCreate` repeats the two conditions the route itself enforces
        * (`event.create`, and verified). Repeating them is deliberate: this is
        * only what the person is SHOWN, and `/events/new` re-checks both, as does
        * every server route behind it. A button that appears and then refuses is
        * worse than no button, so the display condition has to match — but it is
        * not what makes the app safe.
        */}
      {/* `row-between row-wrap` is the same pair the student summary above uses —
          no new class, because this needs no layout the shell does not already
          have, and an undefined class fails `noDanglingClasses.test.js`. */}
      {(canCreate || canCreateOrganization) && <div className="row-between row-wrap">
          <p className="lead">
            {total} opportunit{total === 1 ? 'y' : 'ies'} posted
          </p>
          <div className="row row-wrap">
            {/* "New organization" moved here with the search it belongs beside.
                It was the header action on the Find people page, and deleting
                that page without it would have left creating a club reachable
                from nowhere at all. */}
            {canCreateOrganization && (
              <Link to="/organizations/new" className="btn btn-secondary">
                <Building2 size={16} aria-hidden="true" /> New organization
              </Link>
            )}
            {canCreate && (
              <Link to="/events/new" className="btn btn-primary">
                <Plus size={16} aria-hidden="true" /> Create event
              </Link>
            )}
          </div>
        </div>}

      {/* Suggestions come before the firehose — they're the shortest path to a
          good match for a student who doesn't know where to start. */}
      {recommended.length > 0 && <section>
          <div className="section-head">
            <h2 className="row s-a19c85">
              <Sparkles size={15} className="s-89c83f" /> {hasMatches ? 'Suggested for you' : 'Upcoming opportunities'}
            </h2>
          </div>
          <div className="grid grid-3">
            {recommended.map(event => <button key={event.id} className="card card-link card-pad" onClick={() => onViewDetails(event)}>
                <div className="eyebrow">{event.category}</div>
                <div className="strong s-57eca1">{event.title}</div>
                <div className="small muted s-956c6f">
                  {event.spotsRemaining} of {event.maxSpots} spots open · {event.applicantCount} applied ·{' '}
                  up to {formatHours(event.hoursAwarded)}
                </div>
              </button>)}
          </div>
        </section>}

      <section>
        {error && <div className="alert alert-danger" role="alert" style={{ marginBottom: 'var(--s4)' }}>
            <span>{error}</span>
          </div>}

        {/**
          * One field for everything, with the scope control directly under it.
          *
          * The control is `role="tablist"` rather than a `<select>`: there are
          * four options, they are the primary way to narrow a result, and a
          * select would hide three of them behind a tap on the surface where
          * this matters most. Each button reports its own `aria-selected`, and
          * the live region below announces the counts once rather than per row.
          */}
        <div className="discovery">
          <div className="input-affix discovery-field">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              className="input"
              placeholder={canDiscover
                ? 'Search opportunities, people, and organizations…'
                : 'Search events, places, organizers…'}
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label={canDiscover
                ? 'Search opportunities, people, and organizations'
                : 'Search opportunities'}
            />
          </div>

          {canDiscover && (
            <div className="tabs discovery-scopes" role="tablist" aria-label="What to search for">
              {SCOPES.map(s => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={scope === s.id}
                  className={scope === s.id ? 'tab tab-active' : 'tab'}
                  onClick={() => setScope(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/**
          * The only announcement a screen-reader user gets that the search
          * returned anything, so it has to read as a sentence.
          *
          * It was `${people + orgs} people and organizations found`, which says
          * "1 people and organizations found" for the single result that is by
          * far the most common outcome of typing somebody's name — and says
          * "0 people and organizations found" for none, where the natural
          * phrasing is a negative. The two kinds are counted separately and each
          * is pluralised on its own count, because "1 person and 2
          * organizations" is one sentence with two different plurals in it.
          */}
        {canDiscover && (
          <p className="sr-only" role="status" aria-live="polite">
            {directoryLoading
              ? 'Searching people and organizations'
              : directory
                ? discoveryAnnouncement(directory)
                : ''}
          </p>
        )}

        {/* ── People and organizations ─────────────────────────────────────
            Above the grid, because they are the short list and the grid is the
            long one — and because somebody who typed a person's name has
            already scrolled past everything else if these come after. */}
        {showPeople && directory?.users?.length > 0 && (
          <section className="stack-md discovery-results">
            <h2 className="section-head">People</h2>
            <ul className="list directory-list">
              {directory.users.map(user => (
                <li key={user.id} className="list-row">
                  <Link
                    to={user.username ? `/users/@${user.username}` : `/users/id/${user.id}`}
                    className="card card-pad card-link directory-row"
                  >
                    <span className="avatar directory-avatar" aria-hidden="true">
                      {user.profilePictureUrl
                        ? <img src={user.profilePictureUrl} alt="" className="avatar-img" />
                        : (user.avatar || <UserRound size={18} />)}
                    </span>
                    <span className="directory-body">
                      <span className="directory-name">{user.name}</span>
                      <span className="muted directory-meta">
                        {user.username && `@${user.username}`}
                        {user.location && (
                          <>
                            {user.username && ' · '}
                            <MapPin size={12} aria-hidden="true" /> {user.location}
                          </>
                        )}
                      </span>
                    </span>
                    {/* A partner or the platform owner says so, rather than
                        appearing as an unexplained account among students. */}
                    {user.distinction
                      ? <DistinctionTag distinction={user.distinction} />
                      : <span className="tag tag-brand directory-kind">Member</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {showOrganizations && directory?.organizations?.length > 0 && (
          <section className="stack-md discovery-results">
            <h2 className="section-head">Organizations</h2>
            <ul className="list directory-list">
              {directory.organizations.map(org => (
                <li key={org.id} className="list-row">
                  <Link to={`/organizations/${org.slug}`} className="card card-pad card-link directory-row">
                    <span className="avatar directory-avatar" aria-hidden="true"><Building2 size={18} /></span>
                    <span className="directory-body">
                      <span className="directory-name">{org.name}</span>
                      <span className="muted directory-meta">
                        {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
                        {org.eventCount > 0 && ` · ${org.eventCount} ${org.eventCount === 1 ? 'event' : 'events'}`}
                      </span>
                    </span>
                    <span className="tag tag-info directory-kind">Organization</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* With nothing typed and the reader looking for organizations, show the
            ones that exist — otherwise a club is discoverable only by somebody
            who already knows its name, which is the opposite of a directory.
            Scoped to that tab rather than shown under "Everything": on the
            default view this list would sit between the search box and the
            opportunities, pushing the thing most people came for down the page
            to answer a question they did not ask. */}
        {scope === 'organizations' && !directory && !query.trim() && browsedOrgs?.length > 0 && (
          <section className="stack-md discovery-results">
            <h2 className="section-head">Organizations to join</h2>
            <ul className="list directory-list">
              {browsedOrgs.map(org => (
                <li key={org.id} className="list-row">
                  <Link to={`/organizations/${org.slug}`} className="card card-pad card-link directory-row">
                    <span className="avatar directory-avatar" aria-hidden="true"><Building2 size={18} /></span>
                    <span className="directory-body">
                      <span className="directory-name">{org.name}</span>
                      <span className="muted directory-meta">
                        {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
                      </span>
                    </span>
                    <span className="tag tag-info directory-kind">Organization</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* A scope with nothing in it says so, rather than leaving the reader on
            an opportunity grid wondering whether their search ran. */}
        {(scope === 'people' || scope === 'organizations') && !directoryLoading && (
          (query.trim().length < DIRECTORY_MIN
            ? (scope === 'people' && (
              <EmptyState
                icon={Users}
                title="Search for someone"
                message="Type at least two characters of a name or a username."
              />
            ))
            : !directory?.users?.length && !directory?.organizations?.length && (
              <EmptyState
                icon={Search}
                title="Nothing matched"
                message={`No ${scope === 'people' ? 'people' : 'organizations'} matched “${query.trim()}”. Check the spelling, or try part of a name.`}
              />
            ))
        )}

        {/* Everything below is the opportunities experience, unchanged. It is
            hidden only in the two scopes where every one of these controls
            would be filtering a list that is not on screen. */}
        {showEvents && (<>
        <div className="toolbar">
          <label className="row small s-a19c85">
            <SlidersHorizontal size={14} className="s-c4c3e3" />
            <span className="dim nowrap">Sort</span>
            <select className="select" value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort by">
              <option value="soonest">Starting soonest</option>
              <option value="deadline">Closing soonest</option>
              <option value="spots">Most spots open</option>
              <option value="hours">Most hours</option>
              <option value="alpha">A–Z</option>
              {location && <option value="distance">Nearest to me</option>}
            </select>
          </label>

          <label className="check s-0923cb">
            <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />
            <span className="small nowrap">Open only</span>
          </label>

          {isStudent && <label className="check s-0923cb">
              <input type="checkbox" checked={showFavoritesOnly} onChange={e => setShowFavoritesOnly(e.target.checked)} />
              <span className="small nowrap row s-9d3307">
                <Star size={12} fill={showFavoritesOnly ? 'var(--accent)' : 'none'} style={{
              color: showFavoritesOnly ? 'var(--accent)' : 'inherit'
            }} />
                Starred only
              </span>
            </label>}
        </div>

        {/**
          * The tag facet.
          *
          * Rendered only when tags exist, so a district that never uses them never
          * sees an empty control. Selecting more than one WIDENS the result set —
          * OR within the facet — which is the faceted-search convention and is
          * said out loud in the hint, because "any of" versus "all of" is not
          * something a reader should have to infer from the result count.
          *
          * A `group` with an accessible name rather than a heading: it is one row
          * of controls beside the category chips, and each chip already reports
          * its own pressed state.
          */}
        {tagOptions.length > 0 && (
          <div className="row row-wrap s-775d10" role="group" aria-label="Filter by tag">
            <div className="chips">
              {tagOptions.map(({ tag, label }) => {
                const on = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className="chip"
                    aria-pressed={on}
                    onClick={() => setSelectedTags(prev => (
                      on ? prev.filter(t => t !== tag) : [...prev, tag]
                    ))}
                  >
                    <span aria-hidden="true">#</span>{label}
                  </button>
                );
              })}
            </div>
            {selectedTags.length > 1 && (
              <span className="small dim">Showing events with any of these tags</span>
            )}
          </div>
        )}

        <div className="row row-wrap s-775d10">
          <div className="chips">
            {CATEGORIES.map(cat => <button key={cat} className="chip" aria-pressed={category === cat} onClick={() => setCategory(cat)}>
                {cat}
              </button>)}
          </div>

          <button className="btn btn-secondary btn-sm s-dc310e" aria-expanded={showFilters} onClick={() => setShowFilters(v => !v)}>
            <Filter size={13} /> More filters
            {advancedCount > 0 && <span className="tag tag-brand">{advancedCount}</span>}
          </button>
        </div>

        {showFilters && <div className="card card-pad s-88cfef">
            <div className="grid s-346730">
              {/* Two independent pickers rather than one range widget, matching
                  AdminAuditExplorer and for the same reason recorded there: the
                  common query here is open-ended ("anything from next week on"),
                  and a range control wants both ends before it commits. They are
                  deliberately NOT bounded by each other either — pinning `min`
                  on the second to the first makes correcting a mistyped start
                  date impossible without clearing both. */}
              <div className="field s-535b39">
                <DatePicker
                  id="f-from"
                  label="Happening from"
                  value={fromDate}
                  onChange={setFromDate}
                />
              </div>
              <div className="field s-535b39">
                <DatePicker
                  id="f-to"
                  label="Up until"
                  value={toDate}
                  onChange={setToDate}
                />
              </div>
              <div className="field s-535b39">
                <label htmlFor="f-hours">Awards at least</label>
                <select id="f-hours" className="select" value={minHours} onChange={e => setMinHours(e.target.value)}>
                  <option value="">Any number of hours</option>
                  <option value="2">2 hours or more</option>
                  <option value="4">4 hours or more</option>
                  <option value="8">8 hours or more</option>
                </select>
              </div>
              <div className="field s-535b39">
                <label htmlFor="f-place">Location</label>
                <select id="f-place" className="select" value={place} onChange={e => setPlace(e.target.value)}>
                  {places.map(p => <option key={p} value={p}>{p === 'All' ? 'Anywhere' : p}</option>)}
                </select>
              </div>
              
              <div className="field s-535b39" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="f-distance">Distance from me</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {!location ? (
                    <button className="btn btn-secondary btn-sm" onClick={() => requestLocation()} disabled={locLoading || permissionDenied}>
                      {locLoading ? 'Locating...' : permissionDenied ? 'Location denied' : 'Share location to enable'}
                    </button>
                  ) : (
                    <select id="f-distance" className="select" style={{ maxWidth: '200px' }} value={maxDistance} onChange={e => {
                      setMaxDistance(e.target.value);
                      if (e.target.value) setSortBy('distance');
                    }}>
                      <option value="">Any distance</option>
                      <option value="5">Within 5 miles</option>
                      <option value="10">Within 10 miles</option>
                      <option value="25">Within 25 miles</option>
                      <option value="50">Within 50 miles</option>
                    </select>
                  )}
                </div>
              </div>
            </div>

            <div className="row-between row-wrap s-262f5d">
              <label className="check s-7e951b">
                <input type="checkbox" checked={closingSoon} onChange={e => setClosingSoon(e.target.checked)} />
                <span>
                  <span className="check-title">Closing within a week</span>
                  <span className="check-desc">Apply before these deadlines pass</span>
                </span>
              </label>

              {advancedCount > 0 && <button className="btn btn-ghost btn-sm" onClick={() => {
            setFromDate('');
            setToDate('');
            setMinHours('');
            setPlace('All');
            setClosingSoon(false);
            setMaxDistance('');
          }}>
                  <X size={13} /> Reset these
                </button>}
            </div>
          </div>}

        {loading ? <p className="small dim" role="status" aria-live="polite">Loading opportunities…</p>
          : filtered.length === 0 ? <EmptyState icon={CalendarX2} title={hasFilters ? 'No events match those filters' : 'No opportunities posted yet'} message={hasFilters ? 'Try a broader search, or clear the filters to see everything that\'s been posted.' : 'When an organizer posts a sign-up sheet, it will appear here.'} action={hasFilters && <button className="btn btn-secondary btn-sm" onClick={clearFilters}>Clear filters</button>} /> : <>
            <p className="small dim s-450599" role="status" aria-live="polite">
              Showing {filtered.length} of {total} event{total !== 1 ? 's' : ''}
            </p>
            {/*
              Only the rows near the viewport are mounted. Rendering the whole
              list produced 23,815 DOM nodes at 502 events; below the hook's
              threshold nothing is windowed, so a school with a dozen events
              renders exactly as before.

              The spacers carry the height of the rows that are not mounted, so
              the scrollbar and the scroll position stay truthful.
            */}
            <div className="eventgrid" ref={gridRef}>
              {padTop > 0 && <div aria-hidden="true" className="windowed-spacer" style={{ height: padTop }} />}
              {visibleEvents.map(event => <EventCard key={event.id} event={event} currentUser={currentUser} applications={applications} onViewDetails={onViewDetails} isFavorited={favorites.includes(event.id)} onToggleFavorite={onToggleFavorite} />)}
              {padBottom > 0 && <div aria-hidden="true" className="windowed-spacer" style={{ height: padBottom }} />}
            </div>

            {/* Paging is explicit rather than infinite-scroll: a button is
                reachable by keyboard and screen reader, announces its own state,
                and never fires a request because someone scrolled past. */}
            {nextOffset != null && <div className="row s-a19c85" style={{ justifyContent: 'center', marginTop: 'var(--s4)' }}>
                <button className="btn btn-secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load more (${total - filtered.length} remaining)`}
                </button>
              </div>}
          </>}
        </>)}
      </section>
    </div>;
}