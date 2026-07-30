import React from 'react';
import { MapPin, AlertCircle, SearchX } from 'lucide-react';

/**
 * Dropdown list of geocode search results.
 * ARIA listbox with keyboard navigation support.
 */
export default function LocationResults({
  results,
  loading,
  error,
  highlightIndex,
  onSelect,
  listboxId
}) {
  if (loading) {
    return (
      <ul className="location-results" id={listboxId} role="listbox">
        <li className="location-results-status">
          <span className="location-spinner" />
          <span style={{ marginTop: 4, display: 'block' }}>Searching...</span>
        </li>
      </ul>
    );
  }

  if (error) {
    return (
      <ul className="location-results" id={listboxId} role="listbox">
        <li className="location-results-status">
          <AlertCircle size={20} />
          {error}
        </li>
      </ul>
    );
  }

  if (results && results.length === 0) {
    return (
      <ul className="location-results" id={listboxId} role="listbox">
        <li className="location-results-status">
          <SearchX size={20} />
          No places found. Try a different search.
        </li>
      </ul>
    );
  }

  if (!results || results.length === 0) return null;

  return (
    <ul className="location-results" id={listboxId} role="listbox">
      {results.map((r, i) => (
        <li
          key={`${r.latitude}-${r.longitude}-${i}`}
          id={`location-opt-${i}`}
          role="option"
          aria-selected={i === highlightIndex}
          className="location-result"
          onClick={() => onSelect(r)}
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className="location-result-name">
            <MapPin size={12} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            {r.displayName}
          </span>
          <span className="location-result-address">{r.address}</span>
        </li>
      ))}
    </ul>
  );
}
