import React, { useState, useMemo, useEffect } from 'react';
import EventCard from '../components/EventCard';
import { Search, Sparkles, SlidersHorizontal, CalendarX2, Star, Filter, X } from 'lucide-react';
import { formatHours } from '../utils/helpers';
import { api } from '../utils/api';
import EmptyState from '../components/EmptyState';

const CATEGORIES = ['All', 'School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];

export default function BrowseEvents({
  currentUser, events = [], applications = [], onViewDetails,
  favorites = [], onToggleFavorite
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

  const isStudent = currentUser?.role === 'student';

  useEffect(() => {
    if (!isStudent) return;
    let cancelled = false;
    api.fetchRecommendations()
      .then(recs => { if (!cancelled) setRecommendations(recs || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentUser?.id, isStudent, events]);

  const listable = useMemo(
    () => events.filter(e => e.status === 'open' || e.status === 'closed'),
    [events]
  );

  const places = useMemo(
    () => ['All', ...[...new Set(listable.map(e => e.location).filter(Boolean))].sort()],
    [listable]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const results = listable.filter(event => {
      const matchesQuery = !q ||
        event.title.toLowerCase().includes(q) ||
        event.description.toLowerCase().includes(q) ||
        event.location.toLowerCase().includes(q) ||
        event.organizerName?.toLowerCase().includes(q);
      const matchesCategory = category === 'All' || event.category === category;
      const isOpen = event.status === 'open' &&
        event.spotsRemaining > 0 &&
        new Date(event.applicationDeadline) > new Date();
      const matchesFavorite = !showFavoritesOnly || favorites.includes(event.id);

      const start = new Date(event.startDatetime);
      const matchesFrom = !fromDate || start >= new Date(`${fromDate}T00:00:00`);
      const matchesTo = !toDate || start <= new Date(`${toDate}T23:59:59`);
      const matchesHours = !minHours || (event.hoursAwarded || 0) >= Number(minHours);
      const matchesPlace = place === 'All' || event.location === place;

      // "Closing soon" means you have a week or less to decide
      const deadline = new Date(event.applicationDeadline);
      const daysLeft = (deadline - new Date()) / 86400000;
      const matchesClosing = !closingSoon || (daysLeft >= 0 && daysLeft <= 7);

      return matchesQuery && matchesCategory && (!openOnly || isOpen) && matchesFavorite &&
        matchesFrom && matchesTo && matchesHours && matchesPlace && matchesClosing;
    });

    const sorters = {
      soonest: (a, b) => new Date(a.startDatetime) - new Date(b.startDatetime),
      deadline: (a, b) => new Date(a.applicationDeadline) - new Date(b.applicationDeadline),
      spots: (a, b) => b.spotsRemaining - a.spotsRemaining,
      hours: (a, b) => b.hoursAwarded - a.hoursAwarded,
      alpha: (a, b) => a.title.localeCompare(b.title)
    };
    return [...results].sort(sorters[sortBy] || sorters.soonest);
  }, [listable, query, category, sortBy, openOnly, showFavoritesOnly, favorites,
      fromDate, toDate, minHours, place, closingSoon]);

  const recommended = useMemo(() => {
    return recommendations
      .map(r => {
        const found = events.find(e => e.id === r.id);
        return found ? { ...found, score: r.score } : null;
      })
      .filter(e => e && e.status === 'open' && e.spotsRemaining > 0)
      .slice(0, 3);
  }, [recommendations, events]);

  const hasMatches = useMemo(() => recommended.some(e => (e.score || 0) > 0), [recommended]);

  const advancedCount = [fromDate, toDate, minHours, place !== 'All' ? place : '', closingSoon ? 'x' : '']
    .filter(Boolean).length;
  const hasFilters = query || category !== 'All' || !openOnly || showFavoritesOnly || advancedCount > 0;

  const clearFilters = () => {
    setQuery(''); setCategory('All'); setOpenOnly(true); setShowFavoritesOnly(false);
    setFromDate(''); setToDate(''); setMinHours(''); setPlace('All'); setClosingSoon(false);
  };

  return (
    <div className="stack-lg">
      {isStudent && (
        <div className="row-between row-wrap">
          <p className="lead">
            {listable.length} opportunit{listable.length === 1 ? 'y' : 'ies'} posted ·{' '}
            <span className="strong">{formatHours(currentUser?.volunteeredHours || 0)}</span> credited to you so far
          </p>
        </div>
      )}

      {/* Suggestions come before the firehose — they're the shortest path to a
          good match for a student who doesn't know where to start. */}
      {recommended.length > 0 && (
        <section>
          <div className="section-head">
            <h2 className="row" style={{ gap: 6 }}>
              <Sparkles size={15} style={{ color: 'var(--brand)' }} /> {hasMatches ? 'Suggested for you' : 'Upcoming opportunities'}
            </h2>
          </div>
          <div className="grid grid-3">
            {recommended.map(event => (
              <button key={event.id} className="card card-link card-pad" onClick={() => onViewDetails(event)}>
                <div className="eyebrow">{event.category}</div>
                <div className="strong" style={{ marginTop: 4 }}>{event.title}</div>
                <div className="small muted" style={{ marginTop: 2 }}>
                  {event.spotsRemaining} of {event.maxSpots} spots open · {event.applicantCount} applied ·{' '}
                  up to {formatHours(event.hoursAwarded)}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="toolbar">
          <div className="input-affix">
            <Search size={15} />
            <input
              type="search"
              className="input"
              placeholder="Search events, places, organizers…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Search opportunities"
            />
          </div>

          <label className="row small" style={{ gap: 6 }}>
            <SlidersHorizontal size={14} style={{ color: 'var(--ink-3)' }} />
            <span className="dim nowrap">Sort</span>
            <select className="select" value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort by">
              <option value="soonest">Starting soonest</option>
              <option value="deadline">Closing soonest</option>
              <option value="spots">Most spots open</option>
              <option value="hours">Most hours</option>
              <option value="alpha">A–Z</option>
            </select>
          </label>

          <label className="check" style={{ padding: '0.375rem 0.625rem', border: 'none' }}>
            <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />
            <span className="small nowrap">Open only</span>
          </label>

          {isStudent && (
            <label className="check" style={{ padding: '0.375rem 0.625rem', border: 'none' }}>
              <input type="checkbox" checked={showFavoritesOnly} onChange={e => setShowFavoritesOnly(e.target.checked)} />
              <span className="small nowrap row" style={{ gap: 4 }}>
                <Star size={12} fill={showFavoritesOnly ? 'var(--accent)' : 'none'} style={{ color: showFavoritesOnly ? 'var(--accent)' : 'inherit' }} />
                Starred only
              </span>
            </label>
          )}
        </div>

        <div className="row row-wrap" style={{ marginBottom: 'var(--s4)', gap: 'var(--s3)' }}>
          <div className="chips">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                className="chip"
                aria-pressed={category === cat}
                onClick={() => setCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          <button
            className="btn btn-secondary btn-sm"
            style={{ marginLeft: 'auto' }}
            aria-expanded={showFilters}
            onClick={() => setShowFilters(v => !v)}
          >
            <Filter size={13} /> More filters
            {advancedCount > 0 && <span className="tag tag-brand">{advancedCount}</span>}
          </button>
        </div>

        {showFilters && (
          <div className="card card-pad" style={{ marginBottom: 'var(--s5)' }}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--s4)' }}>
              <div className="field" style={{ marginTop: 0 }}>
                <label htmlFor="f-from">Happening from</label>
                <input id="f-from" type="date" className="input" value={fromDate}
                  onChange={e => setFromDate(e.target.value)} />
              </div>
              <div className="field" style={{ marginTop: 0 }}>
                <label htmlFor="f-to">Up until</label>
                <input id="f-to" type="date" className="input" value={toDate}
                  onChange={e => setToDate(e.target.value)} />
              </div>
              <div className="field" style={{ marginTop: 0 }}>
                <label htmlFor="f-hours">Awards at least</label>
                <select id="f-hours" className="select" value={minHours}
                  onChange={e => setMinHours(e.target.value)}>
                  <option value="">Any number of hours</option>
                  <option value="2">2 hours or more</option>
                  <option value="4">4 hours or more</option>
                  <option value="8">8 hours or more</option>
                </select>
              </div>
              <div className="field" style={{ marginTop: 0 }}>
                <label htmlFor="f-place">Location</label>
                <select id="f-place" className="select" value={place}
                  onChange={e => setPlace(e.target.value)}>
                  {places.map(p => (
                    <option key={p} value={p}>{p === 'All' ? 'Anywhere' : p}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="row-between row-wrap" style={{ marginTop: 'var(--s4)', gap: 'var(--s3)' }}>
              <label className="check" style={{ border: 'none', padding: '0.375rem 0' }}>
                <input type="checkbox" checked={closingSoon}
                  onChange={e => setClosingSoon(e.target.checked)} />
                <span>
                  <span className="check-title">Closing within a week</span>
                  <span className="check-desc">Apply before these deadlines pass</span>
                </span>
              </label>

              {advancedCount > 0 && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setFromDate(''); setToDate(''); setMinHours('');
                    setPlace('All'); setClosingSoon(false);
                  }}
                >
                  <X size={13} /> Reset these
                </button>
              )}
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <EmptyState
            icon={<CalendarX2 size={18} />}
            title={hasFilters ? 'No events match those filters' : 'No opportunities posted yet'}
            message={
              hasFilters
                ? 'Try a broader search, or clear the filters to see everything that\'s been posted.'
                : 'When an organizer posts a sign-up sheet, it will appear here.'
            }
            action={
              hasFilters && (
                <button className="btn btn-secondary btn-sm" onClick={clearFilters}>Clear filters</button>
              )
            }
          />
        ) : (
          <>
            <p className="small dim" style={{ marginBottom: 'var(--s3)' }}>
              {filtered.length} event{filtered.length !== 1 ? 's' : ''}
            </p>
            <div className="eventgrid">
              {filtered.map(event => (
                <EventCard
                  key={event.id}
                  event={event}
                  currentUser={currentUser}
                  applications={applications}
                  onViewDetails={onViewDetails}
                  isFavorited={favorites.includes(event.id)}
                  onToggleFavorite={onToggleFavorite}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
