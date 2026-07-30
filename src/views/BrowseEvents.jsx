import React, { useState, useMemo, useEffect, useRef } from 'react';
import EventCard from '../components/EventCard';
import { Search, Sparkles, SlidersHorizontal, CalendarX2, Star, Filter, X } from 'lucide-react';
import { formatHours } from '../utils/helpers';
import { api } from '../utils/api';
import EmptyState from '../components/common/EmptyState';
import { useLocationContext } from '../contexts/LocationContext';
import { useWindowedRows } from '../hooks/useWindowedRows';
const CATEGORIES = ['All', 'School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];
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

  /* ── Server-driven results ────────────────────────────────────────────────
     Every filter, the sort and the distance calculation run in SQL. They used
     to run here over the complete event list, which is precisely why the
     endpoint had to return the whole table: a text search over "the pages
     loaded so far" is a wrong answer, not a partial one. */
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [places, setPlaces] = useState(['All']);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [nextOffset, setNextOffset] = useState(null);

  const PAGE_SIZE = 60;

  /** Exactly what the server needs; `undefined` values are dropped by the api layer. */
  const serverFilters = useMemo(() => ({
    scope: 'listable',
    q: query.trim() || undefined,
    category: category !== 'All' ? category : undefined,
    place: place !== 'All' ? place : undefined,
    openOnly: openOnly || undefined,
    favoritesOnly: showFavoritesOnly || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
    minHours: minHours || undefined,
    closingSoon: closingSoon || undefined,
    // Coordinates travel only when they are actually needed, so a user who has
    // not granted location is never asked for it implicitly.
    lat: (maxDistance || sortBy === 'distance') && location ? location.latitude : undefined,
    lng: (maxDistance || sortBy === 'distance') && location ? location.longitude : undefined,
    maxDistance: location ? (maxDistance || undefined) : undefined,
    sort: sortBy
  }), [query, category, place, openOnly, showFavoritesOnly, fromDate, toDate, minHours, closingSoon, maxDistance, sortBy, location]);

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

  const filtered = results;

  /**
   * Row windowing for the results grid.
   *
   * Still worth it even though pages are bounded: a user can press "Load more"
   * repeatedly, and each page is 60 cards.
   */
  const gridRef = useRef(null);
  const { start, end, padTop, padBottom } = useWindowedRows({ count: filtered.length, gridRef });
  const visibleEvents = useMemo(() => filtered.slice(start, end), [filtered, start, end]);

  const hasFilters = query || category !== 'All' || !openOnly || showFavoritesOnly || advancedCount > 0;
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
  };
  return <div className="stack-lg">
      {isStudent && <div className="row-between row-wrap">
          <p className="lead">
            {total} opportunit{total === 1 ? 'y' : 'ies'} posted ·{' '}
            <span className="strong">{formatHours(currentUser?.volunteeredHours || 0)}</span> credited to you so far
          </p>
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

        <div className="toolbar">
          <div className="input-affix">
            <Search size={15} />
            <input type="search" className="input" placeholder="Search events, places, organizers…" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search opportunities" />
          </div>

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
              <div className="field s-535b39">
                <label htmlFor="f-from">Happening from</label>
                <input id="f-from" type="date" className="input" value={fromDate} onChange={e => setFromDate(e.target.value)} />
              </div>
              <div className="field s-535b39">
                <label htmlFor="f-to">Up until</label>
                <input id="f-to" type="date" className="input" value={toDate} onChange={e => setToDate(e.target.value)} />
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
      </section>
    </div>;
}