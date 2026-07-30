import React, { useState, useMemo, useEffect, useRef } from 'react';
import EventCard from '../components/EventCard';
import { Search, Sparkles, SlidersHorizontal, CalendarX2, Star, Filter, X } from 'lucide-react';
import { formatHours, haversineDistance } from '../utils/helpers';
import { api } from '../utils/api';
import EmptyState from '../components/common/EmptyState';
import { useLocationContext } from '../contexts/LocationContext';
import { useWindowedRows } from '../hooks/useWindowedRows';
const CATEGORIES = ['All', 'School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];
export default function BrowseEvents({
  currentUser,
  events = [],
  applications = [],
  onViewDetails,
  favorites = [],
  onToggleFavorite,
  /**
   * True while later pages of the event list are still arriving.
   *
   * Events load a page at a time, so this screen can be legitimately incomplete
   * while it renders. Without this the empty state would claim "No events match
   * those filters" during a load, which is a wrong answer rather than a slow one.
   */
  isLoadingMore = false
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
  useEffect(() => {
    if (!isStudent) return;
    let cancelled = false;
    api.fetchRecommendations().then(recs => {
      if (!cancelled) setRecommendations(recs || []);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id, isStudent, events]);
  const listable = useMemo(() => events.filter(e => e.status === 'open' || e.status === 'closed'), [events]);
  const places = useMemo(() => ['All', ...[...new Set(listable.map(e => e.location).filter(Boolean))].sort()], [listable]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    
    // First map over events to attach distances if we have the user's location
    const results = listable.map(event => {
      let distance = null;
      if (location && event.latitude != null && event.longitude != null) {
        distance = haversineDistance(location.latitude, location.longitude, event.latitude, event.longitude);
      }
      return { ...event, distance };
    }).filter(event => {
      const matchesQuery = !q || event.title.toLowerCase().includes(q) || event.description.toLowerCase().includes(q) || event.location.toLowerCase().includes(q) || event.organizerName?.toLowerCase().includes(q);
      const matchesCategory = category === 'All' || event.category === category;
      const isOpen = event.status === 'open' && event.spotsRemaining > 0 && new Date(event.applicationDeadline) > new Date();
      const matchesFavorite = !showFavoritesOnly || favorites.includes(event.id);
      const start = new Date(event.startDatetime);
      const matchesFrom = !fromDate || start >= new Date(`${fromDate}T00:00:00`);
      const matchesTo = !toDate || start <= new Date(`${toDate}T23:59:59`);
      const matchesHours = !minHours || (event.hoursAwarded || 0) >= Number(minHours);
      const matchesPlace = place === 'All' || event.location === place;
      const matchesDistance = !maxDistance || (event.distance != null && event.distance <= Number(maxDistance));

      // "Closing soon" means you have a week or less to decide
      const deadline = new Date(event.applicationDeadline);
      const daysLeft = (deadline - new Date()) / 86400000;
      const matchesClosing = !closingSoon || daysLeft >= 0 && daysLeft <= 7;
      
      return matchesQuery && matchesCategory && (!openOnly || isOpen) && matchesFavorite && matchesFrom && matchesTo && matchesHours && matchesPlace && matchesClosing && matchesDistance;
    });
    const sorters = {
      soonest: (a, b) => new Date(a.startDatetime) - new Date(b.startDatetime),
      deadline: (a, b) => new Date(a.applicationDeadline) - new Date(b.applicationDeadline),
      spots: (a, b) => b.spotsRemaining - a.spotsRemaining,
      hours: (a, b) => b.hoursAwarded - a.hoursAwarded,
      alpha: (a, b) => a.title.localeCompare(b.title),
      distance: (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity)
    };
    return [...results].sort(sorters[sortBy] || sorters.soonest);
  }, [listable, query, category, sortBy, openOnly, showFavoritesOnly, favorites, fromDate, toDate, minHours, place, closingSoon, maxDistance, location]);
  const recommended = useMemo(() => {
    return recommendations.map(r => {
      const found = events.find(e => e.id === r.id);
      return found ? {
        ...found,
        score: r.score
      } : null;
    }).filter(e => e && e.status === 'open' && e.spotsRemaining > 0).slice(0, 3);
  }, [recommendations, events]);
  const hasMatches = useMemo(() => recommended.some(e => (e.score || 0) > 0), [recommended]);
  const advancedCount = [fromDate, toDate, minHours, place !== 'All' ? place : '', closingSoon ? 'x' : '', maxDistance].filter(Boolean).length;
  /**
   * Row windowing for the results grid.
   *
   * `filtered` can be the district's entire event history. Only the rows near
   * the viewport are mounted; see hooks/useWindowedRows.js for why this windows
   * by row rather than by item.
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
            {listable.length} opportunit{listable.length === 1 ? 'y' : 'ies'} posted ·{' '}
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

        {filtered.length === 0 && isLoadingMore ? <p className="small dim" role="status" aria-live="polite">Loading opportunities…</p>
          : filtered.length === 0 ? <EmptyState icon={CalendarX2} title={hasFilters ? 'No events match those filters' : 'No opportunities posted yet'} message={hasFilters ? 'Try a broader search, or clear the filters to see everything that\'s been posted.' : 'When an organizer posts a sign-up sheet, it will appear here.'} action={hasFilters && <button className="btn btn-secondary btn-sm" onClick={clearFilters}>Clear filters</button>} /> : <>
            <p className="small dim s-450599" role="status" aria-live="polite">
              {filtered.length} event{filtered.length !== 1 ? 's' : ''}
              {isLoadingMore && <> · <span className="dim">still loading more…</span></>}
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
          </>}
      </section>
    </div>;
}