import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { api } from '../../utils/api';
import LocationSearch from './LocationSearch';
import LocationResults from './LocationResults';
import MapPreview from './MapPreview';
import WeatherSummary from './WeatherSummary';
import { useLocationContext } from '../../contexts/LocationContext';
import { useDebounce } from '../../hooks/useDebounce';
import './LocationPicker.css';

const LISTBOX_ID = 'location-results-listbox';

/**
 * Organizer-facing location picker. Replaces the plain text input.
 *
 * Searches via the server-side geocode proxy, shows results in a dropdown,
 * and renders a map preview upon selection. The organizer can clear the
 * selection and search again.
 * Enhanced LocationPicker that uses Nominatim geocoding via the backend proxy.
 * Returns a rich object: { location, address, latitude, longitude }
 */
export default function LocationPicker({ value, onChange, datetime, error }) {
  const [query, setQuery] = useState(typeof value === 'string' ? value : value?.location || '');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [showResults, setShowResults] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef(null);

  // Derive selected state based on the current value.
  const selected = value && typeof value === 'object' && value.latitude != null;

  // Sync internal query if value changes from outside
  useEffect(() => {
    if (!selected) {
      setQuery(typeof value === 'string' ? value : value?.location || '');
    }
  }, [value, selected]);

  /* Used to bias address search toward the organizer's own area; see doSearch. */
  const { location: myLocation } = useLocationContext() ?? {};

  const doSearch = useCallback(async (searchQuery) => {
    if (!searchQuery?.trim() || searchQuery.trim().length < 2) {
      setResults([]);
      setShowResults(false);
      return;
    }
    
    setLoading(true);
    setSearchError(null);
    setShowResults(true);
    
    try {
      /**
       * Bias the search toward wherever the organizer is.
       *
       * The server has applied a ~35 mile viewbox around a supplied position
       * since it was written, and the client has never sent one — so the bias
       * was unreachable code and "Reichler Park" could return the one three
       * states away. This is the wire.
       *
       * One decimal place, about 11km. The viewbox is half a degree wide, so a
       * finer figure changes nothing about the results while making every
       * organizer's cache key unique — and a shared key is what keeps the
       * upstream request count down.
       */
      const near = myLocation
        ? { lat: Math.round(myLocation.latitude * 10) / 10, lon: Math.round(myLocation.longitude * 10) / 10 }
        : undefined;
      const data = await api.geocodeSearch(searchQuery, undefined, near);
      setResults(data.results || []);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setSearchError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [myLocation]);

  const debouncedSearch = useDebounce(doSearch, 400);

  // Close results when clicking outside
  useEffect(() => {
    const handleGlobalClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handleGlobalClick);
    return () => document.removeEventListener('mousedown', handleGlobalClick);
  }, []);

  const handleSelect = (item) => {
    // Return structured object to the parent
    onChange({
      location: item.displayName,
      address: item.address,
      latitude: item.latitude,
      longitude: item.longitude
    });
    setQuery(item.displayName);
    setShowResults(false);
  };

  const handleClear = () => {
    onChange('');
    setQuery('');
    setResults([]);
    setShowResults(false);
  };

  const handleKeyDown = (e) => {
    if (!showResults) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIndex(prev => Math.min(prev + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIndex(prev => Math.max(prev - 1, -1));
        break;
      case 'Enter':
        if (highlightIndex >= 0 && results[highlightIndex]) {
          e.preventDefault();
          handleSelect(results[highlightIndex]);
        }
        break;
      case 'Escape':
        setShowResults(false);
        break;
    }
  };

  const handleQueryChange = useCallback((v) => {
    setQuery(v);
    // Keep the location field in sync for plain-text fallback
    if (!selected) {
      onChange(typeof value === 'object' ? { ...value, location: v } : v);
    }
    debouncedSearch(v);
  }, [onChange, value, selected, debouncedSearch]);

  if (selected) {
    const loc = value;
    return (
      <div className="location-picker" ref={containerRef}>
        <div className="location-selected">
          <div className="location-selected-header">
            <div className="location-selected-info">
              <span className="location-selected-name">{loc.location}</span>
              {loc.address && <span className="location-selected-address">{loc.address}</span>}
              <WeatherSummary latitude={loc.latitude} longitude={loc.longitude} datetime={datetime} />
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleClear}
              aria-label="Remove location"
            >
              <X size={14} /> Change
            </button>
          </div>
          <MapPreview
            latitude={loc.latitude}
            longitude={loc.longitude}
            label={loc.location}
            height={160}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="location-picker" ref={containerRef}>
      <LocationSearch
        value={query}
        onChange={handleQueryChange}
        onSearch={doSearch}
        onFocus={() => results?.length && setShowResults(true)}
        onKeyDown={handleKeyDown}
        expanded={showResults}
        activedescendant={highlightIndex >= 0 ? `location-opt-${highlightIndex}` : null}
        listboxId={LISTBOX_ID}
      />
      {showResults && (
        <LocationResults
          results={results}
          loading={loading}
          error={searchError}
          highlightIndex={highlightIndex}
          onSelect={handleSelect}
          listboxId={LISTBOX_ID}
        />
      )}
      {error && (
        <span className="field-error">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          {error}
        </span>
      )}
    </div>
  );
}
