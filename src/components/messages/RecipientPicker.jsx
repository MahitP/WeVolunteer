import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { Search, User } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';

/**
 * Pick who to start a conversation with.
 *
 * ── What was wrong ──
 *
 * This was a hand-rolled overlay with no dialog behaviour at all: no
 * `role="dialog"`, no `aria-modal`, no Escape, no focus containment, no focus
 * restore, no scroll lock. Its close button asked for `.icon-btn`, which has no
 * rule anywhere in index.css (the app's class is `.btn-icon`), so it rendered as
 * unstyled browser chrome.
 *
 * The serious part was the results list. Each row was a `<div onClick>`: not
 * focusable, not reachable by Tab, and not activatable by Enter or Space. So
 * starting a conversation — the entire purpose of this dialog — was
 * mouse-only. A keyboard or switch-access user could open the dialog, type a
 * search, see results, and have no way to choose one.
 *
 * Rows are real `<button type="button">`s now, which brings focus, Enter and
 * Space for free, and the dialog goes through the shared `Modal` shell like
 * every other one.
 *
 * The list styling stays inline: these are one-off rows, and moving them to
 * index.css would be unrelated churn.
 */
export default function RecipientPicker({ onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.searchMessagesUsers(query);
        setResults(data.users || []);
      } catch (err) {
        // Previously console.error only, so a failed search looked identical to
        // "nobody matched" — the user retyped instead of retrying.
        setError(err.message || 'Could not search right now.');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [query]);

  const searched = query.length >= 2;

  return (
    <Modal onClose={onClose} label="New message" className="recipient-picker">
      <ModalHead
        title="New message"
        description="You can message the organizer of an event you have applied to."
        onClose={onClose}
      />

      <div className="modal-body">
        <div className="recipient-search">
          <Search size={18} className="recipient-search-icon" aria-hidden="true" />
          <label className="sr-only" htmlFor="recipient-search">
            Search for a volunteer or organizer
          </label>
          <input
            id="recipient-search"
            type="text"
            className="input recipient-search-input"
            placeholder="Search for a volunteer or organizer…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        {/* role="status" so the result count, the empty state and a failure are
            announced. Previously these were silent text swaps. */}
        <div className="recipient-results" role="status" aria-live="polite">
          {loading && <p className="small dim recipient-note">Searching…</p>}

          {!loading && error && <p className="small recipient-note recipient-error">{error}</p>}

          {!loading && !error && searched && results.length === 0 && (
            <p className="small dim recipient-note">No one found for “{query}”.</p>
          )}

          {!loading && !error && results.map((u) => (
            <button
              key={`${u.id}-${u.eventId}`}
              type="button"
              data-recipient={u.id}
              className="recipient-row"
              onClick={() => onSelect(u)}
              aria-label={`Message ${u.name} about ${u.eventTitle}`}
            >
              <span className="recipient-avatar" aria-hidden="true">
                {u.avatar ? u.avatar : <User size={20} />}
              </span>
              <span className="recipient-detail">
                <span className="recipient-name">
                  {u.name} <span className="recipient-username">@{u.username}</span>
                </span>
                <span className="small dim">{u.eventTitle}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
