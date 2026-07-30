import React, { useRef, useEffect, useCallback } from 'react';
import { MapPin } from 'lucide-react';

const DEBOUNCE_MS = 700;

/**
 * Search input for locations with built-in debounce.
 * Follows the existing .input-affix pattern from the design system.
 */
export default function LocationSearch({
  value,
  onChange,
  onSearch,
  onFocus,
  onKeyDown,
  placeholder = 'Search for a place...',
  expanded = false,
  activedescendant,
  listboxId
}) {
  const timerRef = useRef(null);
  const inputRef = useRef(null);

  const handleChange = useCallback((e) => {
    const v = e.target.value;
    onChange(v);

    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = v.trim();
    if (trimmed.length < 2) return;

    timerRef.current = setTimeout(() => {
      onSearch(trimmed);
    }, DEBOUNCE_MS);
  }, [onChange, onSearch]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="input-affix">
      <MapPin size={15} />
      <input
        ref={inputRef}
        className="input"
        type="text"
        value={value}
        onChange={handleChange}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-activedescendant={activedescendant || undefined}
        aria-autocomplete="list"
        aria-label="Search for a location"
        autoComplete="off"
      />
    </div>
  );
}
